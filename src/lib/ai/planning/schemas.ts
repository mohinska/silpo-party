import { z } from "zod";

const NonEmptyText = z.string().trim().min(1);
const OpaqueId = NonEmptyText.max(200);

export const AllergySchema = z
  .object({
    id: OpaqueId,
    label: NonEmptyText,
    details: NonEmptyText.optional(),
  })
  .strict();

export const DietaryRestrictionSchema = z
  .object({
    id: OpaqueId,
    label: NonEmptyText,
    strength: z.enum(["hard", "preference"]),
    details: NonEmptyText.optional(),
  })
  .strict();

export const ParticipantPreferencesSchema = z
  .object({
    allergies: z.array(AllergySchema),
    dietaryRestrictions: z.array(DietaryRestrictionSchema),
    likes: z.array(NonEmptyText),
    dislikes: z.array(NonEmptyText),
    cuisines: z.array(NonEmptyText),
    notes: NonEmptyText.optional(),
  })
  .strict();

export const FoodIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), notes: NonEmptyText.optional() }).strict(),
  z
    .object({
      kind: z.literal("dish"),
      dishName: NonEmptyText,
      recipeUrl: z.url().optional(),
      notes: NonEmptyText.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recipe"),
      recipeUrl: z.url(),
      recipeText: NonEmptyText.optional(),
      requestedDishName: NonEmptyText.optional(),
      notes: NonEmptyText.optional(),
    })
    .strict(),
]);

export const PersonalSilpoContextSchema = z
  .object({
    source: z.literal("silpo_mcp"),
    profileFacts: z.array(
      z.object({ label: NonEmptyText, value: NonEmptyText }).strict(),
    ),
    foodRestrictions: z.array(
      z
        .object({
          label: NonEmptyText,
          details: NonEmptyText.optional(),
        })
        .strict(),
    ),
    favorites: z.array(
      z
        .object({
          name: NonEmptyText,
          category: NonEmptyText.optional(),
        })
        .strict(),
    ),
    additionalNotes: z.array(NonEmptyText),
    fetchedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const EventParticipantSchema = z
  .object({
    id: OpaqueId,
    displayName: NonEmptyText,
    preferences: ParticipantPreferencesSchema,
    foodIntent: FoodIntentSchema,
    contextCompleteness: z.enum(["complete", "partial", "unknown"]),
    silpoContext: PersonalSilpoContextSchema.optional(),
  })
  .strict();

export const EventPlanningInputSchema = z
  .object({
    event: z
      .object({
        id: OpaqueId,
        title: NonEmptyText,
        description: NonEmptyText.optional(),
        startsAt: z.iso.datetime({ offset: true }),
        locale: NonEmptyText,
        mealNotes: NonEmptyText.optional(),
      })
      .strict(),
    host: z
      .object({
        participantId: OpaqueId,
        displayName: NonEmptyText,
      })
      .strict(),
    budget: z
      .object({
        amount: z.number().finite().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    participants: z.array(EventParticipantSchema).min(1),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.participants.map((participant) => participant.id);
    const uniqueIds = new Set(ids);

    if (uniqueIds.size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "Participant IDs must be unique.",
      });
    }

    if (!uniqueIds.has(input.host.participantId)) {
      context.addIssue({
        code: "custom",
        path: ["host", "participantId"],
        message: "Host must be included in participants.",
      });
    }
  });

export const PlanIngredientSchema = z
  .object({
    name: NonEmptyText,
    amountText: NonEmptyText.optional(),
    notes: NonEmptyText.optional(),
  })
  .strict();

export const PlannedDishSchema = z
  .object({
    id: OpaqueId,
    name: NonEmptyText,
    requestedByParticipantIds: z.array(OpaqueId).optional(),
    eaterParticipantIds: z.array(OpaqueId).min(1),
    servings: z.number().int().positive(),
    ingredients: z.array(PlanIngredientSchema).min(1),
    reasoningSummary: NonEmptyText.max(400),
  })
  .strict();

export const PlanConflictSchema = z
  .object({
    id: OpaqueId,
    kind: z.enum([
      "hard_restriction",
      "preference",
      "budget",
      "missing_context",
      "dish_intent",
      "other",
    ]),
    severity: z.enum(["blocking", "warning"]),
    participantIds: z.array(OpaqueId),
    dishIds: z.array(OpaqueId),
    description: NonEmptyText,
    status: z.enum(["unresolved", "resolved", "needs_input"]),
  })
  .strict();

export const ProposedResolutionSchema = z
  .object({
    id: OpaqueId,
    conflictId: OpaqueId,
    title: NonEmptyText,
    description: NonEmptyText,
    affectedParticipantIds: z.array(OpaqueId),
    affectedDishIds: z.array(OpaqueId),
    requiresHostApproval: z.boolean(),
    requiresParticipantInput: z.boolean(),
  })
  .strict();

export const HardConstraintCheckSchema = z
  .object({
    dishId: OpaqueId,
    participantId: OpaqueId,
    constraintId: OpaqueId,
    constraintKind: z.enum(["allergy", "hard_restriction"]),
    status: z.enum(["safe", "uncertain", "conflict"]),
    explanation: NonEmptyText,
  })
  .strict();

const DiscoveredConstraintSchema = z
  .object({
    id: OpaqueId,
    label: NonEmptyText,
    details: NonEmptyText.optional(),
    source: z.enum(["declared", "silpo"]),
  })
  .strict();

export const ParticipantInsightSchema = z
  .object({
    participantId: OpaqueId,
    contextStatus: z.enum(["provided", "loaded", "unavailable", "not_requested"]),
    allergies: z.array(DiscoveredConstraintSchema),
    hardRestrictions: z.array(DiscoveredConstraintSchema),
    preferences: z.array(NonEmptyText),
    summary: NonEmptyText.max(400),
  })
  .strict();

export const EventPlanSchema = z
  .object({
    status: z.enum(["ready", "needs_input", "blocked"]),
    participantInsights: z.array(ParticipantInsightSchema),
    dishes: z.array(PlannedDishSchema),
    conflicts: z.array(PlanConflictSchema),
    proposedResolutions: z.array(ProposedResolutionSchema),
    hardConstraintChecks: z.array(HardConstraintCheckSchema),
    reasoningSummary: NonEmptyText.max(600),
  })
  .strict();

export type EventPlanningInput = z.infer<typeof EventPlanningInputSchema>;
export type EventParticipant = z.infer<typeof EventParticipantSchema>;
export type PersonalSilpoContext = z.infer<typeof PersonalSilpoContextSchema>;
export type EventPlan = z.infer<typeof EventPlanSchema>;
export type HardConstraintCheck = z.infer<typeof HardConstraintCheckSchema>;
