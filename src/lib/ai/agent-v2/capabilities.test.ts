import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { deriveRecipeRequirements, deriveProductRequirement, validateGeneratedRecipe, parseSourceRecipe } from "./recipes";
import { fetchRecipePage, publicRecipeAddress } from "./recipe-fetch";
import { createWorkspace, applyRequestEdit } from "./state";
import { createCommerceState, selectKnownProduct, reviewCommerceDraft } from "./catalog";
import { createMcpCommerceAdapter, supportedContractFixture, CommerceError, retryRead } from "./commerce-contract";

const generated = { id: "recipe1", title: "Rice", origin: "generated", servings: 2, ingredients: [{ name: "Rice", quantity: 200, unit: "g", requiredAttributes: { color: "white" } }], steps: ["Boil rice."] };
const product = { productId: "rice", companyId: "co", branchId: "branch", name: "White rice", packageQuantity: 500, packageUnit: "g", priceCents: 100, available: true, stockPackages: 10, ingredients: ["rice"], composition: "rice", compositionComplete: true, attributes: { color: "white" } };
const snapshot = { cartId: "cart", companyId: "co", branchId: "branch", deliveryType: "SelfPickup", timeslotStart: "2026-09-14T10:00:00Z", timeslotEnd: "2026-09-14T11:00:00Z", lines: [], totalCents: 0, validationErrors: [] };
function adapter(overrides: Record<string, unknown> = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const outputs: Record<string, unknown> = { silpo_get_my_shopping_cart: { exists: true, shoppingCartId: "cart" }, silpo_get_shopping_cart_by_id: snapshot, silpo_get_time_slots: { slots: [{ start: snapshot.timeslotStart, end: snapshot.timeslotEnd, available: true }] }, silpo_find_products_batch: { products: [product] }, silpo_get_product_details: product, ...overrides };
  return { calls, api: createMcpCommerceAdapter(supportedContractFixture.tools, async input => { calls.push(input); return { structuredContent: outputs[input.name] }; }, { now: () => "2026-09-13T08:00:00.000Z" }) };
}

describe("complete recipe evidence", () => {
  it("requires every generated quantity, origin and preparation step", () => {
    expect(validateGeneratedRecipe(generated).origin).toBe("generated");
    for (const bad of [{ ...generated, steps: [] }, { ...generated, ingredients: [{ name: "rice" }] }, { ...generated, sourceUrl: "https://invented.test" }]) expect(() => validateGeneratedRecipe(bad)).toThrow();
  });
  it("does not drop unquantified source ingredients", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Recipe", name: "Rice", recipeYield: "2", recipeIngredient: ["200 g rice", "salt to taste"], recipeInstructions: ["Boil"] })}</script>`;
    expect(() => parseSourceRecipe(html, "https://example.com/rice")).toThrow(/complete/i);
  });
  it("scales all ingredients and assigns edit-specific dependency roots", () => {
    const w = applyRequestEdit(createWorkspace("party", ["host"]), "host", { kind: "add", requestId: "r", text: "rice", requestKind: "dish", servings: 3 });
    const result = deriveRecipeRequirements(w, "r", validateGeneratedRecipe(generated));
    expect(result.requirements[0].quantity).toBe(300);
    expect(result.artifacts[0].dependsOn).toEqual(["request:r:source"]);
    expect(result.artifacts[1].dependsOn).toEqual(expect.arrayContaining(["request:r:scaling", "request:r:eaters", "context:host"]));
  });
  it("preserves valid recipe artifact identity and version while rescaling", () => {
    let w = applyRequestEdit(createWorkspace("party", ["host"]), "host", { kind: "add", requestId: "r", text: "rice", requestKind: "dish", servings: 2 });
    const recipe = validateGeneratedRecipe(generated);
    const first = deriveRecipeRequirements(w, "r", recipe);
    w = applyRequestEdit({ ...w, artifacts: first.artifacts, evidence: first.evidence }, "host", { kind: "servings", requestId: "r", servings: 4 });
    const next = deriveRecipeRequirements(w, "r", recipe);
    expect(next.artifacts[0]).toEqual(first.artifacts[0]);
    expect(next.requirements[0].quantity).toBe(400);
  });
});

describe("bounded public source fetching", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.31.1.1", "169.254.1.1", "100.64.0.1", "192.0.2.1", "224.1.1.1", "::1", "::ffff:127.0.0.1"])("rejects reserved %s", address => expect(publicRecipeAddress(address)).toBe(false));
  it("rejects private DNS before transport and validates every redirect", async () => {
    const request = vi.fn(async () => ({ status: 302, location: "https://127.0.0.1/private", body: "" }));
    await expect(fetchRecipePage("https://example.com", { resolve: async () => ["10.0.0.1"], request })).rejects.toThrow(/public/i);
    expect(request).not.toHaveBeenCalled();
    await expect(fetchRecipePage("https://example.com", { resolve: async () => ["93.184.216.34"], request })).rejects.toThrow(/public/i);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects over-limit page bodies", async () => {
    await expect(fetchRecipePage("https://example.com", { resolve: async () => ["93.184.216.34"], request: async () => ({ status: 200, body: "x".repeat(1_048_577) }) })).rejects.toThrow(/large/i);
  });
});

