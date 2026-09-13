import "server-only";
import { z } from "zod";
import { calculateDraft, DraftProductSchema } from "./draft";
import { type Workspace } from "./state";
import { CommerceRequirementSchema } from "./recipes";
import { CatalogProductSchema, CartSnapshotSchema, productKey, type CommerceReadAdapter, type CatalogProduct } from "./commerce-contract";

export const CommerceStateSchema = z.object({ schemaVersion: z.literal(1), inputRevision: z.number().int().nonnegative(), draftRevision: z.number().int().nonnegative(), cart: CartSnapshotSchema.nullable(), requirements: z.array(CommerceRequirementSchema), products: z.array(CatalogProductSchema), selections: z.array(z.object({ requirementId: z.string(), productKey: z.string() }).strict()), searchRevisions: z.record(z.string(), z.number().int().min(0).max(3)) }).strict();
export type CommerceState = z.infer<typeof CommerceStateSchema>;
export function createCommerceState(): CommerceState { return { schemaVersion: 1, inputRevision: 0, draftRevision: 0, cart: null, requirements: [], products: [], selections: [], searchRevisions: {} }; }
/** Call after publishDraft and persist this value at checkpoint.commerce atomically. */
export function bindCommerceRevision(state: CommerceState, workspace: Workspace): CommerceState {
  return CommerceStateSchema.parse({ ...state, inputRevision: workspace.inputRevision, draftRevision: workspace.draftRevision });
}
const key = (p: CatalogProduct) => productKey({ productId: p.id, companyId: p.companyId, branchId: p.branchId });
function variantMatches(required: Record<string, string>, p: CatalogProduct) {
  return Object.entries(required).every(([attribute, value]) => p.attributes[attribute]?.normalize("NFKC").toLowerCase() === value.normalize("NFKC").toLowerCase());
}
export function selectKnownProduct(input: CommerceState, requirementId: string, productId: string): CommerceState {
  const state = CommerceStateSchema.parse(input);
  const requirement = state.requirements.find(r => r.id === requirementId);
  const matches = state.products.filter(p => p.id === productId && (!state.cart || (p.companyId === state.cart.companyId && p.branchId === state.cart.branchId)));
  if (!requirement || matches.length !== 1) throw new Error("Select one known requirement and product identity");
  if (!variantMatches(requirement.requiredAttributes, matches[0])) throw new Error("Required variant evidence missing or mismatched");
  return { ...state, selections: [...state.selections.filter(s => s.requirementId !== requirementId), { requirementId, productKey: key(matches[0]) }] };
}
export function reviewCommerceDraft(workspace: Workspace, input: CommerceState, budgetCents: number | null) {
  const state = CommerceStateSchema.parse(input);
  const selections = state.selections.flatMap(s => {
    const p = state.products.find(p => key(p) === s.productKey);
    const r = state.requirements.find(r => r.id === s.requirementId);
    if (!p || !r || !variantMatches(r.requiredAttributes, p)) return [];
    return [{ requirementId: s.requirementId, product: DraftProductSchema.parse(Object.fromEntries(Object.keys(DraftProductSchema.shape).map(k => [k, p[k as keyof CatalogProduct]]))) }];
  });
  const draft = calculateDraft(workspace, state.requirements.map(r => ({ id: r.id, requestId: r.requestId, name: r.name, quantity: r.quantity, unit: r.unit, eaterIds: r.eaterIds, evidenceRefs: r.evidenceRefs })), selections, budgetCents);
  for (const requirement of state.requirements) {
    const request = workspace.requests.find(r => r.id === requirement.requestId);
    if (request?.kind === "product" && (requirement.quantity !== request.quantity || requirement.unit !== request.unit || requirement.name !== request.text)) draft.blockers.push({ code: "unknown", requirementId: requirement.id, privateReason: "Direct product requirement requires refresh" });
  }
  for (const line of draft.lines) {
    const p = state.products.find(p => key(p) === productKey(line));
    if (!p || p.stockPackages === null || p.stockPackages < line.packageCount) draft.blockers.push({ code: "unavailable", privateReason: "Sufficient stock is not verified" });
  }
  draft.ready = draft.blockers.length === 0;
  return draft;
}
/** Returns a serializable replacement for the runtime checkpoint's commerce field. */
export async function searchRequirement(input: CommerceState, requirementId: string, queries: string[], api: CommerceReadAdapter, substitutionsFor?: string): Promise<CommerceState> {
  const state = CommerceStateSchema.parse(input);
  const requirement = state.requirements.find(r => r.id === requirementId);
  if (!requirement || (state.searchRevisions[requirementId] ?? 0) >= 3) throw new Error("Requirement search revision limit reached");
  const cart = await api.cart();
  const found = substitutionsFor ? await api.substitutions(cart, substitutionsFor) : await api.search(cart, queries);
  const candidates = found.filter(p => p.companyId === cart.companyId && p.branchId === cart.branchId).slice(0, 30);
  const inspected: CatalogProduct[] = [];
  for (let offset = 0; offset < candidates.length; offset += 3) {
    inspected.push(...await Promise.all(candidates.slice(offset, offset + 3).map(p => api.details(cart, p.productId))));
  }
  const products = [...new Map([...state.products, ...inspected].map(p => [key(p), p])).values()];
  return { ...state, cart, products, searchRevisions: { ...state.searchRevisions, [requirementId]: (state.searchRevisions[requirementId] ?? 0) + 1 } };
}
