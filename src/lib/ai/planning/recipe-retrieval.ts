import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { RecipeSchema, type Recipe } from "./proposal-schemas";

const RecipeRequestHeaders = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8",
};
const SilpoRecipeCatalogUrl = "https://sf-ecom-api.silpo.ua/v1/recipes";
const SilpoRecipeDetailUrl = "https://sf-ecom-api.silpo.ua/v1/recipe";
const RecipeCatalogPageSize = 50;
const RecipeCatalogCacheMs = 5 * 60 * 1_000;
const RecipeCatalogPageSchema = z.object({
  total: z.number().int().nonnegative().max(2_000),
  items: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9-]{1,200}$/),
    title: z.string().trim().min(1).max(300),
  })).max(RecipeCatalogPageSize),
});
const RecipeCatalogDetailSchema = z.object({
  id: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]{1,200}$/),
  title: z.string().trim().min(1).max(300),
  amount: z.number().int().positive().max(100),
  ingredients: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    measure: z.object({
      quantity: z.number().finite().nonnegative(),
      unit: z.string().trim().min(1).max(40),
    }),
  })).min(1).max(100),
});
type RecipeCatalogLink = { readonly url: string; readonly title: string };

let recipeCatalogCache: { readonly expiresAt: number; readonly links: RecipeCatalogLink[] } | undefined;

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

function participantDetailSegments(details: string) {
  return details
    .replace(/\r/g, "\n")
    .split(/[\n;]+/u)
    .flatMap((segment) => segment.split(/,(?!\d)/u))
    .map((segment) => segment.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter(Boolean);
}

/**
 * Turns quantities explicitly supplied by a participant into a recipe. Nothing
 * is inferred: every non-heading line must contain a supported quantity/unit.
 */
export function parseParticipantRecipeDetails(input: { dishName: string; details: string; defaultServings?: number }): Recipe {
  const segments = participantDetailSegments(input.details);
  const servingPattern = /(?:for\s+)?(\d+)\s*(?:servings?|portions?|\u043f\u043e\u0440\u0446(?:\u0456\u0457|\u0438\u0439|\u0456\u044e|\u0456\u044f))/iu;
  const servingSegment = segments.find((segment) => servingPattern.test(segment));
  const baseServings = Number(servingSegment?.match(servingPattern)?.[1] ?? input.defaultServings ?? 1);
  const content = segments
    .filter((segment) => segment !== servingSegment)
    .map((segment) => segment.replace(/^(?:ingredients?|\u0456\u043d\u0433\u0440\u0435\u0434\u0456\u0454\u043d\u0442\u0438)\s*:\s*/iu, "").trim())
    .filter(Boolean);
  const ingredients = content.map(parseIngredient);

  if (!content.length || ingredients.some((ingredient) => !ingredient)) {
    throw new Error("Participant details do not contain a complete structured ingredient list.");
  }

  const digest = createHash("sha256").update(`${input.dishName}\n${input.details}`).digest("hex").slice(0, 20);
  return RecipeSchema.parse({
    id: `participant-details:${digest}`,
    title: input.dishName,
    source: {
      provider: "participant",
      title: "Ingredients supplied in participant request details",
    },
    baseServings,
    ingredients,
  });
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
  // Source pages commonly include seasoning such as “сіль за смаком”. Those
  // lines are real, but have no purchasable quantity; retain only explicitly
  // quantified ingredients rather than rejecting an otherwise complete recipe
  // or inventing an amount for the seasoning.
  const seenIngredients = new Set<string>();
  const ingredients = rawIngredients.map(parseIngredient)
    .filter((ingredient): ingredient is NonNullable<ReturnType<typeof parseIngredient>> => ingredient !== undefined)
    .filter((ingredient) => {
      const key = `${ingredient.name.toLocaleLowerCase("uk-UA")}\n${ingredient.quantity}\n${ingredient.unit}\n${ingredient.variant}`;
      if (seenIngredients.has(key)) return false;
      seenIngredients.add(key);
      return true;
    });
  const yieldText = Array.isArray(recipeData?.recipeYield) ? String(recipeData.recipeYield[0] ?? "") : String(recipeData?.recipeYield ?? html.match(/на\s+(\d+)\s+порц/iu)?.[1] ?? "");
  const servings = Number(yieldText.match(/\d+/)?.[0]);
  if (!title || !Number.isInteger(servings) || servings <= 0 || !ingredients.length) throw new Error("The page does not contain a complete structured recipe; no recipe contents were inferred.");
  const parsedUrl = new URL(url);
  return RecipeSchema.parse({ id: `recipe:${encodeURIComponent(parsedUrl.href)}`, title, source: { provider: parsedUrl.hostname === "silpo.ua" || parsedUrl.hostname.endsWith(".silpo.ua") ? "silpo" : "publisher", url: parsedUrl.href, title }, baseServings: servings, ingredients });
}

function assertPublicRecipeUrl(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname === "localhost" || target.hostname.endsWith(".local") || /^(127\.|10\.|169\.254\.|192\.168\.|0\.|::1$)/.test(target.hostname)) {
    throw new Error("Recipe URLs must be public HTTPS pages.");
  }
  return target;
}