describe("explicit MCP capabilities", () => {
  it("blocks unknown contracts before making calls", () => {
    const tools = structuredClone(supportedContractFixture.tools);
    tools[0].inputSchema = { type: "object", properties: { guess: { type: "string" } } };
    expect(() => createMcpCommerceAdapter(tools, async () => ({}))).toThrow(/contract/i);
  });
  it("validates selected slot after active cart and details", async () => {
    const { api, calls } = adapter({ silpo_get_time_slots: { slots: [{ start: "2026-09-14T12:00:00Z", end: "2026-09-14T13:00:00Z", available: true }] } });
    await expect(api.cart()).rejects.toThrow(/slot/i);
    expect(calls.map(c => c.name)).toEqual(["silpo_get_my_shopping_cart", "silpo_get_shopping_cart_by_id", "silpo_get_time_slots"]);
  });
  it("bounds batches and binds product evidence to identity and retrieval time", async () => {
    const { api, calls } = adapter();
    const cart = await api.cart();
    await expect(api.search(cart, Array(31).fill("rice"))).rejects.toThrow(/30/);
    const detail = await api.details(cart, "rice");
    expect(detail.evidence.productIdentity).toEqual({ productId: "rice", companyId: "co", branchId: "branch" });
    expect(detail.retrievedAt).toBe("2026-09-13T08:00:00.000Z");
    expect(calls.some(c => c.name === "silpo_find_products_batch")).toBe(false);
  });
  it("rejects a product response from another identity", async () => {
    const { api } = adapter({ silpo_get_product_details: { ...product, productId: "other" } });
    await expect(api.details(snapshot, "rice")).rejects.toThrow(/identity/i);
  });
  it("selects known IDs only, with required variant before price and missing evidence blocked", async () => {
    const { api } = adapter();
    const p = await api.details(snapshot, "rice");
    let w = applyRequestEdit(createWorkspace("party", ["host"]), "host", { kind: "add", requestId: "r", text: "rice", requestKind: "dish", servings: 3 });
    const derived = deriveRecipeRequirements(w, "r", validateGeneratedRecipe(generated));
    w = { ...w, evidence: derived.evidence, artifacts: derived.artifacts };
    const state = { ...createCommerceState(), requirements: derived.requirements, products: [p] };
    expect(() => selectKnownProduct(state, state.requirements[0].id, "imaginary")).toThrow(/known/i);
    expect(() => selectKnownProduct({ ...state, products: [{ ...p, attributes: { color: "brown" } }] }, state.requirements[0].id, "rice")).toThrow(/variant/i);
    const selected = selectKnownProduct(state, state.requirements[0].id, "rice");
    expect(reviewCommerceDraft(w, selected, null).ready).toBe(true);
    expect(reviewCommerceDraft(w, { ...selected, products: [{ ...p, evidence: { ...p.evidence, complete: false } }] }, null).ready).toBe(false);
  });
  it("limits transient reads to three attempts and honors Retry-After without busy retry", async () => {
    const delays: number[] = []; let attempts = 0;
    await expect(retryRead(async () => { attempts++; throw new CommerceError("transient", "busy", 2000); }, { sleep: async ms => { delays.push(ms); } })).rejects.toMatchObject({ code: "transient" });
    expect(attempts).toBe(3); expect(delays).toEqual([2000, 2000]);
  });
  it("blocks stale direct-product quantities after a request edit", async () => {
    const { api } = adapter();
    let workspace = applyRequestEdit(createWorkspace("party", ["host"]), "host", { kind: "add", requestId: "r", text: "Rice", requestKind: "product" });
    workspace = applyRequestEdit(workspace, "host", { kind: "quantity", requestId: "r", quantity: 200, unit: "g" });
    const p = await api.details(snapshot, "rice");
    const requirement = deriveProductRequirement(workspace, "r");
    const selected = selectKnownProduct({ ...createCommerceState(), requirements: [requirement], products: [p] }, requirement.id, "rice");
    expect(reviewCommerceDraft(workspace, selected, null).ready).toBe(true);
    workspace = applyRequestEdit(workspace, "host", { kind: "quantity", requestId: "r", quantity: 600, unit: "g" });
    expect(reviewCommerceDraft(workspace, selected, null).ready).toBe(false);
  });
});
