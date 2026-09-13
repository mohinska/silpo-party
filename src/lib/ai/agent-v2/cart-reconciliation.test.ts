import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { applyApprovedCart, reconcileCartOperation, planCart, type CartOperation, type CartOperationRepository } from "./cart-reconciliation";
import type { CartSnapshot, CommerceAdapter } from "./commerce-contract";

const context = { cartId: "cart", cartVersion: "v1", companyId: "co", branchId: "branch", deliveryType: "SelfPickup", timeslotStart: "2026-09-14T10:00:00Z", timeslotEnd: "2026-09-14T11:00:00Z" };
const rice = { productId: "rice", companyId: "co", branchId: "branch", quantity: 2, unitPriceCents: 100, lineTotalCents: 200 };
const external = { ...rice, productId: "external", quantity: 1, lineTotalCents: 100 };
const empty: CartSnapshot = { ...context, lines: [external], totalCents: 100, validationErrors: [] };
const product = { id: "rice", companyId: "co", branchId: "branch", name: "Rice", packageQuantity: 500, packageUnit: "g" as const, priceCents: 100, available: true, stockPackages: 10, attributes: {}, retrievedAt: "2026-09-13T08:00:00Z", evidence: { id: "e", source: "product_details" as const, sourceRef: "rice", productIdentity: { productId: "rice", companyId: "co", branchId: "branch" }, complete: true, ingredients: ["rice"], composition: "rice", verified: true } };
const approved = { schemaVersion: 2 as const, partyId: "party", inputRevision: 1, draftRevision: 2, ready: true as const, totalCents: 200, unresolvedCount: 0 as const, blockerCodes: [], lines: [{ productId: "rice", companyId: "co", branchId: "branch", name: "Rice", packageCount: 2, packageQuantity: 500, packageUnit: "g" as const, unitPriceCents: 100, lineTotalCents: 200, eaterIds: ["host"] }] };
function fixture(mode: "ok" | "timeout-applied" | "timeout-pending" = "ok") {
  let cart = structuredClone(empty); let writes = 0; let prepared = false; const writeVersions: string[] = [];
  let op: CartOperation = { id: "op", party_id: "party", approved_by: "host", draft_revision: 2, approved_snapshot: structuredClone(approved), approved_commerce: { schemaVersion: 1, inputRevision: 1, draftRevision: 2, cart: structuredClone(empty), requirements: [], products: [structuredClone(product)], selections: [], searchRevisions: {} }, status: "approved", worker_id: null, cart_id: null, baseline: null, expected_cart: null, intended_changes: null, readback: null, previous_managed: [] };
  const repository: CartOperationRepository = {
    async acquire(input) { if (input.actorId !== "host") throw new Error("Host authority required"); if (op.status === "verified") return structuredClone(op); if (op.status !== "approved") throw new Error("already acquired"); op = { ...op, status: "applying", worker_id: input.workerId, cart_id: input.cartId }; return structuredClone(op); },
    async prepare(input) { prepared = true; op = { ...op, baseline: input.baseline, expected_cart: input.expectedCart, intended_changes: input.changes }; },
    async finish(input) { op = { ...op, status: input.status, readback: input.readback }; },
    async read() { return structuredClone(op); },
  };
  const api: CommerceAdapter = {
    async cart() { return structuredClone(cart); }, async details() { return structuredClone(product); }, async search() { return []; }, async substitutions() { return []; },
    async setQuantities(ctx, lines) { if (!prepared) throw new Error("write before persistence"); writeVersions.push(ctx.cartVersion); writes++; if (mode !== "timeout-pending") { cart.lines = [...cart.lines.filter(l => !lines.some(x => x.productId === l.productId)), ...lines]; cart.totalCents = cart.lines.reduce((sum, l) => sum + l.lineTotalCents, 0); cart.cartVersion = `v${writes + 1}`; } if (mode !== "ok") throw new Error("timeout"); },
    async remove(ctx, lines) { writeVersions.push(ctx.cartVersion); writes++; cart.lines = cart.lines.filter(l => !lines.some(x => x.productId === l.productId)); cart.totalCents = cart.lines.reduce((sum, l) => sum + l.lineTotalCents, 0); cart.cartVersion = `v${writes + 1}`; },
  };
  return { repository, api, writes: () => writes, writeVersions: () => writeVersions, op: () => op, mutateOperation: (f: (o: CartOperation) => void) => f(op), setCart: (c: CartSnapshot) => { cart = c; } };
}
const applyInput = { operationId: "op", actorId: "host", workerId: "worker" };
describe("immutable approved cart reconciliation", () => {
  it("preserves external lines, sets exact absolute quantities and verifies duplicate applications", async () => {
    const f = fixture();
    expect((await applyApprovedCart(applyInput, f.repository, f.api)).status).toBe("verified");
    expect(f.op().readback?.lines).toEqual([external, rice]);
    expect((await applyApprovedCart(applyInput, f.repository, f.api)).status).toBe("verified");
    expect(f.writes()).toBe(1);
  });
  it("conflicts on external ownership or edits to a previously managed quantity", () => {
    expect(() => planCart(approved, { ...empty, lines: [rice], totalCents: 200 }, [])).toThrow(/external/i);
    expect(() => planCart(approved, { ...empty, lines: [{ ...rice, quantity: 3, lineTotalCents: 300 }], totalCents: 300 }, [rice])).toThrow(/external/i);
  });
  it("removes app-owned stale lines and retains unrelated external items", () => {
    const old = { ...rice, productId: "old" };
    const plan = planCart(approved, { ...empty, lines: [external, old], totalCents: 300 }, [old]);
    expect(plan.changes).toEqual([{ kind: "set", line: rice }, { kind: "remove", line: old }]);
    expect(plan.snapshot.lines).toEqual([external, rice]);
  });
  it("uses each readback version for split conditional sets and the following removal", async () => {
    const f = fixture();
    const old = { ...rice, productId: "old", quantity: 1, lineTotalCents: 100 };
    const lines = Array.from({ length: 31 }, (_, index) => ({ ...approved.lines[0], productId: `rice-${index}`, name: `Rice ${index}`, packageCount: 1, lineTotalCents: 100 }));
    const products = lines.map(line => ({ ...product, id: line.productId, evidence: { ...product.evidence, id: `e:${line.productId}`, sourceRef: line.productId, productIdentity: { productId: line.productId, companyId: "co", branchId: "branch" } } }));
    f.setCart({ ...empty, lines: [external, old], totalCents: 200 });
    f.mutateOperation(operation => {
      operation.previous_managed = [old];
      operation.approved_snapshot = { ...approved, lines, totalCents: 3100 };
      operation.approved_commerce = { ...operation.approved_commerce!, cart: { ...empty, lines: [external, old], totalCents: 200 }, products };
    });
    f.api.details = async (_cart, productId) => structuredClone(products.find(product => product.id === productId)!);
    expect((await applyApprovedCart(applyInput, f.repository, f.api)).status).toBe("verified");
    expect(f.writeVersions()).toEqual(["v1", "v2", "v3"]);
  });
  it.each(["host", "price", "slot", "missing approval context", "stale approval"])("blocks %s changes before writes", async condition => {
    const f = fixture();
    if (condition === "price") f.api.details = async () => ({ ...product, priceCents: 101 });
    if (condition === "slot") f.setCart({ ...empty, timeslotStart: "2026-09-14T12:00:00Z" });
    if (condition === "missing approval context") f.mutateOperation(o => { o.approved_commerce = null; });
    if (condition === "stale approval") f.repository.acquire = async () => { throw new Error("Exact current ready draft required"); };
    await expect(applyApprovedCart({ ...applyInput, actorId: condition === "host" ? "member" : "host" }, f.repository, f.api)).rejects.toThrow();
    expect(f.writes()).toBe(0);
  });
  it("recognizes a timeout that applied without repeating the write", async () => {
    const f = fixture("timeout-applied");
    expect((await applyApprovedCart(applyInput, f.repository, f.api)).status).toBe("verified");
    expect(f.writes()).toBe(1);
  });
  it("retains unknown when readback still equals baseline; recovery never retries writes", async () => {
    const f = fixture("timeout-pending");
    expect((await applyApprovedCart(applyInput, f.repository, f.api)).status).toBe("unknown");
    expect((await reconcileCartOperation(applyInput, f.repository, f.api)).status).toBe("unknown");
    expect(f.writes()).toBe(1);
    f.setCart({ ...empty, lines: [external, rice], totalCents: 300 });
    expect((await reconcileCartOperation(applyInput, f.repository, f.api)).status).toBe("verified");
    expect(f.writes()).toBe(1);
  });
});
