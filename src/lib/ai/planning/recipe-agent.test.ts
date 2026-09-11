import { describe, expect, it } from "vitest";
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { normalizeRecipeForCart, type RecipeNormalizer } from "./recipe-agent";

const recipe = {
  id: "recipe:carbonara",
  title: "Карбонара",
  source: { provider: "silpo" as const, title: "Карбонара", url: "https://silpo.ua/recipes/karbonara" },
  baseServings: 2,
  ingredients: [
    { name: "Спагеті", quantity: 100, unit: "g" as const, variant: "standard", optional: false },
    { name: "Сіль", quantity: 1, unit: "tsp" as const, variant: "standard", optional: false },
    { name: "Яйця", quantity: 3, unit: "piece" as const, variant: "standard", optional: false },
  ],
};

describe("recipe cart normalizer", () => {
  it("lets the recipe subagent exclude a quantified pantry item without changing sourced facts", async () => {
    const received: unknown[] = [];
    const normalizer: RecipeNormalizer = async (request) => {
      received.push(request.recipe);
      return { include: [{ sourceIndex: 0, optional: false }, { sourceIndex: 2, optional: false }] };
    };

    const result = await normalizeRecipeForCart(recipe, normalizer);

    expect(received).toEqual([expect.objectContaining({ ingredients: expect.arrayContaining([
      expect.objectContaining({ sourceIndex: 1, name: "Сіль", quantity: 1, unit: "tsp" }),
    ]) })]);
    expect(result.ingredients).toEqual([recipe.ingredients[0], recipe.ingredients[2]]);
  });

  it("rejects a subagent output that removes every sourced ingredient", async () => {
    const normalizer: RecipeNormalizer = async () => ({ include: [] });
    await expect(normalizeRecipeForCart(recipe, normalizer)).rejects.toThrow(/all sourced ingredients/i);
  });
});
