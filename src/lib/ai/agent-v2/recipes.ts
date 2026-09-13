import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseIngredient } from "../planning/recipe-retrieval";
import { UnitSchema, requestDependencyKeys, type Artifact, type Evidence, type Workspace } from "./state";
import { RequirementSchema } from "./draft";
import { fetchRecipePage } from "./recipe-fetch";

const text = z.string().trim().min(1).max(2000);
export const CommerceRequirementSchema = RequirementSchema.extend({ requiredAttributes: z.record(z.string(), text).default({}) });
export type CommerceRequirement = z.infer<typeof CommerceRequirementSchema>;
const RecipeFields = { id: text, title: text, servings: z.number().positive().max(10000), ingredients: z.array(z.object({ name: text, quantity: z.number().positive(), unit: UnitSchema, requiredAttributes: z.record(z.string(), text).default({}) }).strict()).min(1).max(100), steps: z.array(text).min(1).max(100) };
export const CompleteRecipeSchema = z.discriminatedUnion("origin", [z.object({ ...RecipeFields, origin: z.literal("generated") }).strict(), z.object({ ...RecipeFields, origin: z.literal("source"), sourceUrl: z.url() }).strict()]);
export type CompleteRecipe = z.infer<typeof CompleteRecipeSchema>;
const resolvedRecipe = Symbol("resolved-recipe");
export type ResolvedRecipe = CompleteRecipe & { readonly [resolvedRecipe]: true };
function markResolved(recipe: CompleteRecipe): ResolvedRecipe {
  Object.defineProperty(recipe, resolvedRecipe, { value: true });
  return recipe as ResolvedRecipe;
}
function verifiedRecipe(recipe: ResolvedRecipe): CompleteRecipe {
  if (!recipe || typeof recipe !== "object" || recipe[resolvedRecipe] !== true) throw new Error("Verified resolved recipe required");
  return CompleteRecipeSchema.parse(recipe);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validateGeneratedRecipe(input: unknown): ResolvedRecipe {
  return markResolved(CompleteRecipeSchema.options[0].parse(input));
}
export function deriveProductRequirement(workspace: Workspace, requestId: string, requiredAttributes: Record<string, string> = {}): CommerceRequirement {
  const request = workspace.requests.find(r => r.id === requestId);
  if (!request || request.kind !== "product" || !request.quantity || !request.unit) throw new Error("Explicit product quantity and unit required");
  return CommerceRequirementSchema.parse({ id: `requirement:${requestId}:product`, requestId, name: request.text, quantity: request.quantity, unit: request.unit, eaterIds: request.eaterIds, evidenceRefs: [`request:${requestId}:source`], requiredAttributes });
}

/** The old parser's unit/quantity grammar is reused; dropping ingredients is forbidden. */
export function parseSourceRecipe(html: string, url: string): ResolvedRecipe {
  let source: Record<string, unknown> | undefined;
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 20 || source || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(item => visit(item, depth + 1)); return; }
    const record = node as Record<string, unknown>;
    if (record["@type"] === "Recipe" || (Array.isArray(record["@type"]) && record["@type"].includes("Recipe"))) { source = record; return; }
    Object.values(record).forEach(item => visit(item, depth + 1));
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try { visit(JSON.parse(match[1])); } catch { /* Unrelated malformed metadata. */ }
  }
  if (!source) throw new Error("Complete structured recipe unavailable");
  const record: Record<string, unknown> = source;
  const raw = z.array(text).min(1).max(100).parse(record.recipeIngredient);
  const ingredients = raw.map(parseIngredient);
  if (ingredients.some(item => !item)) throw new Error("Complete quantities required for every source ingredient");
  const steps: string[] = [];
  const instruction = (node: unknown, depth = 0): void => {
    if (depth > 10) throw new Error("Complete preparation steps required");
    if (typeof node === "string") steps.push(node);
    else if (Array.isArray(node)) node.forEach(item => instruction(item, depth + 1));
    else if (node && typeof node === "object") {
      const item = node as Record<string, unknown>;
      if (item["@type"] === "HowToSection") instruction(item.itemListElement, depth + 1);
      else if (item["@type"] === "HowToStep" && typeof item.text === "string") steps.push(item.text);
      else throw new Error("Complete preparation steps required");
    } else throw new Error("Complete preparation steps required");
  };
  instruction(record.recipeInstructions);
  const yieldText = String(Array.isArray(record.recipeYield) ? record.recipeYield[0] : record.recipeYield);
  const servings = /^\s*(\d+(?:\.\d+)?)(?:\s+(?:servings?|portions?|порц\S*))?\s*$/iu.exec(yieldText)?.[1];
  return markResolved(CompleteRecipeSchema.parse({ id: `source:${createHash("sha256").update(url + html).digest("hex").slice(0, 24)}`, origin: "source", sourceUrl: url, title: record.name, servings: Number(servings), ingredients: ingredients.map(item => ({ name: item!.name, quantity: item!.quantity, unit: item!.unit, requiredAttributes: {} })), steps }));
}
export async function resolveRecipeSource(url: string, signal?: AbortSignal) {
  const page = await fetchRecipePage(url, { signal });
  return parseSourceRecipe(page.body, page.url);
}

export function deriveRecipeRequirements(workspace: Workspace, requestId: string, input: ResolvedRecipe) {
  const recipe = verifiedRecipe(input);
  const request = workspace.requests.find(r => r.id === requestId);
  if (!request || request.kind === "product") throw new Error("Recipe request required");
  const roots = requestDependencyKeys(requestId);
  const recipeArtifactId = `recipe:${requestId}`;
  const evidence: Evidence = { id: `evidence:${createHash("sha256").update(canonical(recipe)).digest("hex")}`, source: recipe.origin === "generated" ? "generated_recipe" : "recipe_source", sourceRef: recipe.id, complete: true, verified: true, ingredients: recipe.ingredients.map(i => i.name), composition: recipe.ingredients.map(i => i.name).join(", ") };
  const requirements = recipe.ingredients.map((ingredient, index) => CommerceRequirementSchema.parse({ id: `requirement:${requestId}:${index}`, requestId, name: ingredient.name, quantity: ingredient.quantity * request.servings / recipe.servings, unit: ingredient.unit, eaterIds: request.eaterIds, evidenceRefs: [evidence.id], requiredAttributes: ingredient.requiredAttributes }));
  const priorRecipe = workspace.artifacts.find(a => a.id === recipeArtifactId);
  const recipeArtifact: Artifact = priorRecipe?.valid && priorRecipe.evidenceRefs.length === 1 && priorRecipe.evidenceRefs[0] === evidence.id
    ? priorRecipe : { id: recipeArtifactId, kind: "recipe", version: (priorRecipe?.version ?? 0) + 1, valid: true, dependsOn: [roots.source], evidenceRefs: [evidence.id] };
  const artifacts: Artifact[] = [recipeArtifact, ...requirements.map(r => ({ id: r.id, kind: "requirement" as const, version: request.version, valid: true, dependsOn: [recipeArtifactId, roots.scaling, roots.eaters, ...request.eaterIds.map(id => `context:${id}`)], evidenceRefs: r.evidenceRefs }))];
  return { recipe, requirements, artifacts, evidence: [evidence] };
}
