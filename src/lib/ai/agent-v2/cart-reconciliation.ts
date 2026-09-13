import "server-only";
import { z } from "zod";
import { CartSnapshotSchema, CartLineSchema, CartContextSchema, productKey, CommerceError, type CartSnapshot, type CartLine, type CommerceAdapter, type CatalogProduct } from "./commerce-contract";
import { CommerceStateSchema } from "./catalog";
import { evaluateEvidence } from "./draft";

const id = z.string().min(1);
const PublicLineSchema = z.object({ productId: id, companyId: id, branchId: id, name: id, packageCount: z.number().int().positive(), packageQuantity: z.number().positive(), packageUnit: z.enum(["g", "ml", "piece"]), unitPriceCents: z.number().int().nonnegative(), lineTotalCents: z.number().int().nonnegative(), eaterIds: z.array(id) }).strict();
export const ApprovedCartDraftSchema = z.object({ schemaVersion: z.literal(2), partyId: id, inputRevision: z.number().int().nonnegative(), draftRevision: z.number().int().positive(), ready: z.literal(true), lines: z.array(PublicLineSchema), totalCents: z.number().int().nonnegative(), unresolvedCount: z.literal(0), blockerCodes: z.array(z.string()).length(0) }).strict();
type Approved = z.infer<typeof ApprovedCartDraftSchema>;
const ChangeSchema = z.object({ kind: z.enum(["set", "remove"]), line: CartLineSchema }).strict();
export type CartChange = z.infer<typeof ChangeSchema>;
const ExpectedSchema = z.object({ snapshot: CartSnapshotSchema, managed: z.array(CartLineSchema) }).strict();
export const CartOperationSchema = z.object({ id, party_id: id, approved_by: id, draft_revision: z.number().int().positive(), approved_snapshot: ApprovedCartDraftSchema, approved_commerce: CommerceStateSchema.nullable(), status: z.enum(["approved", "applying", "verified", "failed", "unknown", "cancelled"]), worker_id: id.nullable(), cart_id: id.nullable(), baseline: CartSnapshotSchema.nullable(), expected_cart: ExpectedSchema.nullable(), intended_changes: z.array(ChangeSchema).nullable(), readback: CartSnapshotSchema.nullable(), previous_managed: z.array(CartLineSchema).default([]) });
export type CartOperation = z.infer<typeof CartOperationSchema>;
export interface CartOperationRepository {
  acquire(input: { operationId: string; actorId: string; workerId: string; cartId: string }): Promise<CartOperation>;
  prepare(input: { operationId: string; workerId: string; baseline: CartSnapshot; expectedCart: z.infer<typeof ExpectedSchema>; changes: CartChange[] }): Promise<void>;
  finish(input: { operationId: string; workerId: string; status: "verified" | "failed" | "unknown"; readback: CartSnapshot | null; privateError?: string }): Promise<void>;
  read(operationId: string, actorId: string): Promise<CartOperation>;
}
function sortLines(lines: CartLine[]): CartLine[] { return [...lines].sort((a, b) => productKey(a).localeCompare(productKey(b))); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function normalized(snapshot: CartSnapshot): CartSnapshot { return { ...CartSnapshotSchema.parse(snapshot), lines: sortLines(snapshot.lines) }; }
function context(snapshot: CartSnapshot) { return CartContextSchema.parse(Object.fromEntries(Object.keys(CartContextSchema.shape).map(k => [k, snapshot[k as keyof CartSnapshot]]))); }

/** Managed identities are owned wholly by this app. An external line with an
 * overlapping identity is a conflict; no guessed subtraction of user quantities. */
export function planCart(input: Approved, baselineInput: CartSnapshot, previous: CartLine[]) {
  const approved = ApprovedCartDraftSchema.parse(input);
  const baseline = normalized(baselineInput);
  if (baseline.validationErrors.length) throw new CommerceError("conflict", "Cart reports validation failures");
  const managed = approved.lines.map(l => CartLineSchema.parse({ productId: l.productId, companyId: l.companyId, branchId: l.branchId, quantity: l.packageCount, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents }));
  if (!managed.length || new Set(managed.map(productKey)).size !== managed.length || managed.reduce((sum, l) => sum + l.lineTotalCents, 0) !== approved.totalCents) throw new CommerceError("approval_required", "Invalid approved cart quantities or total");
  for (const line of previous) {
    const current = baseline.lines.find(l => productKey(l) === productKey(line));
    if (!current || current.quantity !== line.quantity || current.unitPriceCents !== line.unitPriceCents) throw new CommerceError("conflict", "External change to an app-managed line");
  }
  for (const line of managed) {
    if (line.companyId !== baseline.companyId || line.branchId !== baseline.branchId) throw new CommerceError("approval_required", "Approved store changed");
    if (baseline.lines.some(l => productKey(l) === productKey(line)) && !previous.some(l => productKey(l) === productKey(line))) throw new CommerceError("conflict", "External line overlaps approved product");
  }
  const external = baseline.lines.filter(l => !previous.some(p => productKey(p) === productKey(l)));
  const lines = sortLines([...external, ...managed]);
  const snapshot = CartSnapshotSchema.parse({ ...baseline, lines, totalCents: lines.reduce((sum, l) => sum + l.lineTotalCents, 0) });
  const changes: CartChange[] = [
    ...managed.filter(l => !baseline.lines.some(b => same(b, l))).map(line => ({ kind: "set" as const, line })),
    ...previous.filter(l => !managed.some(m => productKey(m) === productKey(l))).map(line => ({ kind: "remove" as const, line })),
  ];
  return { snapshot, managed: sortLines(managed), changes };
}
function compareProduct(approved: CatalogProduct, current: CatalogProduct, quantity: number) {
  // Retrieval time changes naturally; all decision evidence must remain exact.
  const fields = (p: CatalogProduct) => ({ id: p.id, companyId: p.companyId, branchId: p.branchId, packageQuantity: p.packageQuantity, packageUnit: p.packageUnit, priceCents: p.priceCents, available: p.available, attributes: p.attributes, evidence: p.evidence });
  if (!same(fields(approved), fields(current)) || !current.available || current.stockPackages === null || current.stockPackages < quantity || evaluateEvidence([], current.evidence).status !== "safe") throw new CommerceError("approval_required", "Product price, packaging, evidence or availability changed");
  const identity = current.evidence.productIdentity;
  if (!identity || current.evidence.source !== "product_details" || productKey(identity) !== productKey({ productId: current.id, companyId: current.companyId, branchId: current.branchId })) throw new CommerceError("approval_required", "Product identity evidence mismatch");
}
type ApplyInput = { operationId: string; actorId: string; workerId: string; signal?: AbortSignal };
export async function applyApprovedCart(input: ApplyInput, repository: CartOperationRepository, api: CommerceAdapter) {
  input.signal?.throwIfAborted();
  const baseline = normalized(await api.cart());
  const operation = CartOperationSchema.parse(await repository.acquire({ ...input, cartId: baseline.cartId }));
  if (operation.approved_by !== input.actorId) throw new CommerceError("approval_required", "Host authority required");
  if (operation.status === "verified") return { status: "verified" as const, readback: operation.readback };
  let wrote = false;
  let expected: CartSnapshot | null = null;
  try {
    const commerce = operation.approved_commerce;
    const approved = operation.approved_snapshot;
    if (!commerce?.cart || commerce.inputRevision !== approved.inputRevision || commerce.draftRevision !== approved.draftRevision || approved.draftRevision !== operation.draft_revision || approved.partyId !== operation.party_id || !same(context(commerce.cart), context(baseline))) throw new CommerceError("approval_required", "Approved commerce context or revision changed");
    const plan = planCart(approved, baseline, operation.previous_managed);
    for (let offset = 0; offset < approved.lines.length; offset += 3) {
      await Promise.all(approved.lines.slice(offset, offset + 3).map(async line => {
        const prior = commerce.products.find(p => productKey({ productId: p.id, companyId: p.companyId, branchId: p.branchId }) === productKey(line));
        if (!prior || prior.priceCents !== line.unitPriceCents || prior.packageQuantity !== line.packageQuantity || prior.packageUnit !== line.packageUnit) throw new CommerceError("approval_required", "Approved product evidence missing");
        compareProduct(prior, await api.details(baseline, line.productId), line.packageCount);
      }));
    }
    expected = normalized(plan.snapshot);
    await repository.prepare({ operationId: input.operationId, workerId: input.workerId, baseline, expectedCart: { snapshot: expected, managed: plan.managed }, changes: plan.changes });
    let progress = baseline;
    // Each remote write is preceded by readback of all current lines. MCP has no
    // cart CAS, so a remote edit racing after this read remains a transport limit.
    for (const kind of ["set", "remove"] as const) {
      const changes = plan.changes.filter(c => c.kind === kind);
      for (let offset = 0; offset < changes.length; offset += 30) {
        input.signal?.throwIfAborted();
        const before = normalized(await api.cart());
        if (!same(before, progress)) throw new CommerceError("conflict", "External cart change before write");
        const lines = changes.slice(offset, offset + 30).map(c => c.line);
        wrote = true; // Set before dispatch; timeouts cannot prove rejection.
        if (kind === "set") await api.setQuantities(baseline, lines); else await api.remove(baseline, lines);
        const next = [...progress.lines.filter(l => !lines.some(c => productKey(c) === productKey(l))), ...(kind === "set" ? lines : [])];
        progress = normalized({ ...progress, lines: next, totalCents: next.reduce((sum, l) => sum + l.lineTotalCents, 0) });
        const after = normalized(await api.cart());
        if (!same(after, progress)) throw new CommerceError("unknown_write", "Cart readback differs from intended progress");
      }
    }
    const readback = normalized(await api.cart());
    if (!same(readback, expected)) throw new CommerceError("unknown_write", "Cart additions, removals, totals or validation failed verification");
    await repository.finish({ operationId: input.operationId, workerId: input.workerId, status: "verified", readback });
    return { status: "verified" as const, readback };
  } catch (error) {
    if (!wrote) {
      await repository.finish({ operationId: input.operationId, workerId: input.workerId, status: "failed", readback: null, privateError: error instanceof CommerceError ? error.code : "preflight_failed" });
      throw error;
    }
    let readback: CartSnapshot | null = null;
    try { readback = normalized(await api.cart()); } catch { /* Keep operation lock. */ }
    const status = expected && readback && same(readback, expected) ? "verified" as const : "unknown" as const;
    await repository.finish({ operationId: input.operationId, workerId: input.workerId, status, readback, privateError: status === "unknown" ? "write_requires_reconciliation" : undefined });
    return { status, readback };
  }
}

/** Read-only recovery: even baseline readback cannot exclude a write in flight. */
export async function reconcileCartOperation(input: ApplyInput, repository: CartOperationRepository, api: CommerceAdapter) {
  const op = CartOperationSchema.parse(await repository.read(input.operationId, input.actorId));
  if (op.approved_by !== input.actorId || op.worker_id !== input.workerId) throw new CommerceError("approval_required", "Original cart writer and Host authority required");
  if (op.status === "verified") return { status: "verified" as const, readback: op.readback };
  if (!["unknown", "applying"].includes(op.status) || !op.expected_cart) throw new CommerceError("conflict", "Operation has no prepared recovery plan");
  input.signal?.throwIfAborted();
  const readback = normalized(await api.cart());
  const status = same(readback, op.expected_cart.snapshot) ? "verified" as const : "unknown" as const;
  await repository.finish({ operationId: input.operationId, workerId: input.workerId, status, readback, privateError: status === "unknown" ? "write_requires_reconciliation" : undefined });
  return { status, readback };
}