async function fetchParsedRecipe(url: string, fetcher: typeof fetch) {
  assertPublicRecipeUrl(url);
  const response = await fetcher(url, { cache: "no-store", headers: RecipeRequestHeaders });
  if (!response.ok) throw new Error("The recipe source could not be retrieved.");
  return parseRecipeDocument(await response.text(), response.url || url);
}

function dishWords(dishName: string) {
  return dishName.toLocaleLowerCase("uk-UA").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function rankRecipeLinks(dishName: string, links: readonly RecipeCatalogLink[]) {
  const words = dishWords(dishName);
  const phrase = words.join(" ");
  const frequency = new Map(words.map((word) => [word, links.filter((link) => link.title.toLocaleLowerCase("uk-UA").includes(word)).length]));
  return links.map((link) => {
    const title = link.title.toLocaleLowerCase("uk-UA");
    const score = words.reduce((total, word) => total + (title.includes(word) ? 1 / Math.max(1, frequency.get(word) ?? 1) : 0), phrase && title.includes(phrase) ? 10 : 0);
    return { link, score };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.link.title.localeCompare(right.link.title, "uk-UA"))
    .map((candidate) => candidate.link);
}

async function fetchRecipeCatalogPage(offset: number, fetcher: typeof fetch) {
  const response = await fetcher(`${SilpoRecipeCatalogUrl}?limit=${RecipeCatalogPageSize}&offset=${offset}`, { cache: "no-store", headers: RecipeRequestHeaders });
  if (!response.ok) throw new Error("Silpo recipe catalog is unavailable.");
  const parsed = RecipeCatalogPageSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Silpo recipe catalog returned an invalid page.");
  return parsed.data;
}

async function fetchCatalogRecipe(link: RecipeCatalogLink, fetcher: typeof fetch): Promise<Recipe> {
  const slug = new URL(link.url).pathname.split("/").at(-1);
  if (!slug || !/^[a-z0-9-]{1,200}$/.test(slug)) throw new Error("Recipe catalog returned an invalid recipe slug.");
  const response = await fetcher(`${SilpoRecipeDetailUrl}/${slug}`, {
    cache: "no-store",
    headers: { ...RecipeRequestHeaders, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("The recipe source could not be retrieved.");
  const parsed = RecipeCatalogDetailSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("The recipe source returned invalid data.");
  const ingredients = parsed.data.ingredients.flatMap((ingredient) => {
    if (ingredient.measure.quantity <= 0) return [];
    const parsedIngredient = parseIngredient(`${ingredient.name} ${ingredient.measure.quantity} ${ingredient.measure.unit}`);
    return parsedIngredient ? [parsedIngredient] : [];
  });
  return RecipeSchema.parse({
    id: `recipe:${encodeURIComponent(link.url)}`,
    title: parsed.data.title,
    source: { provider: "silpo", title: parsed.data.title, url: link.url },
    baseServings: parsed.data.amount,
    ingredients,
  });
}

async function listCatalogRecipeLinks(fetcher: typeof fetch): Promise<RecipeCatalogLink[]> {
  if (fetcher === fetch && recipeCatalogCache && recipeCatalogCache.expiresAt > Date.now()) return recipeCatalogCache.links;
  const first = await fetchRecipeCatalogPage(0, fetcher);
  const offsets = Array.from({ length: Math.max(0, Math.ceil(first.total / RecipeCatalogPageSize) - 1) }, (_, index) => (index + 1) * RecipeCatalogPageSize);
  const pages = [first, ...await Promise.all(offsets.map((offset) => fetchRecipeCatalogPage(offset, fetcher)))];
  const links = pages.flatMap((page) => page.items.map((item) => ({ url: `https://silpo.ua/recipes/${item.slug}`, title: item.title })));
  if (!links.length) throw new Error("Silpo recipe catalog is empty.");
  if (fetcher === fetch) recipeCatalogCache = { expiresAt: Date.now() + RecipeCatalogCacheMs, links };
  return links;
}

async function listLandingPageRecipeLinks(fetcher: typeof fetch): Promise<RecipeCatalogLink[]> {
  const search = await fetcher("https://silpo.ua/recipes", { cache: "no-store", headers: RecipeRequestHeaders });
  if (!search.ok) throw new Error("Silpo recipe index is unavailable.");
  const html = await search.text();
  return [...html.matchAll(/<a[^>]+href=["'](\/recipes\/[a-z0-9%_-]+)["'][^>]*>([\s\S]*?)<\/a>/giu)].map((match) => ({
    url: new URL(match[1], "https://silpo.ua").href,
    title: decodeHtml(match[2]),
  }));
}

export async function retrieveRecipe(input: { dishName: string; requestedUrl?: string }, fetcher: typeof fetch = fetch): Promise<Recipe> {
  if (input.requestedUrl) {
    const recipe = await fetchParsedRecipe(input.requestedUrl, fetcher);
    return recipe.source.provider !== "silpo" ? { ...recipe, source: { ...recipe.source, provider: "participant" } } : recipe;
  }

  // `silpo.ua/recipes` contains only a small promo carousel. The public API
  // exposes the actual catalog, letting us fetch just a title-matched source
  // page instead of silently using an unrelated card.
  let links: RecipeCatalogLink[];
  let catalogAvailable = true;
  try {
    links = await listCatalogRecipeLinks(fetcher);
  } catch {
    catalogAvailable = false;
    links = await listLandingPageRecipeLinks(fetcher);
  }
  const candidates = rankRecipeLinks(input.dishName, links);
  let lastError: unknown;
  for (const candidate of candidates.slice(0, 5)) {
    try {
      return catalogAvailable
        ? await fetchCatalogRecipe(candidate, fetcher)
        : await fetchParsedRecipe(candidate.url, fetcher);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`No sourced recipe was found for ${input.dishName}.`);
}

export async function retrieveRecipeForRequest(
  input: { dishName: string; requestedUrl?: string; details?: string; targetServings?: number },
  fetcher: typeof fetch = fetch,
): Promise<Recipe> {
  if (input.details?.trim()) {
    try {
      return parseParticipantRecipeDetails({ dishName: input.dishName, details: input.details, defaultServings: input.targetServings });
    } catch {
      // Free-form details are allowed; an incomplete list falls back to a sourced page.
    }
  }
  return retrieveRecipe({ dishName: input.dishName, requestedUrl: input.requestedUrl }, fetcher);
}
