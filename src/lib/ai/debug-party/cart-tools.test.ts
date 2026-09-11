import { describe, expect, it, vi } from "vitest";
import { createLocalCartTools, rankCandidates } from "./cart-tools";
import { DebugPartyRepository, type DebugPartyPersistencePort } from "./repository";
import type { DebugProductEvidence } from "./schemas";
import type { HostCatalogAdapter, SilpoVerifiedProduct } from "../../silpo/cart";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const mcp = vi.hoisted(() => ({ withSilpoMcp: vi.fn() }));
vi.mock("@/lib/silpo/mcp", async () => ({ ...await import("../../silpo/tool-data"), ...mcp }));

const now = "2026-09-10T12:00:00.000Z";
const product = (productId = "milk", discountCents: number | null = null): SilpoVerifiedProduct => ({
  productId, companyId: "company", branchId: "branch", name: `Milk ${productId}`, unit: "1 л",
  unitPriceCents: 6000, discountCents, imageUrl: null, available: true,
});
const dbRow = (input: object) => Object.fromEntries(Object.entries(input).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]));

function setup(products = [product()]) {
  let revision = 2;
  const evidence = new Map<string, object>();
  const items: Record<string, unknown>[] = [];
  const member = { party_id: "party", participant_id: "host", role: "host", context_status: "ready", joined_at: now, updated_at: now };
  const calls: string[] = [];
  const persistence: DebugPartyPersistencePort = {
    findWorkspace: async () => ({
      party: { id: "party", code: "ABCDEFGH", host_id: "host", budget_cents: 10000, status: "running", cart_revision: revision, created_at: now, updated_at: now },
      members: [member], intents: [], contexts: [], cartItems: items,
    }),
    findMembership: async (_partyId, actorId) => actorId === "host" ? member : null,
    insertRun: async () => null, insertToolEvent: async () => null, upsertContext: async () => null, updateRun: async () => null,
    insertEvidence: async ({ evidence: entry }) => { const row = dbRow(entry); evidence.set(entry.id, row); return row; },
    findEvidence: async ({ evidenceId }) => evidence.get(evidenceId) ?? null,
    advanceCartRevision: async ({ expectedRevision, mutation }) => {
      if (expectedRevision !== revision) return { status: "stale", currentRevision: revision };
      revision += 1;
      const itemId = "itemId" in mutation ? mutation.itemId : `item-${revision}`;
      const index = items.findIndex((item) => item.id === itemId);
      if (mutation.type === "remove") items.splice(index, 1);
      else if (mutation.type === "quantity") items[index].quantity = mutation.quantity;
      else {
        const row = evidence.get(mutation.evidenceId)!;
        const fields = Object.fromEntries(Object.entries(row).filter(([key]) => !["run_id", "source", "available"].includes(key)));
        const item = { ...fields, id: itemId, evidence_id: mutation.evidenceId, quantity: mutation.quantity, introduced_revision: revision, updated_at: now };
        if (index === -1) items.push(item); else items[index] = item;
      }
      return { status: "applied", currentRevision: revision, itemId };
    },
  };
  const repository = new DebugPartyRepository(persistence);
  const catalogAdapter: HostCatalogAdapter = async (hostId, operation) => {
    calls.push(hostId);
    return operation({ search: async () => products, inspect: async (id) => products.filter((entry) => entry.productId === id) });
  };
  const tools = createLocalCartTools({ partyId: "party", code: "ABCDEFGH", actorId: "host", hostId: "host", runId: "run", repository, catalogAdapter, now: () => new Date(now) });
  return { tools, evidence, items, calls, repository, persistence };
}

