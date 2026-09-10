import type { CatalogProduct, MergedIngredient, Recipe, Unit } from "./proposal-schemas";

type RawIngredient = { dishId?: string; name: string; quantity: number; unit: "g" | "kg" | "ml" | "l" | "piece" | "tbsp" | "tsp"; variant?: string; optional?: boolean; readyMeal?: boolean };

const mass: Record<string, number> = { g: 1, kg: 1000 };
const volume: Record<string, number> = { ml: 1, l: 1000, tbsp: 15, tsp: 5 };

function canonicalText(value: string) {
  return value.trim().toLocaleLowerCase("uk-UA").replace(/\s+/g, " ");
}

export function normalizeIngredient(ingredient: RawIngredient) {
  const name = ingredient.name.trim();
  const unit: Unit = ingredient.unit in mass ? "g" : ingredient.unit in volume ? "ml" : "piece";
  const factor = mass[ingredient.unit] ?? volume[ingredient.unit] ?? 1;
  return {
    ...ingredient,
    name,
    canonicalName: canonicalText(name),
    variant: canonicalText(ingredient.variant ?? "standard"),
    quantity: Math.round(ingredient.quantity * factor * 1000) / 1000,
    unit,
    optional: ingredient.optional ?? false,
  };
}

export function scaleRecipe(recipe: Recipe, servings: number) {
  const factor = servings / recipe.baseServings;
  return { ...recipe, baseServings: servings, ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient, quantity: Math.round(ingredient.quantity * factor * 1000) / 1000 })) };
}

