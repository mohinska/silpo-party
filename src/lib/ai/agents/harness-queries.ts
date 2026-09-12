import type { IntentDelta, SupervisorDecision } from "./contracts";

type HarnessIngredient = { name: string; variant?: string };

function uniqueQueries(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, 12);
}

export function searchQueriesForHarness(input: {
  intent: IntentDelta;
  actions: SupervisorDecision["actions"];
  ingredients?: HarnessIngredient[];
}) {
  const resolvesRecipe = input.actions.some((action) => action.type === "resolve_recipe" || action.type === "normalize_ingredients");
  if (resolvesRecipe && input.ingredients?.length) {
    return uniqueQueries(input.ingredients.map((ingredient) => ingredient.variant && ingredient.variant !== "standard" ? `${ingredient.name} ${ingredient.variant}` : ingredient.name));
  }

  return uniqueQueries([...(input.intent.additions ?? []), input.intent.dishName]);
}
