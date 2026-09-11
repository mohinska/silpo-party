import { z } from "zod";

const Id = z.string().trim().min(1).max(200);
const ShortText = z.string().trim().min(1).max(200);
const Request = z.string().trim().min(1).max(2_000);
const Query = z.string().trim().min(1).max(100);

const CandidateSchema = z.strictObject({
  evidenceId: Id,
  productId: Id,
  name: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(500),
  unitPriceCents: z.number().int().nonnegative(),
  discountCents: z.number().int().positive().nullable(),
  available: z.boolean(),
  source: z.enum(["recent_purchase", "catalog_search", "product_detail"]),
});

export const CandidatePreselectorInputSchema = z.strictObject({
  request: Request,
  queries: z.array(Query).min(1).max(3),
  constraints: z.strictObject({
    dietaryRestrictions: z.array(ShortText).max(30),
    favorites: z.array(ShortText).max(30),
    recentProductNames: z.array(ShortText).max(5),
  }),
  candidates: z.array(CandidateSchema).min(1).max(90),
});

const NormalizedIntentSchema = z.strictObject({
  productKind: ShortText,
  requestedAttributes: z.array(ShortText).max(20),
  exclusions: z.array(ShortText).max(20),
});

export const CandidatePreselectorVerdictSchema = z.enum(["match", "partial", "exclude"]);
const CandidatePreselectorOutputSchema = z.strictObject({
  normalizedIntent: NormalizedIntentSchema,
  verdicts: z.array(z.strictObject({
    evidenceId: Id,
    verdict: CandidatePreselectorVerdictSchema,
    reason: ShortText,
  })).min(1).max(90),
});

export type CandidatePreselectorInput = z.infer<typeof CandidatePreselectorInputSchema>;
export type CandidatePreselector = (input: CandidatePreselectorInput) => Promise<unknown>;
export type CandidatePreselectionStatus = "completed" | "unavailable" | "invalid";
export type CandidatePreselectionVerdict = z.infer<typeof CandidatePreselectorOutputSchema>["verdicts"][number] | {
  evidenceId: string;
  verdict: "unclassified";
  reason: string;
};
export type CandidatePreselection = {
  status: CandidatePreselectionStatus;
  normalizedIntent: z.infer<typeof NormalizedIntentSchema> | null;
  verdicts: CandidatePreselectionVerdict[];
};

const FALLBACK_REASON = "Попередній відбір недоступний.";

/** A bounded semantic pass which can only classify evidence supplied by the catalog gateway. */
export async function preselectCandidates(input: CandidatePreselectorInput, preselector?: CandidatePreselector): Promise<CandidatePreselection> {
  const safeInput = CandidatePreselectorInputSchema.parse(input);
  if (!preselector) return fallback(safeInput, "unavailable");
  try {
    return verifyCoverage(safeInput, CandidatePreselectorOutputSchema.parse(await preselector(safeInput)));
  } catch {
    return fallback(safeInput, "invalid");
  }
}

function verifyCoverage(input: CandidatePreselectorInput, output: z.infer<typeof CandidatePreselectorOutputSchema>): CandidatePreselection {
  if (output.verdicts.length !== input.candidates.length) throw new Error("Preselector verdict coverage is incomplete.");
  const permitted = new Set(input.candidates.map((candidate) => candidate.evidenceId));
  const seen = new Set<string>();
  for (const verdict of output.verdicts) {
    if (!permitted.has(verdict.evidenceId) || seen.has(verdict.evidenceId)) {
      throw new Error("Preselector verdict does not match verified evidence.");
    }
    seen.add(verdict.evidenceId);
  }
  if (seen.size !== permitted.size) throw new Error("Preselector verdict coverage is incomplete.");
  return { status: "completed", normalizedIntent: output.normalizedIntent, verdicts: output.verdicts };
}

function fallback(input: CandidatePreselectorInput, status: Exclude<CandidatePreselectionStatus, "completed">): CandidatePreselection {
  return {
    status,
    normalizedIntent: null,
    verdicts: input.candidates.map((candidate) => ({ evidenceId: candidate.evidenceId, verdict: "unclassified" as const, reason: FALLBACK_REASON })),
  };
}
