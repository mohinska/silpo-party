import { describe, expect, it } from "vitest";

import { PlanningSafetyError } from "./errors";
import { assertEventPlanSafety } from "./safety";
import type { EventPlan, EventPlanningInput } from "./schemas";

const input: EventPlanningInput = {
  event: {
    id: "event-1",
    title: "Вечеря",
    startsAt: "2026-09-12T18:00:00.000Z",
    locale: "uk-UA",
  },
  host: { participantId: "p1", displayName: "Олена" },
  budget: { amount: 1000, currency: "UAH" },
  participants: [
    {
      id: "p1",
      displayName: "Олена",
      preferences: {
        allergies: [{ id: "declared:peanut", label: "Арахіс" }],
        dietaryRestrictions: [],
        likes: [],
        dislikes: [],
        cuisines: [],
      },
      foodIntent: { kind: "none" },
      contextCompleteness: "partial",
    },
  ],
};

const safePlan: EventPlan = {
  status: "ready",
  participantInsights: [
    {
      participantId: "p1",
      contextStatus: "loaded",
      allergies: [],
      hardRestrictions: [
        {
          id: "silpo:lactose",
          label: "Без лактози",
          source: "silpo",
        },
      ],
      preferences: ["овочі"],
      summary: "Враховано заявлену алергію та дані Сільпо.",
    },
  ],
  dishes: [
    {
      id: "dish-1",
      name: "Овочеве рагу",
      eaterParticipantIds: ["p1"],
      servings: 1,
      ingredients: [{ name: "Кабачок" }],
      reasoningSummary: "Підходить учаснику.",
    },
  ],
  conflicts: [],
  proposedResolutions: [],
  hardConstraintChecks: [
    {
      dishId: "dish-1",
      participantId: "p1",
      constraintId: "declared:peanut",
      constraintKind: "allergy",
      status: "safe",
      explanation: "У списку інгредієнтів немає арахісу.",
    },
    {
      dishId: "dish-1",
      participantId: "p1",
      constraintId: "silpo:lactose",
      constraintKind: "hard_restriction",
      status: "safe",
      explanation: "Молочні продукти не використовуються.",
    },
  ],
  reasoningSummary: "План перевірено для всіх учасників.",
};

describe("assertEventPlanSafety", () => {
  it("accepts complete safe coverage for declared and Silpo constraints", () => {
    expect(() => assertEventPlanSafety(input, safePlan)).not.toThrow();
  });

  it("rejects a missing hard-constraint check", () => {
    const plan = {
      ...safePlan,
      hardConstraintChecks: safePlan.hardConstraintChecks.slice(0, 1),
    };

    expect(() => assertEventPlanSafety(input, plan)).toThrow(PlanningSafetyError);
  });

  it("rejects uncertain compatibility for an assigned eater", () => {
    const plan = {
      ...safePlan,
      hardConstraintChecks: safePlan.hardConstraintChecks.map((check) =>
        check.constraintId === "declared:peanut"
          ? { ...check, status: "uncertain" as const }
          : check,
      ),
    };

    expect(() => assertEventPlanSafety(input, plan)).toThrow(/not marked safe/i);
  });

  it("rejects foreign eater references and insufficient servings", () => {
    const plan = {
      ...safePlan,
      dishes: [
        {
          ...safePlan.dishes[0],
          eaterParticipantIds: ["p1", "p404"],
          servings: 1,
        },
      ],
    };

    expect(() => assertEventPlanSafety(input, plan)).toThrow(PlanningSafetyError);
  });

  it("rejects duplicate constraint checks", () => {
    const plan = {
      ...safePlan,
      hardConstraintChecks: [
        ...safePlan.hardConstraintChecks,
        safePlan.hardConstraintChecks[0],
      ],
    };

    expect(() => assertEventPlanSafety(input, plan)).toThrow(/duplicate/i);
  });
});
