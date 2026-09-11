import { z } from "zod";

const Id = z.string().trim().min(1).max(200);
const Query = z.string().trim().min(1).max(100);
const ShortText = z.string().trim().min(1).max(200);
const NormalizedIntent = z.object({
  productKind: ShortText,
  requestedAttributes: z.array(ShortText).max(20),
  exclusions: z.array(ShortText).max(20),
});
const CandidatePreselection = z.object({
  evidenceId: Id,
  verdict: z.enum(["match", "partial", "exclude", "unclassified"]),
  reason: ShortText,
});
const PreselectionSummary = z.object({
  status: z.enum(["completed", "unavailable", "invalid"]),
  normalizedIntent: NormalizedIntent.nullable(),
});
const Candidate = z.object({
  productId: Id,
  name: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(500),
  unitPriceCents: z.number().int().nonnegative(),
  discountCents: z.number().int().positive().nullable(),
  available: z.boolean(),
  evidenceId: Id,
  preselection: CandidatePreselection.optional(),
});

const CatalogSearchTraceInput = z.object({
  mcpTool: z.literal("silpo_find_products_batch"),
  queries: z.array(Query).min(1).max(3),
  candidates: z.array(Candidate).max(90),
  preselection: PreselectionSummary.optional(),
});

export const CatalogTraceSchema = z.discriminatedUnion("type", [
  CatalogSearchTraceInput.extend({ type: z.literal("catalog.response") }),
]);

export type CatalogTrace = z.infer<typeof CatalogTraceSchema>;

/** Deliberately parses only the public evidence fields and strips all transport data. */
export function catalogSearchTrace(value: unknown): CatalogTrace {
  return CatalogTraceSchema.parse({ type: "catalog.response", ...CatalogSearchTraceInput.parse(value) });
}
