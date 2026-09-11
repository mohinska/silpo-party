import { describe, expect, it } from "vitest";
import { mergedRecipeRequirements } from "./recipe-ledger";

const now = "2026-09-11T10:00:00.000Z";
function record(recipeId: string, ingredients: Array<{ name: string; quantity: number; unit: "g" | "kg" | "ml" | "l" | "piece" | "tbsp" | "tsp"; optional?: boolean }>) {
  return { id: `row-${recipeId}`, partyId: "party", recipeId, title: recipeId, sourceUrl: null, baseServings: 2,
    ingredients: ingredients.map((ingredient) => ({ ...ingredient, variant: "standard", optional: ingredient.optional ?? false })), createdAt: now, updatedAt: now };
}

describe("recipe ledger", () => {
  it("sums exact source-backed ingredients into grams, millilitres and pieces", () => {
    expect(mergedRecipeRequirements([
      record("carbonara", [{ name: "Спагеті", quantity: 100, unit: "g" }, { name: "Яйця", quantity: 3, unit: "piece" }]),
      record("pasta", [{ name: "спагеті", quantity: 0.2, unit: "kg" }, { name: "Яйця", quantity: 2, unit: "piece" }]),
    ])).toEqual([
      { name: "Спагеті", quantity: 300, unit: "g", optional: false, recipeIds: ["carbonara", "pasta"] },
      { name: "Яйця", quantity: 5, unit: "piece", optional: false, recipeIds: ["carbonara", "pasta"] },
    ]);
  });
});
