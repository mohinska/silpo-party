import "server-only";

import { RecipeSchema, type Recipe } from "./proposal-schemas";

function decodeHtml(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&ndash;|&mdash;/g, "-").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function findRecipe(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) for (const item of value) { const found = findRecipe(item); if (found) return found; }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
  if (types.includes("Recipe")) return record;
  for (const nested of Object.values(record)) { const found = findRecipe(nested); if (found) return found; }
  return undefined;
}

function numberFrom(value: string) {
  const normalized = value.replace(",", ".");
  const fraction = normalized.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[1]) + Number(fraction[2]) / Number(fraction[3]);
  const simpleFraction = normalized.match(/^(\d+)\/(\d+)$/);
  if (simpleFraction) return Number(simpleFraction[1]) / Number(simpleFraction[2]);
  return Number(normalized);
}

function parseIngredient(raw: string) {
  const text = decodeHtml(raw).replace(/[–—]/g, "-").trim();
  const unitPattern = "kg|кг|g|гр?|г|ml|мл|l|л|tbsp|ст\\.?\\s*л\\.?|tsp|ч\\.?\\s*л\\.?|piece|pieces|pcs?|шт\\.?|зубчики?|склянки?|пучки?";
  const leading = text.match(new RegExp(`^(\\d+(?:[.,]\\d+)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+)\\s*(${unitPattern})\\s+(.+)$`, "iu"));
  const trailing = text.match(new RegExp(`^(.+?)\\s*[-:]?\\s*(\\d+(?:[.,]\\d+)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+)\\s*(${unitPattern})$`, "iu"));
  const match = leading ? [leading[0], leading[1], leading[2], leading[3]] : trailing ? [trailing[0], trailing[2], trailing[3], trailing[1]] : undefined;
  if (!match) return undefined;
  const token = match[2].toLocaleLowerCase("uk-UA").replace(/\s|\./g, "");
  const unit = /^(kg|кг)$/.test(token) ? "kg" : /^(g|гр|г)$/.test(token) ? "g" : /^(ml|мл)$/.test(token) ? "ml" : /^(l|л)$/.test(token) ? "l" : /^(tbsp|стл)$/.test(token) ? "tbsp" : /^(tsp|чл)$/.test(token) ? "tsp" : "piece";
  return { name: decodeHtml(match[3]), quantity: numberFrom(match[1]), unit, variant: "standard", optional: false } as const;
}

export function parseRecipeDocument(html: string, url: string): Recipe {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)];
  let recipeData: Record<string, unknown> | undefined;
  for (const script of scripts) {
    try { recipeData = findRecipe(JSON.parse(script[1])); } catch { /* Ignore invalid unrelated metadata. */ }
    if (recipeData) break;
  }
  const pageTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/iu)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1];
  const title = typeof recipeData?.name === "string" ? decodeHtml(recipeData.name) : decodeHtml(pageTitle ?? "").replace(/\s*ᐉ.*$/, "");
  let rawIngredients = Array.isArray(recipeData?.recipeIngredient) ? recipeData.recipeIngredient.filter((item): item is string => typeof item === "string") : [];
  if (!rawIngredients.length) rawIngredients = [...html.matchAll(/<li[^>]+data-autotestid=["']recipes-ingredient-item-\d+["'][^>]*>([\s\S]*?)<\/li>/giu)].map((match) => decodeHtml(match[1]));
  const ingredients = rawIngredients.map(parseIngredient);
  const yieldText = Array.isArray(recipeData?.recipeYield) ? String(recipeData.recipeYield[0] ?? "") : String(recipeData?.recipeYield ?? html.match(/на\s+(\d+)\s+порц/iu)?.[1] ?? "");
  const servings = Number(yieldText.match(/\d+/)?.[0]);
  if (!title || !Number.isInteger(servings) || servings <= 0 || !rawIngredients.length || ingredients.some((item) => !item)) throw new Error("The page does not contain a complete structured recipe; no recipe contents were inferred.");
  const parsedUrl = new URL(url);
  return RecipeSchema.parse({ id: `recipe:${encodeURIComponent(parsedUrl.href)}`, title, source: { provider: parsedUrl.hostname === "silpo.ua" || parsedUrl.hostname.endsWith(".silpo.ua") ? "silpo" : "publisher", url: parsedUrl.href, title }, baseServings: servings, ingredients });
}

export async function retrieveRecipe(input: { dishName: string; requestedUrl?: string }, fetcher: typeof fetch = fetch): Promise<Recipe> {
  let url = input.requestedUrl;
  if (!url) {
    const search = await fetcher(`https://silpo.ua/recipes?search=${encodeURIComponent(input.dishName)}`, { cache: "no-store" });
    if (!search.ok) throw new Error("Silpo recipe search is unavailable.");
    const html = await search.text();
    const words = input.dishName.toLocaleLowerCase("uk-UA").match(/[\p{L}\p{N}]+/gu) ?? [];
    const links = [...html.matchAll(/<a[^>]+href=["'](\/recipes\/[a-z0-9%_-]+)["'][^>]*>([\s\S]*?)<\/a>/giu)].map((match) => ({
      url: new URL(match[1], "https://silpo.ua").href,
      title: decodeHtml(match[2]).toLocaleLowerCase("uk-UA"),
    }));
    links.sort((left, right) => words.filter((word) => right.title.includes(word)).length - words.filter((word) => left.title.includes(word)).length || left.url.localeCompare(right.url));
    url = links[0]?.url;
    if (!url) throw new Error(`No sourced recipe was found for ${input.dishName}.`);
  }
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname === "localhost" || target.hostname.endsWith(".local") || /^(127\.|10\.|169\.254\.|192\.168\.|0\.|::1$)/.test(target.hostname)) throw new Error("Recipe URLs must be public HTTPS pages.");
  const response = await fetcher(url, { cache: "no-store" });
  if (!response.ok) throw new Error("The recipe source could not be retrieved.");
  const recipe = parseRecipeDocument(await response.text(), response.url || url);
  return input.requestedUrl && recipe.source.provider !== "silpo" ? { ...recipe, source: { ...recipe.source, provider: "participant" } } : recipe;
}
