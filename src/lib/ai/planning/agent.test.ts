import { describe, expect, it } from "vitest";

import { planEvent } from "./agent";
import { PlanningProviderError, PlanningSafetyError } from "./errors";
import type { EventPlan, GroupPlanningInput } from "./schemas";

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

  it("passes only normalized participant context to the group planner", async () => {
    let plannerInput: unknown;
    const result = await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "available",
        data: {
          silpo_get_my_favorites: {
            structuredContent: { items: [{ name: "Тофу" }] },
          },
          accessToken: "hidden",
        },
      }),
      generatePlan: async ({ input }) => {
        plannerInput = input;
        return safePlan;
      },
    });

    expect(result.plan).toEqual(safePlan);
    expect(JSON.stringify(plannerInput)).toContain("foodContext");
    expect(JSON.stringify(plannerInput)).not.toMatch(/accessToken|structuredContent/);
    expect(result.contextTrace[0]).toMatchObject({
      participantId: "p1",
      status: "available",
      favoriteCount: 1,
    });
  });

  it("represents unavailable MCP context explicitly in planner input", async () => {
    let contextStatus: string | undefined;
    await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "unavailable",
        reason: "not connected",
      }),
      generatePlan: async ({ input }) => {
        contextStatus = input.participants[0].foodContext.completeness;
        return {
          ...safePlan,
          status: "needs_input",
          participantInsights: [
            { ...safePlan.participantInsights[0], contextStatus: "unavailable" },
          ],
          dishes: [],
          hardConstraintChecks: [],
        };
      },
    });

    expect(contextStatus).not.toBe("complete");
  });

  it("rejects a structured plan with an unsafe eater assignment", async () => {
    await expect(
      planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        generatePlan: async () => {
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

  it("preprocesses at most three participants concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    const participants = Array.from({ length: 5 }, (_, index) => ({
      ...validInput.participants[0],
      id: `p${index + 1}`,
      displayName: `Учасник ${index + 1}`,
      preferences: {
        ...validInput.participants[0].preferences,
        allergies: [],
      },
    }));
    const input = {
      ...validInput,
      participants,
      host: { participantId: "p1", displayName: "Учасник 1" },
    };

    await planEvent(input, {
      loadParticipantContext: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: "available", data: {} };
      },
      generatePlan: async () => ({
        status: "ready",
        participantInsights: participants.map(({ id }) => ({
          participantId: id,
          contextStatus: "loaded",
          allergies: [],
          hardRestrictions: [],
          preferences: [],
          summary: "Контекст перевірено.",
        })),
        dishes: [
          {
            id: "dish-1",
            name: "Спільна страва",
            eaterParticipantIds: participants.map(({ id }) => id),
            servings: 5,
            ingredients: [{ name: "Овочі" }],
            reasoningSummary: "Підходить усім.",
          },
        ],
        conflicts: [],
        proposedResolutions: [],
        hardConstraintChecks: [],
        reasoningSummary: "Один глобальний план.",
      }),
    });

    expect(maximumActive).toBe(3);
  });

  it("isolates one participant MCP failure without leaking its error", async () => {
    const participants = [
      validInput.participants[0],
      {
        ...validInput.participants[0],
        id: "p2",
        displayName: "Тарас",
        preferences: {
          ...validInput.participants[0].preferences,
          allergies: [],
        },
      },
    ];
    let plannerInput: unknown;

    const result = await planEvent(
      { ...validInput, participants },
      {
        loadParticipantContext: async (participantId) => {
          if (participantId === "p2") throw new Error("secret upstream body");
          return { status: "available", data: {} };
        },
        generatePlan: async ({ input }) => {
          plannerInput = input;
          return {
            status: "needs_input",
            participantInsights: participants.map(({ id }) => ({
              participantId: id,
              contextStatus: id === "p2" ? "unavailable" : "loaded",
              allergies: [],
              hardRestrictions: [],
              preferences: [],
              summary: "Потрібне уточнення.",
            })),
            dishes: [],
            conflicts: [],
            proposedResolutions: [],
            hardConstraintChecks: [],
            reasoningSummary: "Потрібен контекст другого учасника.",
          };
        },
      },
    );

    expect(JSON.stringify(plannerInput)).not.toContain("secret upstream body");
    expect(result.contextTrace[1]).toEqual({
      participantId: "p2",
      status: "unavailable",
      reason: "Silpo context collection failed.",
    });
  });

  it("falls back to deterministic context when semantic normalization fails", async () => {
    let plannerInput: GroupPlanningInput | undefined;

    await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "available",
        data: {
          silpo_get_my_food_restrictions: {
            content: [{ type: "text", text: "Не їм невідомий інгредієнт" }],
          },
        },
      }),
      normalizeParticipantContext: async () => {
        throw new Error("raw provider response");
      },
      generatePlan: async ({ input }) => {
        plannerInput = input;
        return {
          ...safePlan,
          status: "needs_input",
          dishes: [],
          hardConstraintChecks: [],
        };
      },
    });

    expect(plannerInput?.participants[0].foodContext.hardConstraints).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Арахіс" })]),
    );
    expect(plannerInput?.participants[0].foodContext.missingInformation).toContain(
      "Не вдалося семантично нормалізувати частину контексту Сільпо.",
    );
    expect(JSON.stringify(plannerInput)).not.toContain("raw provider response");
  });

  it("does not expose raw provider failures", async () => {
    const promise = planEvent(validInput, {
      loadParticipantContext: async () => ({ status: "available", data: {} }),
      generatePlan: async () => {
        throw new Error("upstream response with private prompt");
      },
    });

    await expect(promise).rejects.toBeInstanceOf(PlanningProviderError);
    await expect(promise).rejects.not.toThrow(/private prompt/);
  });
});