describe("verified local cart tools", () => {
  it("persists at most twelve bounded search results with server run/time provenance", async () => {
    const fixture = setup(Array.from({ length: 50 }, (_, i) => product(`p${i}`)));
    const result = await fixture.tools.searchProducts.execute({ query: "milk" });
    expect(result.products).toHaveLength(12);
    expect(fixture.evidence.size).toBe(12);
    expect([...fixture.evidence.values()][0]).toMatchObject({ party_id: "party", run_id: "run", observed_at: now, source: "catalog_search" });
    expect(result.products[0]).toMatchObject({ productId: "p0", unitPriceCents: 6000, discounted: false, available: true });
    expect(fixture.calls).toEqual(["host"]);
    expect(JSON.stringify(result)).not.toMatch(/run_id|raw|access_token/);
  });

  it("rejects fabricated, foreign-run, expired and unavailable evidence for add and replace", async () => {
    const fixture = setup();
    await expect(fixture.tools.addProduct.execute({ evidenceId: "invented", quantity: 1, expectedRevision: 2 })).rejects.toThrow(/verified/i);
    await expect(fixture.tools.replaceProduct.execute({ itemId: "invented", evidenceId: "invented", quantity: 1, expectedRevision: 2 })).rejects.toThrow();
    const { products } = await fixture.tools.searchProducts.execute({ query: "milk" });
    const id = products[0].evidenceId;
    const original = fixture.evidence.get(id)!;
    for (const patch of [{ run_id: "other" }, { party_id: "other" }, { observed_at: "2026-09-09T12:00:00.000Z" }, { available: false }]) {
      fixture.evidence.set(id, { ...original, ...patch });
      await expect(fixture.tools.addProduct.execute({ evidenceId: id, quantity: 1, expectedRevision: 2 })).rejects.toThrow(/verified/i);
    }
    expect(fixture.items).toEqual([]);
  });

  it("applies local add, replace, quantity and remove using verified item IDs and revisions", async () => {
    const fixture = setup([product("a"), product("b")]);
    const { products } = await fixture.tools.searchProducts.execute({ query: "milk" });
    const added = await fixture.tools.addProduct.execute({ evidenceId: products[0].evidenceId, quantity: 2, expectedRevision: 2 });
    expect(added).toMatchObject({ status: "applied", revision: 3, items: [{ productId: "a", quantity: 2 }] });
    const itemId = added.items[0].id;
    const replaced = await fixture.tools.replaceProduct.execute({ itemId, evidenceId: products[1].evidenceId, quantity: 1, expectedRevision: 3 });
    expect(replaced).toMatchObject({ revision: 4, items: [{ productId: "b", quantity: 1 }] });
    expect(await fixture.tools.setQuantity.execute({ itemId, quantity: 3, expectedRevision: 4 })).toMatchObject({ revision: 5, totalCents: 18000 });
    expect(await fixture.tools.removeProduct.execute({ itemId, expectedRevision: 5 })).toMatchObject({ revision: 6, items: [] });
    await expect(fixture.tools.setQuantity.execute({ itemId, quantity: 1, expectedRevision: 6 })).rejects.toThrow(/item/i);
    expect(fixture.calls).toHaveLength(1);
  });

  it("returns fresh cart state for stale commands including items removed since the caller read", async () => {
    const fixture = setup();
    const { products } = await fixture.tools.searchProducts.execute({ query: "milk" });
    await fixture.tools.addProduct.execute({ evidenceId: products[0].evidenceId, quantity: 1, expectedRevision: 2 });
    const stale = await fixture.tools.removeProduct.execute({ itemId: "old-item", expectedRevision: 2 });
    expect(stale).toMatchObject({ status: "stale", revision: 3, items: [{ productId: "milk" }] });
    expect(fixture.items).toHaveLength(1);
  });

  it("checks strict inputs, membership, party state, and trusted Host identity before opening MCP", async () => {
    const fixture = setup();
    await expect(fixture.tools.searchProducts.execute({ query: "milk", hostId: "other" } as never)).rejects.toThrow();
    await expect(fixture.tools.addProduct.execute({ evidenceId: "id", quantity: 0, expectedRevision: 2 })).rejects.toThrow();
    const foreign = createLocalCartTools({ partyId: "party", code: "ABCDEFGH", actorId: "outsider", hostId: "host", runId: "run", repository: fixture.repository });
    await expect(foreign.inspectCart.execute({})).rejects.toThrow();
    const wrongHost = createLocalCartTools({ partyId: "party", code: "ABCDEFGH", actorId: "host", hostId: "other", runId: "run", repository: fixture.repository });
    await expect(wrongHost.searchProducts.execute({ query: "milk" })).rejects.toThrow(/Host/i);
    expect(fixture.calls).toEqual([]);
  });

  it("ranks live discounted previous products, other suitable previous products, then catalog", () => {
    const base = { ...product(), id: "catalog", partyId: "party", runId: "run", source: "catalog_search", observedAt: now, createdAt: now } as DebugProductEvidence;
    const catalog = { ...base, suitable: true };
    const prior = { ...base, id: "prior", source: "recent_purchase" as const, suitable: true };
    const discountedPrior = { ...prior, id: "discounted", discountCents: 1000 };
    const unsuitable = { ...discountedPrior, id: "unsafe", suitable: false };
    expect(rankCandidates([catalog, prior, unsuitable, discountedPrior]).map((p) => p.id)).toEqual(["discounted", "prior", "catalog"]);
  });

  it("inspects and compares only persisted evidence and completes with compact current state", async () => {
    const fixture = setup([product("a"), product("b", 500)]);
    const inspected = await fixture.tools.inspectProduct.execute({ productId: "a" });
    expect(inspected.products[0]).toMatchObject({ productId: "a", available: true });
    const searched = await fixture.tools.searchProducts.execute({ query: "milk" });
    const compared = await fixture.tools.compareAlternatives.execute({ evidenceIds: searched.products.map((entry) => entry.evidenceId) });
    expect(compared.products.map((p) => p.productId)).toEqual(["a", "b"]);
    await expect(fixture.tools.compareAlternatives.execute({ evidenceIds: ["invented"] })).rejects.toThrow(/verified/i);
    expect(await fixture.tools.complete.execute({ reply: "Кошик готовий." })).toMatchObject({ completed: true, reply: "Кошик готовий.", revision: 2 });
    expect(Object.keys(fixture.tools)).toEqual(["inspectCart", "searchProducts", "inspectProduct", "compareAlternatives", "addProduct", "replaceProduct", "setQuantity", "removeProduct", "complete"]);
  });

  it("repository refuses evidence reads and writes without membership", async () => {
    const fixture = setup();
    const { products } = await fixture.tools.searchProducts.execute({ query: "milk" });
    const entry = await fixture.repository.findEvidence({ partyId: "party", actorId: "host", evidenceId: products[0].evidenceId });
    expect(entry).toMatchObject({ productId: "milk", runId: "run" });
    await expect(fixture.repository.findEvidence({ partyId: "party", actorId: "outsider", evidenceId: products[0].evidenceId })).rejects.toThrow();
    await expect(fixture.repository.saveEvidence({ partyId: "party", actorId: "outsider", evidence: entry! })).rejects.toThrow();
  });
});

