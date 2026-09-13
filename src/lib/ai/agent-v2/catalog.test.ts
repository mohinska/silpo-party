import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createWorkspace, applyRequestEdit } from "./state";
import { createCommerceState, searchRequirement, summarizeProduct } from "./catalog";
import { deriveProductRequirement } from "./recipes";
import { createMcpCommerceAdapter, supportedContractFixture } from "./commerce-contract";

const product = { productId: "rice", companyId: "co", branchId: "branch", name: "White rice", packageQuantity: 500, packageUnit: "g", priceCents: 100, available: true, stockPackages: 10, ingredients: ["rice"], composition: "rice", compositionComplete: true, attributes: { color: "white" } };
const snapshot = { cartId: "cart", cartVersion: "v1", companyId: "co", branchId: "branch", deliveryType: "SelfPickup", timeslotStart: "2026-09-14T10:00:00Z", timeslotEnd: "2026-09-14T11:00:00Z", lines: [], totalCents: 0, validationErrors: [] };
function adapter(overrides: Record<string, unknown> = {}) {
  const outputs: Record<string, unknown> = { silpo_get_my_shopping_cart: { exists: true, shoppingCartId: "cart" }, silpo_get_shopping_cart_by_id: snapshot, silpo_get_time_slots: { slots: [{ start: snapshot.timeslotStart, end: snapshot.timeslotEnd, available: true }] }, silpo_find_products_batch: { products: [product] }, silpo_get_product_details: product, ...overrides };
  return createMcpCommerceAdapter(supportedContractFixture.tools, async input => ({ structuredContent: outputs[input.name] }));
}
function requirement() {
  let w = applyRequestEdit(createWorkspace("party", ["host"]), "host", { kind: "add", requestId: "r", text: "Rice", requestKind: "product" });
  w = applyRequestEdit(w, "host", { kind: "quantity", requestId: "r", quantity: 500, unit: "g" });
  return deriveProductRequirement(w, "r");
}

describe("searchRequirement", () => {
  it("returns only this call's freshly-inspected candidates, not the whole accumulated product set", async () => {
    const stale = await adapter({ silpo_get_product_details: { ...product, productId: "stale", name: "Stale rice" } }).details(snapshot, "stale");
    const req = requirement();
    const state = { ...createCommerceState(), requirements: [req], products: [stale] };
    const { state: next, matched, limitReached } = await searchRequirement(state, req.id, ["рис"], adapter());
    expect(limitReached).toBe(false);
    expect(matched.map(p => p.id)).toEqual(["rice"]);
    expect(next.products.map(p => p.id).sort()).toEqual(["rice", "stale"]);
  });

  it("returns limitReached without throwing once the revision cap is hit, and does not increment further", async () => {
    const req = requirement();
    const state = { ...createCommerceState(), requirements: [req], searchRevisions: { [req.id]: 3 } };
    const result = await searchRequirement(state, req.id, ["рис"], adapter());
    expect(result.limitReached).toBe(true);
    expect(result.matched).toEqual([]);
    expect(result.state.searchRevisions[req.id]).toBe(3);
  });

  it("still throws for an unknown requirement id", async () => {
    await expect(searchRequirement(createCommerceState(), "missing", ["рис"], adapter())).rejects.toThrow(/unknown|requirement/i);
  });
});

describe("summarizeProduct", () => {
  it("maps the compact model-visible shape and excludes evidence/composition", async () => {
    const detail = await adapter().details(snapshot, "rice");
    const summary = summarizeProduct(detail);
    expect(summary).toEqual({ productId: "rice", name: "White rice", priceCents: 100, packageQuantity: 500, packageUnit: "g", available: true, stockPackages: 10, attributes: { color: "white" } });
    expect(JSON.stringify(summary)).not.toContain("evidence");
    expect(JSON.stringify(summary)).not.toContain("composition");
  });
});
