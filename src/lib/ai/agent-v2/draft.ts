import { z } from "zod";
import { normalizeIngredient } from "../planning/meal-proposal";
import { DraftSchema, EvidenceSchema, UnitSchema, effectiveRules, type Draft, type Evidence, type HardRule, type Workspace } from "./state";

export type SafetyResult =
  | { status: "safe"; evidenceRefs: string[] }
  | { status: "unsafe" | "unknown"; evidenceRefs: string[]; privateReason: string }
  // A semantic (allergy/diet) restriction can't be confirmed or ruled out from
  // literal text -- that's a real limit, not a data gap. Warn the declaring
  // participant privately instead of blocking the whole draft for everyone.
  | { status: "warn"; evidenceRefs: string[]; privateReason: string; recipientIds: string[] };
const canonical = (value: string) => value.normalize("NFKC").toLocaleLowerCase("uk-UA").trim();

/** Literal exclusions and missing/incomplete data are real blockers for
 * everyone. A semantic restriction with a known owner becomes a private
 * warning to that owner only, never a block on the shared draft. */
export function evaluateEvidence(rules: HardRule[], input: Evidence): SafetyResult {
  const evidence = EvidenceSchema.parse(input);
  const text = canonical([...evidence.ingredients, evidence.composition].join(" "));
  const refs = [evidence.id];
  if (rules.some(rule => rule.kind === "exclude_term" && text.includes(canonical(rule.value)))) return { status: "unsafe", evidenceRefs: refs, privateReason: "Declared excluded ingredient appears in source evidence" };
  if (!evidence.verified || !evidence.complete || !evidence.ingredients.length || !evidence.composition.trim()) return { status: "unknown", evidenceRefs: refs, privateReason: "Complete verified composition is unavailable" };
  const semanticRules = rules.filter(rule => rule.kind === "semantic");
  if (semanticRules.length) {
    const recipientIds = [...new Set(semanticRules.map(rule => rule.ownerId).filter((id): id is string => Boolean(id)))];
    if (recipientIds.length) return { status: "warn", evidenceRefs: refs, privateReason: "Semantic restriction is not supported by deterministic evidence validation", recipientIds };
    // Pre-migration rule with no recorded owner: fail closed until that
    // participant's context is refreshed again and gains an ownerId.
    return { status: "unknown", evidenceRefs: refs, privateReason: "Semantic restriction owner is unknown" };
  }
  return { status: "safe", evidenceRefs: refs };
}

export const RequirementSchema = z.object({ id: z.string().min(1), requestId: z.string().min(1), name: z.string().min(1), quantity: z.number().positive(), unit: UnitSchema, eaterIds: z.array(z.string().min(1)).min(1), evidenceRefs: z.array(z.string().min(1)).min(1) }).strict();
export type Requirement = z.infer<typeof RequirementSchema>;
export const DraftProductSchema = z.object({ id: z.string().min(1), name: z.string().min(1), companyId: z.string().min(1), branchId: z.string().min(1), packageQuantity: z.number().positive(), packageUnit: z.enum(["g", "ml", "piece"]), priceCents: z.number().int().nonnegative(), available: z.boolean(), evidence: EvidenceSchema }).strict();
export type DraftProduct = z.infer<typeof DraftProductSchema>;
export type ProductSelection = { requirementId: string; product: DraftProduct };

