import { describe, expect, it } from "vitest";
import { searchQueriesForHarness } from "./harness-queries";

describe("agent harness product queries", () => {
  it("searches recipe ingredients after recipe resolution instead of the dish name", () => {
    const queries = searchQueriesForHarness({
      intent: {
        kind: "product_request",
        dishName: "паста карбонара",
        additions: [],
        removals: [],
        modifications: [],
        servings: 2,
        confidence: 0.95,
      },
      actions: [{ type: "resolve_recipe", dishName: "паста карбонара" }, { type: "normalize_ingredients" }],
      ingredients: [
        { name: "спагеті", variant: "standard" },
        { name: "бекон", variant: "standard" },
        { name: "яйце", variant: "standard" },
      ],
    });

    expect(queries).toEqual(["спагеті", "бекон", "яйце"]);
    expect(queries).not.toContain("паста карбонара");
  });

  it("keeps direct product requests unchanged", () => {
    expect(searchQueriesForHarness({
      intent: {
        kind: "product_request",
        additions: ["молоко"],
        removals: [],
        modifications: [],
        confidence: 0.9,
      },
      actions: [{ type: "search_products", requirementIds: ["milk"] }],
    })).toEqual(["молоко"]);
  });
});