export function aggregateIngredients(ingredients: RawIngredient[]): MergedIngredient[] {
  const grouped = new Map<string, MergedIngredient>();
  for (const raw of ingredients) {
    const item = normalizeIngredient(raw);
    const key = `${item.canonicalName}|${item.variant}|${item.unit}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity = Math.round((existing.quantity + item.quantity) * 1000) / 1000;
      if (item.dishId && !existing.dishIds.includes(item.dishId)) existing.dishIds.push(item.dishId);
      existing.optional = existing.optional && item.optional;
    } else {
      grouped.set(key, { key, name: item.name, canonicalName: item.canonicalName, variant: item.variant, quantity: item.quantity, unit: item.unit, optional: item.optional, dishIds: item.dishId ? [item.dishId] : ["unassigned"], readyMeal: item.readyMeal });
    }
  }
  return [...grouped.values()].map((item) => ({ ...item, dishIds: [...item.dishIds].sort() })).sort((a, b) => a.key.localeCompare(b.key));
}

type IntentParticipant = { id: string; foodIntent: { kind: "none" } | { kind: "dish"; dishName: string } | { kind: "recipe"; requestedDishName?: string; recipeUrl: string } };

export function buildDishAssignments(participants: IntentParticipant[]) {
  const explicit = participants.flatMap((participant) => {
    if (participant.foodIntent.kind === "none") return [];
    const name = participant.foodIntent.kind === "dish" ? participant.foodIntent.dishName : participant.foodIntent.requestedDishName ?? "Requested recipe";
    return [{ id: "", name, requestedByParticipantIds: [participant.id], eaterParticipantIds: [participant.id], servings: 1 }];
  }).map((dish, index) => ({ ...dish, id: `dish-${index + 1}` }));
  const indifferent = participants.filter((participant) => participant.foodIntent.kind === "none");
  if (explicit.length) for (const participant of indifferent) explicit[0].eaterParticipantIds.push(participant.id);
  else if (indifferent.length) explicit.push({ id: "dish-1", name: "Host-selected compatible meal", requestedByParticipantIds: [], eaterParticipantIds: indifferent.map(({ id }) => id), servings: indifferent.length });
  return explicit.map((dish) => ({ ...dish, servings: dish.eaterParticipantIds.length }));
}

function compatible(requirement: MergedIngredient, product: CatalogProduct) {
  return requirement.unit === product.packageUnit && product.available && product.dietarySafety === "safe" && (!requirement.readyMeal || product.readyMeal === true);
}

export function chooseProducts(requirements: MergedIngredient[], candidates: Map<string, CatalogProduct[]>, budgetCents: number) {
  const selections: Array<{ requirement: MergedIngredient; product: CatalogProduct }> = [];
  const unresolved: Array<{ requirementKey: string; reason: string }> = [];
  const requirementGroups = new Map<string, MergedIngredient[]>();
  for (const requirement of requirements) {
    const key = `${requirement.canonicalName}|${requirement.variant}|${requirement.unit}|${Boolean(requirement.readyMeal)}`;
    requirementGroups.set(key, [...(requirementGroups.get(key) ?? []), requirement]);
  }
  for (const groupedRequirements of requirementGroups.values()) {
    const requirement = groupedRequirements[0];
    const candidateLists = groupedRequirements.map((item) => candidates.get(item.key) ?? []);
    const available = candidateLists[0]?.filter((product) =>
      compatible(requirement, product) && candidateLists.every((list) => list.some((candidate) => candidate.productId === product.productId && candidate.companyId === product.companyId && candidate.branchId === product.branchId)),
    ) ?? [];
    if (!available.length) {
      for (const item of groupedRequirements) {
        const uncertainReady = item.readyMeal && (candidates.get(item.key) ?? []).some((product) => product.dietarySafety === "uncertain");
        unresolved.push({ requirementKey: item.key, reason: uncertainReady ? "Ready meal dietary safety requires verified product details." : "No verified compatible available product was returned by Silpo." });
      }
      continue;
    }
    const totalQuantity = groupedRequirements.reduce((sum, item) => sum + item.quantity, 0);
    available.sort((a, b) => Math.ceil(totalQuantity / a.packageQuantity) * a.priceCents - Math.ceil(totalQuantity / b.packageQuantity) * b.priceCents || a.productId.localeCompare(b.productId));
    for (const item of groupedRequirements) selections.push({ requirement: item, product: available[0] });
  }
  const grouped = new Map<string, { product: CatalogProduct; quantity: number; requirementKeys: string[] }>();
  for (const selection of selections) {
    const product = selection.product;
    const key = `${product.productId}|${product.companyId}|${product.branchId}`;
    const existing = grouped.get(key);
    grouped.set(key, { product, quantity: (existing?.quantity ?? 0) + selection.requirement.quantity, requirementKeys: [...(existing?.requirementKeys ?? []), selection.requirement.key] });
  }
  let lines = [...grouped.values()].map(({ product, quantity, requirementKeys }) => {
    const packageCount = Math.ceil(quantity / product.packageQuantity);
    return { requirementKeys: [...new Set(requirementKeys)].sort(), productId: product.productId, companyId: product.companyId, branchId: product.branchId, name: product.name, packageCount, packageQuantity: product.packageQuantity, packageUnit: product.packageUnit, unitPriceCents: product.priceCents, lineTotalCents: packageCount * product.priceCents };
  });
  lines.sort((a, b) => `${a.productId}|${a.companyId}|${a.branchId}`.localeCompare(`${b.productId}|${b.companyId}|${b.branchId}`));
  let totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  if (totalCents > budgetCents) {
    const optionalKeys = new Set(requirements.filter((item) => item.optional).map((item) => item.key));
    const withoutOptional = lines.filter((line) => !line.requirementKeys.every((key) => optionalKeys.has(key)));
    const cheaperTotal = withoutOptional.reduce((sum, line) => sum + line.lineTotalCents, 0);
    if (cheaperTotal <= budgetCents) { lines = withoutOptional; totalCents = cheaperTotal; }
  }
  const alternatives = totalCents > budgetCents ? [{ kind: "increase_budget" as const, description: `Increase the shared budget by ${(totalCents - budgetCents) / 100} UAH while keeping every requested dish.`, amountCents: totalCents - budgetCents }] : [];
  return { lines, totalCents, unresolved, budgetStatus: unresolved.length ? "unresolved" as const : totalCents > budgetCents ? "over" as const : "within" as const, alternatives };
}
