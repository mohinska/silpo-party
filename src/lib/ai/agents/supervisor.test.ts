import { describe, expect, it } from "vitest";

import { runSupervisorDecision } from "./supervisor";

describe("main supervisor", () => {
  it("validates and returns a typed workflow decision", async () => {
    const result = await runSupervisorDecision({
      partyState: { hasIntent: true, hasBudget: true, hasProposal: false },
      message: "додай молоко",
      generate: async () => JSON.stringify({
        actions: [{ type: "search_products", requirementIds: ["ingredient-1"] }],
        reply: "Шукаю молоко в магазині організатора.",
      }),
    });
    expect(result.actions[0].type).toBe("search_products");
  });

  it("falls back to intent parsing when the supervisor response is invalid", async () => {
    const result = await runSupervisorDecision({
      partyState: { hasIntent: false, hasBudget: true, hasProposal: false },
      message: "хочу пасту",
      generate: async () => "not json",
    });
    expect(result.actions[0]).toEqual({ type: "parse_intent" });
  });
});
