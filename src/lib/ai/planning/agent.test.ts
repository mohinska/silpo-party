import { describe, expect, it } from "vitest";

import { planEvent } from "./agent";
import { PlanningSafetyError } from "./errors";
import type { EventPlan } from "./schemas";

const validInput = {
  event: {
    id: "event-1",
    title: "Тестова вечеря",
    startsAt: "2026-09-12T18:00:00.000Z",
    locale: "uk-UA",
  },
  host: { participantId: "p1", displayName: "Олена" },
  budget: { amount: 900, currency: "UAH" },
  participants: [
    {
      id: "p1",
      displayName: "Олена",
      preferences: {
        allergies: [{ id: "allergy:peanut", label: "Арахіс" }],
        dietaryRestrictions: [],
        likes: [],
        dislikes: [],
        cuisines: [],
      },
      foodIntent: { kind: "dish", dishName: "Овочеве рагу" },
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
      hardRestrictions: [],
      preferences: [],
      summary: "Контекст Сільпо отримано.",
    },
  ],
  dishes: [
    {
      id: "dish-1",
      name: "Овочеве рагу",
      eaterParticipantIds: ["p1"],
      servings: 1,
      ingredients: [{ name: "Кабачок" }],
      reasoningSummary: "Без арахісу.",
    },
  ],
  conflicts: [],
  proposedResolutions: [],
  hardConstraintChecks: [
    {
      dishId: "dish-1",
      participantId: "p1",
      constraintId: "allergy:peanut",
      constraintKind: "allergy",
      status: "safe",
      explanation: "Арахіс відсутній.",
    },
  ],
  reasoningSummary: "Один глобальний план для тестової події.",
};

describe("planEvent", () => {
  it("validates input before invoking model generation", async () => {
    let generationCalls = 0;

    await expect(
      planEvent(
        { ...validInput, participants: [] },
        {
          loadParticipantContext: async () => ({ status: "available", data: {} }),
          generatePlan: async () => {
            generationCalls += 1;
            return safePlan;
          },
        },
      ),
    ).rejects.toThrow();

    expect(generationCalls).toBe(0);
  });

  it("returns the safe structured plan and exact redacted context trace", async () => {
    const result = await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "available",
        data: { favorite: "овочі", accessToken: "hidden" },
      }),
      generatePlan: async ({ contextAccess }) => {
        await contextAccess.execute({ participantId: "p1" });
        return safePlan;
      },
    });

    expect(result.plan).toEqual(safePlan);
    expect(result.contextTrace).toEqual([
      {
        participantId: "p1",
        status: "available",
        data: { favorite: "овочі", accessToken: "[REDACTED]" },
      },
    ]);
  });

  it("rejects output when Gemini skipped required context collection", async () => {
    await expect(
      planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        generatePlan: async () => safePlan,
      }),
    ).rejects.toThrow(/did not request Silpo context/i);
  });

  it("rejects a structured plan with an unsafe eater assignment", async () => {
    await expect(
      planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        generatePlan: async ({ contextAccess }) => {
          await contextAccess.execute({ participantId: "p1" });
          return {
            ...safePlan,
            hardConstraintChecks: [
              { ...safePlan.hardConstraintChecks[0], status: "conflict" },
            ],
          };
        },
      }),
    ).rejects.toBeInstanceOf(PlanningSafetyError);
  });
});
