import { describe, expect, it } from "vitest";

import {
  EventPlanSchema,
  EventPlanningInputSchema,
  GroupPlanningInputSchema,
  ParticipantFoodSignalsSchema,
  UserFoodContextSchema,
} from "./schemas";

const validInput = {
  event: {
    id: "event-1",
    title: "Вечеря",
    startsAt: "2026-09-12T18:00:00.000Z",
    locale: "uk-UA",
  },
  host: { participantId: "participant-1", displayName: "Олена" },
  budget: { amount: 1800, currency: "UAH" },
  participants: [
    {
      id: "participant-1",
      displayName: "Олена",
      preferences: {
        allergies: [{ id: "allergy-peanut", label: "Арахіс" }],
        dietaryRestrictions: [],
        likes: ["овочі"],
        dislikes: [],
        cuisines: ["українська"],
      },
      foodIntent: { kind: "dish", dishName: "Запечені овочі" },
      contextCompleteness: "partial",
    },
  ],
};

describe("EventPlanningInputSchema", () => {
  it("accepts a complete backend-owned event context", () => {
    expect(EventPlanningInputSchema.parse(validInput)).toEqual(validInput);
  });

  it("accepts an event without a shared budget", () => {
    expect(EventPlanningInputSchema.parse({ ...validInput, budget: null }).budget).toBeNull();
  });

  it("rejects duplicate participant IDs", () => {
    const result = EventPlanningInputSchema.safeParse({
      ...validInput,
      participants: [validInput.participants[0], validInput.participants[0]],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a host who is not an event participant", () => {
    const result = EventPlanningInputSchema.safeParse({
      ...validInput,
      host: { participantId: "participant-404", displayName: "Невідомий" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed recipe URLs", () => {
    const result = EventPlanningInputSchema.safeParse({
      ...validInput,
      participants: [
        {
          ...validInput.participants[0],
          foodIntent: { kind: "recipe", recipeUrl: "not-a-url" },
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("EventPlanSchema", () => {
  it("rejects non-positive servings", () => {
    const result = EventPlanSchema.safeParse({
      status: "ready",
      dishes: [
        {
          id: "dish-1",
          name: "Овочі",
          eaterParticipantIds: ["participant-1"],
          servings: 0,
          ingredients: [{ name: "Кабачок" }],
          reasoningSummary: "Враховує побажання учасника.",
        },
      ],
      conflicts: [],
      proposedResolutions: [],
      hardConstraintChecks: [],
      reasoningSummary: "Одна спільна страва.",
    });

    expect(result.success).toBe(false);
  });
});

const normalizedContext = {
  participantId: "participant-1",
  hardConstraints: [
    {
      id: "declared:allergy-peanut",
      kind: "allergy",
      label: "Арахіс",
      source: "declared",
      evidenceIds: ["declared:allergy-peanut"],
    },
  ],
  softPreferences: [],
  dislikes: [],
  usefulPatterns: [],
  missingInformation: [],
  completeness: "complete",
  evidence: [
    { id: "declared:allergy-peanut", source: "declared" },
  ],
  summary: "Алергія на арахіс.",
};

describe("participant preprocessing schemas", () => {
  it("rejects unknown keys at the normalized boundary", () => {
    expect(
      UserFoodContextSchema.safeParse({
        ...normalizedContext,
        rawMcpResponse: { secret: true },
      }).success,
    ).toBe(false);
  });

  it("bounds ambiguous MCP fragments", () => {
    const result = ParticipantFoodSignalsSchema.safeParse({
      participantId: "participant-1",
      restrictions: [],
      favorites: [],
      ambiguousFragments: ["x".repeat(501)],
      evidence: [],
      completeness: "partial",
    });

    expect(result.success).toBe(false);
  });
});

describe("GroupPlanningInputSchema", () => {
  it("accepts only a matching normalized context per participant", () => {
    const result = GroupPlanningInputSchema.safeParse({
      ...validInput,
      participants: [
        {
          id: "participant-1",
          displayName: "Олена",
          foodIntent: validInput.participants[0].foodIntent,
          contextStatus: "loaded",
          foodContext: normalizedContext,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a context belonging to another participant", () => {
    const result = GroupPlanningInputSchema.safeParse({
      ...validInput,
      participants: [
        {
          id: "participant-1",
          displayName: "Олена",
          foodIntent: validInput.participants[0].foodIntent,
          contextStatus: "loaded",
          foodContext: { ...normalizedContext, participantId: "participant-2" },
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
