import { PlanningSafetyError, type PlanningSafetyIssue } from "./errors";
import type {
  EventPlan,
  EventPlanningInput,
  GroupPlanningInput,
} from "./schemas";

type RequiredConstraint = {
  id: string;
  kind: "allergy" | "hard_restriction";
};

function pushDuplicateIssues(
  values: string[],
  label: string,
  issues: PlanningSafetyIssue[],
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push({
        code: "duplicate_id",
        message: `Duplicate ${label}: ${value}.`,
      });
    }
    seen.add(value);
  }
}

export function assertEventPlanSafety(
  input: EventPlanningInput | GroupPlanningInput,
  plan: EventPlan,
): void {
  const issues: PlanningSafetyIssue[] = [];
  const participantIds = new Set(input.participants.map(({ id }) => id));
  const dishIds = new Set(plan.dishes.map(({ id }) => id));
  const conflictIds = new Set(plan.conflicts.map(({ id }) => id));

  pushDuplicateIssues(plan.dishes.map(({ id }) => id), "dish ID", issues);
  pushDuplicateIssues(plan.conflicts.map(({ id }) => id), "conflict ID", issues);
  pushDuplicateIssues(
    plan.proposedResolutions.map(({ id }) => id),
    "resolution ID",
    issues,
  );
  pushDuplicateIssues(
    plan.participantInsights.map(({ participantId }) => participantId),
    "participant insight",
    issues,
  );

  const insightByParticipant = new Map(
    plan.participantInsights.map((insight) => [insight.participantId, insight]),
  );

  for (const insight of plan.participantInsights) {
    if (!participantIds.has(insight.participantId)) {
      issues.push({
        code: "invalid_reference",
        message: `Participant insight references unknown participant ${insight.participantId}.`,
        participantId: insight.participantId,
      });
    }
  }

  for (const participant of input.participants) {
    if (!insightByParticipant.has(participant.id)) {
      issues.push({
        code: "missing_context",
        message: `Missing participant insight for ${participant.id}.`,
        participantId: participant.id,
      });
    }
  }

  for (const dish of plan.dishes) {
    pushDuplicateIssues(dish.eaterParticipantIds, `eater in dish ${dish.id}`, issues);

    if (dish.servings < dish.eaterParticipantIds.length) {
      issues.push({
        code: "insufficient_servings",
        message: `Dish ${dish.id} has fewer servings than eaters.`,
        dishId: dish.id,
      });
    }

    for (const participantId of [
      ...dish.eaterParticipantIds,
      ...(dish.requestedByParticipantIds ?? []),
    ]) {
      if (!participantIds.has(participantId)) {
        issues.push({
          code: "invalid_reference",
          message: `Dish ${dish.id} references unknown participant ${participantId}.`,
          participantId,
          dishId: dish.id,
        });
      }
    }
  }

  for (const participant of (plan.status === "ready" ? input.participants : []).filter(({ foodIntent }) => foodIntent.kind !== "none")) {
    const requested = plan.dishes.filter((dish) => dish.requestedByParticipantIds?.includes(participant.id));
    if (requested.length !== 1 || requested[0]?.requestedByParticipantIds?.length !== 1) {
      issues.push({ code: "dish_intent", message: `Explicit request from ${participant.id} must remain one separate dish.`, participantId: participant.id });
    }
  }

  for (const conflict of plan.conflicts) {
    for (const participantId of conflict.participantIds) {
      if (!participantIds.has(participantId)) {
        issues.push({
          code: "invalid_reference",
          message: `Conflict ${conflict.id} references unknown participant ${participantId}.`,
          participantId,
        });
      }
    }
    for (const dishId of conflict.dishIds) {
      if (!dishIds.has(dishId)) {
        issues.push({
          code: "invalid_reference",
          message: `Conflict ${conflict.id} references unknown dish ${dishId}.`,
          dishId,
        });
      }
    }
  }

  for (const resolution of plan.proposedResolutions) {
    if (!conflictIds.has(resolution.conflictId)) {
      issues.push({
        code: "invalid_reference",
        message: `Resolution ${resolution.id} references unknown conflict ${resolution.conflictId}.`,
      });
    }
    for (const participantId of resolution.affectedParticipantIds) {
      if (!participantIds.has(participantId)) {
        issues.push({
          code: "invalid_reference",
          message: `Resolution ${resolution.id} references unknown participant ${participantId}.`,
          participantId,
        });
      }
    }
    for (const dishId of resolution.affectedDishIds) {
      if (!dishIds.has(dishId)) {
        issues.push({
          code: "invalid_reference",
          message: `Resolution ${resolution.id} references unknown dish ${dishId}.`,
          dishId,
        });
      }
    }
  }

  const constraintsByParticipant = new Map<string, Map<string, RequiredConstraint>>();
  for (const participant of input.participants) {
    const constraints = new Map<string, RequiredConstraint>();
    if ("foodContext" in participant) {
      for (const constraint of participant.foodContext.hardConstraints) {
        constraints.set(constraint.id, {
          id: constraint.id,
          kind: constraint.kind,
        });
      }
    } else {
      for (const allergy of participant.preferences.allergies) {
        constraints.set(allergy.id, { id: allergy.id, kind: "allergy" });
      }
      for (const restriction of participant.preferences.dietaryRestrictions) {
        if (restriction.strength === "hard") {
          constraints.set(restriction.id, {
            id: restriction.id,
            kind: "hard_restriction",
          });
        }
      }
    }

    const insight = insightByParticipant.get(participant.id);
    if (insight) {
      for (const allergy of insight.allergies) {
        constraints.set(allergy.id, { id: allergy.id, kind: "allergy" });
      }
      for (const restriction of insight.hardRestrictions) {
        constraints.set(restriction.id, {
          id: restriction.id,
          kind: "hard_restriction",
        });
      }
    }
    constraintsByParticipant.set(participant.id, constraints);
  }

  const checks = new Map<string, (typeof plan.hardConstraintChecks)[number]>();
  for (const check of plan.hardConstraintChecks) {
    const key = `${check.dishId}\u0000${check.participantId}\u0000${check.constraintId}`;
    if (checks.has(key)) {
      issues.push({
        code: "duplicate_id",
        message: `Duplicate hard-constraint check for ${check.constraintId}.`,
        participantId: check.participantId,
        dishId: check.dishId,
        constraintId: check.constraintId,
      });
    }
    checks.set(key, check);

    const dish = plan.dishes.find(({ id }) => id === check.dishId);
    if (!dish || !dish.eaterParticipantIds.includes(check.participantId)) {
      issues.push({
        code: "invalid_reference",
        message: `Hard-constraint check must reference an assigned eater and dish.`,
        participantId: check.participantId,
        dishId: check.dishId,
        constraintId: check.constraintId,
      });
    }

    const expected = constraintsByParticipant
      .get(check.participantId)
      ?.get(check.constraintId);
    if (!expected || expected.kind !== check.constraintKind) {
      issues.push({
        code: "constraint_mismatch",
        message: `Check ${check.constraintId} does not match a known hard constraint.`,
        participantId: check.participantId,
        dishId: check.dishId,
        constraintId: check.constraintId,
      });
    }
  }

  for (const dish of plan.dishes) {
    for (const participantId of dish.eaterParticipantIds) {
      const participant = input.participants.find(({ id }) => id === participantId);
      const insight = insightByParticipant.get(participantId);
      if (
        participant &&
        ("foodContext" in participant
          ? participant.foodContext.completeness !== "complete"
          : participant.contextCompleteness !== "complete") &&
        insight &&
        !["loaded", "provided"].includes(insight.contextStatus)
      ) {
        issues.push({
          code: "missing_context",
          message: `Participant ${participantId} has incomplete food context and cannot be assigned safely.`,
          participantId,
          dishId: dish.id,
        });
      }

      for (const constraint of constraintsByParticipant.get(participantId)?.values() ?? []) {
        const key = `${dish.id}\u0000${participantId}\u0000${constraint.id}`;
        const check = checks.get(key);
        if (!check) {
          issues.push({
            code: "missing_check",
            message: `Missing safety check for constraint ${constraint.id} on dish ${dish.id}.`,
            participantId,
            dishId: dish.id,
            constraintId: constraint.id,
          });
        } else if (check.status !== "safe") {
          issues.push({
            code: "unsafe_check",
            message: `Constraint ${constraint.id} is not marked safe for dish ${dish.id}.`,
            participantId,
            dishId: dish.id,
            constraintId: constraint.id,
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new PlanningSafetyError(issues);
  }
}