/** Quantities must already be scaled to the request's servings; no required ingredient is dropped. */
export function calculateDraft(workspace: Workspace, input: Requirement[], selections: ProductSelection[], budgetCents: number | null): Draft {
  const requirements = input.map(item => RequirementSchema.parse(item));
  if (new Set(requirements.map(r => r.id)).size !== requirements.length) throw new Error("Duplicate requirement ID");
  if (new Set(selections.map(s => s.requirementId)).size !== selections.length) throw new Error("Duplicate selection");
  if (budgetCents !== null && (!Number.isSafeInteger(budgetCents) || budgetCents < 0)) throw new Error("Invalid budget");
  const blockers: Draft["blockers"] = [];
  const warnings: Draft["warnings"] = [];
  const warn = (requirement: Requirement, safety: Extract<SafetyResult, { status: "warn" }>) => {
    for (const recipientId of safety.recipientIds) warnings.push({ code: "dietary_unverified", requirementId: requirement.id, requirementName: requirement.name, recipientId, privateReason: safety.privateReason });
  };
  const groups = new Map<string, { product: DraftProduct; quantity: number; requirementIds: string[]; eaterIds: string[] }>();
  if (!requirements.length) blockers.push({ code: "empty" });
  for (const request of workspace.requests) if (!requirements.some(r => r.requestId === request.id)) blockers.push({ code: "missing", privateReason: "Request has no complete requirements" });
  for (const requirement of requirements) {
    const request = workspace.requests.find(r => r.id === requirement.requestId);
    if (!request || requirement.eaterIds.some(id => !request.eaterIds.includes(id)) || request.eaterIds.some(id => !requirement.eaterIds.includes(id))) throw new Error("Requirement eaters do not match request");
    const rules = effectiveRules(workspace, requirement.eaterIds);
    if (request.kind !== "product") {
      const sourceEvidence = requirement.evidenceRefs.map(ref => workspace.evidence.find(e => e.id === ref));
      const sourceSafety = sourceEvidence.map(e => e && e.source !== "product_details" ? evaluateEvidence(rules, e) : { status: "unknown" as const });
      const unsafe = sourceSafety.some(s => s.status === "unsafe");
      const unknown = sourceSafety.some(s => s.status === "unknown");
      if (unsafe || unknown) {
        blockers.push({ code: unsafe ? "unsafe" : "unknown", requirementId: requirement.id, privateReason: "Recipe ingredient evidence is unsafe or incomplete" }); continue;
      }
      for (const s of sourceSafety) if (s.status === "warn") warn(requirement, s);
    }
    if (workspace.artifacts.some(a => !a.valid && (a.id === requirement.id || a.evidenceRefs.some(ref => requirement.evidenceRefs.includes(ref))))) { blockers.push({ code: "unknown", requirementId: requirement.id, privateReason: "Dependency requires refresh" }); continue; }
    const selection = selections.find(s => s.requirementId === requirement.id);
    if (!selection) { blockers.push({ code: "missing", requirementId: requirement.id }); continue; }
    const product = DraftProductSchema.parse(selection.product);
    const identity = product.evidence.productIdentity;
    if (product.evidence.source !== "product_details" || !identity || identity.productId !== product.id || identity.companyId !== product.companyId || identity.branchId !== product.branchId) {
      blockers.push({ code: "unknown", requirementId: requirement.id, privateReason: "Composition evidence does not identify the selected catalog product" }); continue;
    }
    const safety = evaluateEvidence(rules, product.evidence);
    if (safety.status === "unsafe" || safety.status === "unknown") { blockers.push({ code: safety.status, requirementId: requirement.id, privateReason: safety.privateReason }); continue; }
    if (safety.status === "warn") warn(requirement, safety);
    if (!product.available) { blockers.push({ code: "unavailable", requirementId: requirement.id }); continue; }
    // Reuse the established unit mapping, but preserve required precision: the
    // legacy normalizer rounds quantities to milligrams and can underbuy a pack.
    const unitBasis = normalizeIngredient({ ...requirement, quantity: 1 });
    const normalized = { unit: unitBasis.unit, quantity: requirement.quantity * unitBasis.quantity };
    if (normalized.unit !== product.packageUnit) { blockers.push({ code: "units", requirementId: requirement.id }); continue; }
    const key = `${product.id}:${product.companyId}:${product.branchId}`;
    const prior = groups.get(key);
    if (prior && JSON.stringify(prior.product) !== JSON.stringify(product)) throw new Error("Conflicting product evidence or pricing");
    groups.set(key, { product, quantity: (prior?.quantity ?? 0) + normalized.quantity, requirementIds: [...(prior?.requirementIds ?? []), requirement.id], eaterIds: [...new Set([...(prior?.eaterIds ?? []), ...requirement.eaterIds])].sort() });
  }
  const lines = [...groups.values()].map(({ product, quantity, requirementIds, eaterIds }) => {
    const packageCount = Math.ceil(quantity / product.packageQuantity);
    return { productId: product.id, name: product.name, companyId: product.companyId, branchId: product.branchId, requirementIds: requirementIds.sort(), eaterIds, packageCount, packageQuantity: product.packageQuantity, packageUnit: product.packageUnit, unitPriceCents: product.priceCents, lineTotalCents: product.priceCents * packageCount };
  }).sort((a, b) => `${a.productId}:${a.companyId}:${a.branchId}`.localeCompare(`${b.productId}:${b.companyId}:${b.branchId}`));
  const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  if (budgetCents !== null && totalCents > budgetCents) blockers.push({ code: "budget" });
  const dedupedWarnings = [...new Map(warnings.map(w => [`${w.code}:${w.requirementId ?? ""}:${w.recipientId}`, w])).values()];
  return DraftSchema.parse({ inputRevision: workspace.inputRevision, lines, totalCents, ready: blockers.length === 0, blockers, warnings: dedupedWarnings });
}

export function publishDraft(workspace: Workspace, input: Draft, expectedInputRevision: number, expectedDraftRevision: number): Workspace {
  const draft = DraftSchema.parse(input);
  if (workspace.inputRevision !== expectedInputRevision || workspace.draftRevision !== expectedDraftRevision || draft.inputRevision !== workspace.inputRevision) throw new Error("Stale draft revision");
  if (JSON.stringify(workspace.draft) === JSON.stringify(draft)) return workspace;
  return { ...workspace, draftRevision: workspace.draftRevision + 1, draft };
}

/** Explicit allowlist: never spread workspace, context, evidence, outcomes or
 * private blockers. draft.warnings is deliberately never included here --
 * each warning names its own recipient and must only reach them, via a
 * private notice, never this shared projection. */
export function projectDraft(workspace: Workspace) {
  return { schemaVersion: 2 as const, partyId: workspace.partyId, inputRevision: workspace.inputRevision, draftRevision: workspace.draftRevision, ready: Boolean(workspace.draft?.ready && workspace.draft.inputRevision === workspace.inputRevision), lines: workspace.draft?.lines.map(line => ({ productId: line.productId, name: line.name, companyId: line.companyId, branchId: line.branchId, packageCount: line.packageCount, packageQuantity: line.packageQuantity, packageUnit: line.packageUnit, unitPriceCents: line.unitPriceCents, lineTotalCents: line.lineTotalCents, eaterIds: [...line.eaterIds] })) ?? [], totalCents: workspace.draft?.totalCents ?? 0, unresolvedCount: workspace.draft?.blockers.length ?? 0, blockerCodes: [...new Set(workspace.draft?.blockers.map(b => b.code) ?? [])] };
}
export type PublicDraft = ReturnType<typeof projectDraft>;
