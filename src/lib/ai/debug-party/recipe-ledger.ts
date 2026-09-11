import type { DebugRecipeRecord } from "./schemas";

type LedgerRequirement = {
  name: string;
  quantity: number;
  unit: "g" | "ml" | "piece" | "tbsp" | "tsp";
  optional: boolean;
  recipeIds: string[];
};

function normalizedUnit(unit: DebugRecipeRecord["ingredients"][number]["unit"], quantity: number): Pick<LedgerRequirement, "quantity" | "unit"> {
  if (unit === "kg") return { quantity: quantity * 1000, unit: "g" };
  if (unit === "l") return { quantity: quantity * 1000, unit: "ml" };
  return { quantity, unit };
}

/** Merges only exact source-backed ingredient names; it never substitutes or translates food. */
export function mergedRecipeRequirements(recipes: readonly DebugRecipeRecord[]): LedgerRequirement[] {
  const merged = new Map<string, LedgerRequirement>();
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      const normalized = normalizedUnit(ingredient.unit, ingredient.quantity);
      const key = `${ingredient.name.toLocaleLowerCase("uk-UA").replace(/\s+/g, " ").trim()}\n${normalized.unit}`;
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += normalized.quantity;
        existing.optional &&= ingredient.optional;
        if (!existing.recipeIds.includes(recipe.recipeId)) existing.recipeIds.push(recipe.recipeId);
      } else {
        merged.set(key, { name: ingredient.name, quantity: normalized.quantity, unit: normalized.unit, optional: ingredient.optional, recipeIds: [recipe.recipeId] });
      }
    }
  }
  return [...merged.values()].map((item) => ({ ...item, quantity: Math.round(item.quantity * 1000) / 1000 }));
}