describe("Host catalog read adapter", () => {
  it("uses only advertised reads and retains verified price, discount, availability and store identity", async () => {
    const calls: string[] = [];
    const entries = [
      ["silpo_get_my_shopping_cart", {}], ["silpo_get_shopping_cart_by_id", { cartId: { type: "string" } }],
      ["silpo_get_time_slots", {}], ["silpo_find_products_batch", { queries: { type: "array", items: { type: "string" } } }],
      ["silpo_get_product_by_id", { productId: { type: "string" } }], ["silpo_add_products", {}],
    ] as const;
    const tools = new Map(entries.map(([name, properties]) => [name, { name, inputSchema: { type: "object", properties } }]));
    // Catalog search is an allowlisted server-side read even when the upstream
    // MCP advertises an overly conservative mutability annotation.
    (tools.get("silpo_find_products_batch")! as { annotations?: { readOnlyHint?: boolean } }).annotations = { readOnlyHint: false };
    mcp.withSilpoMcp.mockImplementation(async (hostId, operation) => {
      expect(hostId).toBe("host");
      return operation({ callTool: async ({ name }: { name: string }) => {
        calls.push(name);
        if (name === "silpo_get_my_shopping_cart") return { structuredContent: { cartId: "cart" } };
        if (name === "silpo_get_shopping_cart_by_id") return { structuredContent: { branchId: "branch", companyId: "company", deliveryType: "pickup", timeslotStart: now, timeslotEnd: now } };
        if (name === "silpo_get_time_slots") return {};
        return { structuredContent: { products: [
          { id: "milk", name: "Milk", price: 50, oldPrice: 60, unit: "1 л", available: true, token: "secret" },
          { id: "unverified", name: "No availability", price: 50, unit: "piece" },
        ] } };
      } }, tools);
    });
    const { withSilpoCatalogReader } = await import("../../silpo/cart");
    const result = await withSilpoCatalogReader("host", async (reader) => ({ searched: await reader.search("milk"), inspected: await reader.inspect("milk") }));
    expect(result.searched).toEqual([{ productId: "milk", companyId: "company", branchId: "branch", name: "Milk", unit: "1 л", unitPriceCents: 5000, discountCents: 1000, imageUrl: null, available: true }]);
    expect(result.inspected).toEqual(result.searched);
    expect(calls).not.toContain("silpo_add_products");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
