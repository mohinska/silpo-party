import type { CatalogProduct } from "./proposal-schemas";

function tokens(value: string) {
  return value.toLocaleLowerCase("uk-UA").match(/[\p{L}\p{N}]+(?:[.,]\d+)?/gu) ?? [];
}

function score(name: string, query: string, variant?: string) {
  const haystack = tokens(name);
  const wanted = tokens(`${query} ${variant ?? ""}`);
  if (!wanted.length) return 0;
  const matched = wanted.filter((token) => haystack.some((candidate) => candidate === token || candidate.startsWith(token)));
  const base = matched.length / wanted.length;
  const exactName = tokens(query).every((token) => haystack.some((candidate) => candidate === token));
  const exactVariant = !variant || tokens(variant).every((token) => haystack.some((candidate) => candidate.includes(token)));
  return base + (exactName ? 0.35 : 0) + (exactVariant ? 0.25 : 0);
}

export function rankCatalogCandidates(
  requirement: { name: string; variant?: string },
  candidates: CatalogProduct[],
) {
  return candidates
    .filter((candidate) => candidate.available && candidate.dietarySafety === "safe")
    .map((candidate) => ({ candidate, score: score(candidate.name, requirement.name, requirement.variant) }))
    .filter(({ score: value }) => value >= 0.5)
    .sort((left, right) => right.score - left.score || left.candidate.priceCents - right.candidate.priceCents || left.candidate.productId.localeCompare(right.candidate.productId))
    .map(({ candidate }) => candidate);
}

export function productSearchQueries(requirement: { name: string; variant?: string }) {
  const base = `${requirement.name} ${requirement.variant ?? ""}`.trim().replace(/\s+/g, " ");
  const queries = [base, requirement.name, requirement.variant ? `${requirement.name} ${requirement.variant}` : ""];
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 3);
}
