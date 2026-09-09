import { describe, expect, it } from "vitest";

import {
  extractParticipantFoodSignals,
  normalizeParticipantFoodContext,
} from "./normalization";

const participant = {
  id: "p1",
  displayName: "Олена",
  preferences: {
    allergies: [{ id: "peanut", label: "Арахіс" }],
    dietaryRestrictions: [],
    likes: [],
    dislikes: [],
    cuisines: [],
  },
  foodIntent: { kind: "none" as const },
  contextCompleteness: "partial" as const,
};

describe("extractParticipantFoodSignals", () => {
  it("keeps bounded food facts and drops unsupported or sensitive MCP data", () => {
    const signals = extractParticipantFoodSignals("p1", {
      silpo_get_my_food_restrictions: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              restrictions: [
                { type: "allergy", name: "Мигдаль" },
                { type: "preference", name: "Гострі страви" },
              ],
              email: "private@example.com",
              accessToken: "secret",
            }),
          },
        ],
      },
      silpo_get_my_favorites: {
        structuredContent: {
          items: [{ name: "Тофу", category: "Рослинні продукти" }],
        },
      },
      silpo_get_my_online_orders: {
        content: [{ type: "text", text: "large private order history" }],
      },
    });

    expect(signals.restrictions.map(({ label, kind }) => ({ label, kind }))).toEqual([
      { label: "Мигдаль", kind: "allergy" },
      { label: "Гострі страви", kind: "preference" },
    ]);
    expect(signals.favorites).toHaveLength(1);
    expect(signals.favorites[0].name).toBe("Тофу");
    expect(JSON.stringify(signals)).not.toMatch(
      /private@example\.com|secret|order history/i,
    );
  });
});

describe("normalizeParticipantFoodContext", () => {
  it("uses deterministic facts without calling the semantic adapter", async () => {
    let adapterCalls = 0;
    const signals = extractParticipantFoodSignals("p1", {
      silpo_get_my_food_restrictions: {
        structuredContent: {
          restrictions: [{ type: "allergy", name: "Мигдаль" }],
        },
      },
    });

    const context = await normalizeParticipantFoodContext({
      participant,
      signals,
      normalizeAmbiguous: async () => {
        adapterCalls += 1;
        throw new Error("must not be called");
      },
    });

    expect(adapterCalls).toBe(0);
    expect(context.hardConstraints.map(({ label }) => label)).toEqual([
      "Арахіс",
      "Мигдаль",
    ]);
  });

  it("cannot remove declared constraints when normalizing ambiguous fragments", async () => {
    const signals = {
      participantId: "p1",
      restrictions: [],
      favorites: [],
      ambiguousFragments: ["Не їм продукти тваринного походження"],
      evidence: [],
      completeness: "partial" as const,
    };

    const context = await normalizeParticipantFoodContext({
      participant,
      signals,
      normalizeAmbiguous: async () => ({
        participantId: "p1",
        hardConstraints: [],
        softPreferences: [],
        dislikes: [],
        usefulPatterns: [],
        missingInformation: [],
        completeness: "partial",
        evidence: [],
        summary: "Потрібне уточнення.",
      }),
    });

    expect(context.hardConstraints.map(({ label }) => label)).toContain("Арахіс");
  });
});
