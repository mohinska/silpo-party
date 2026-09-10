import { describe, expect, it } from "vitest";

import {
  aggregateIngredients,
  buildDishAssignments,
  chooseProducts,
  normalizeIngredient,
  scaleRecipe,
} from "./meal-proposal";
import type { CatalogProduct, Recipe } from "./proposal-schemas";

describe("ingredient quantities", () => {
  it("normalizes and converts compatible metric units", () => {
    expect(normalizeIngredient({ name: " Milk ", quantity: 0.5, unit: "l" }))
      .toMatchObject({ name: "Milk", canonicalName: "milk", quantity: 500, unit: "ml" });
    expect(normalizeIngredient({ name: "Flour", quantity: 1.2, unit: "kg" }))
      .toMatchObject({ quantity: 1200, unit: "g" });
  });

  it("scales a recipe to the required servings", () => {
    const recipe: Recipe = {
      id: "r1", title: "Pasta", source: { provider: "silpo", url: "https://silpo.ua/recipes/pasta", title: "Pasta" },
      baseServings: 2,
      ingredients: [{ name: "Milk", quantity: 300, unit: "ml", variant: "standard", optional: false }],
    };
    expect(scaleRecipe(recipe, 5).ingredients[0].quantity).toBe(750);
  });
});

describe("ingredient aggregation", () => {
  it("merges compatible requirements deterministically", () => {
    const merged = aggregateIngredients([
      { dishId: "a", name: "Milk", quantity: 500, unit: "ml", variant: "regular", optional: false },
      { dishId: "b", name: "milk", quantity: 400, unit: "ml", variant: "regular", optional: false },
    ]);
    expect(merged).toEqual([{ key: "milk|regular|ml", name: "Milk", canonicalName: "milk", variant: "regular", quantity: 900, unit: "ml", optional: false, dishIds: ["a", "b"] }]);
  });

  it("never merges dietary variants", () => {
    const merged = aggregateIngredients([
      { dishId: "a", name: "Milk", quantity: 500, unit: "ml", variant: "regular", optional: false },
      { dishId: "b", name: "Milk", quantity: 400, unit: "ml", variant: "lactose-free", optional: false },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.variant)).toEqual(["lactose-free", "regular"]);
  });
});

describe("dish assignment", () => {
  const participants = [
    { id: "p1", foodIntent: { kind: "dish" as const, dishName: "Pizza" } },
    { id: "p2", foodIntent: { kind: "dish" as const, dishName: "Pasta" } },
    { id: "p3", foodIntent: { kind: "none" as const } },
  ];

  it("keeps each explicit request as a separate dish", () => {
    expect(buildDishAssignments(participants).map((dish) => dish.name)).toEqual(["Pizza", "Pasta"]);
  });

  it("shares a requested dish with an indifferent participant by default", () => {
    const dishes = buildDishAssignments(participants);
    expect(dishes[0].eaterParticipantIds).toContain("p3");
    expect(dishes[0].servings).toBe(2);
  });
});

describe("catalog selection", () => {
  const products: CatalogProduct[] = [
    { productId: "milk-1l", companyId: "c", branchId: "b", name: "Milk 1L", packageQuantity: 1000, packageUnit: "ml", priceCents: 6000, available: true, dietarySafety: "safe" },
    { productId: "milk-500", companyId: "c", branchId: "b", name: "Milk 500ml", packageQuantity: 500, packageUnit: "ml", priceCents: 3200, available: true, dietarySafety: "safe" },
  ];

  it("rounds packages up and deduplicates identical SKUs", () => {
    const result = chooseProducts([
      { key: "milk|regular|ml", name: "Milk", canonicalName: "milk", variant: "regular", quantity: 1400, unit: "ml", optional: false, dishIds: ["a"] },
      { key: "milk2|regular|ml", name: "Milk", canonicalName: "milk", variant: "regular", quantity: 200, unit: "ml", optional: false, dishIds: ["b"] },
    ], new Map([["milk|regular|ml", products], ["milk2|regular|ml", products]]), 20000);
    expect(result.lines).toEqual([expect.objectContaining({ productId: "milk-1l", packageCount: 2 })]);
  });

  it("optimizes for budget and returns concrete alternatives when still over", () => {
    const result = chooseProducts([
      { key: "milk|regular|ml", name: "Milk", canonicalName: "milk", variant: "regular", quantity: 900, unit: "ml", optional: false, dishIds: ["a"] },
    ], new Map([["milk|regular|ml", products]]), 5000);
    expect(result.totalCents).toBe(6000);
    expect(result.budgetStatus).toBe("over");
    expect(result.alternatives[0]).toMatchObject({ kind: "increase_budget", amountCents: 1000 });
  });

  it("requires verified safety for ready meals", () => {
    const ready: CatalogProduct = { ...products[0], productId: "ready", name: "Ready pasta", readyMeal: true, dietarySafety: "uncertain" };
    const result = chooseProducts([{ key: "ready", name: "Ready pasta", canonicalName: "ready pasta", variant: "vegan", quantity: 1, unit: "piece", optional: false, dishIds: ["a"], readyMeal: true }], new Map([["ready", [ready]]]), 10000);
    expect(result.unresolved[0].reason).toMatch(/dietary safety/i);
    expect(result.lines).toHaveLength(0);
  });
});
