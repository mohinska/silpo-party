import { describe, expect, it, vi } from "vitest";
import { createDebugCatalogGateway, createHostDebugCatalogGateway, type DebugCatalogMcpSession } from "./catalog-gateway";

vi.mock("server-only", () => ({}));
const mcp = vi.hoisted(() => ({ openSilpoMcpSession: vi.fn() }));
vi.mock("@/lib/silpo/mcp", () => ({ ...mcp }));

const now = "2026-09-11T12:00:00.000Z";

function tool(name: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { name, inputSchema: { type: "object", properties, required } };
}

describe("debug catalog gateway", () => {
  it("creates a Host-scoped session through the server-only MCP factory", async () => {
    const close = vi.fn(async () => undefined);
    mcp.openSilpoMcpSession.mockResolvedValueOnce({ tools: new Map(), client: { callTool: vi.fn() }, close });

    const gateway = createHostDebugCatalogGateway("host-id");
    await expect(gateway.inspect("product")).rejects.toThrow("MCP_READ:silpo_get_my_shopping_cart:MCP_404");
    await gateway.close();

    expect(mcp.openSilpoMcpSession).toHaveBeenCalledWith("host-id");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens one session, batches alternative queries, and reuses its cart context for inspect", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const close = vi.fn(async () => undefined);
    const session: DebugCatalogMcpSession = {
      tools: new Map([
        ["silpo_get_my_shopping_cart", tool("silpo_get_my_shopping_cart")],
        ["silpo_get_shopping_cart_by_id", tool("silpo_get_shopping_cart_by_id", { shoppingCartId: { type: "string" } }, ["shoppingCartId"])],
        ["silpo_get_time_slots", tool("silpo_get_time_slots", { branchId: { type: "string" } }, ["branchId"])],
        ["silpo_find_products_batch", tool("silpo_find_products_batch", {
          branchId: { type: "string" }, deliveryType: { type: "string" }, timeslotStart: { type: "string" }, timeslotEnd: { type: "string" }, products: { type: "array", items: { type: "string" } },
        }, ["branchId", "deliveryType", "timeslotStart", "timeslotEnd", "products"])],
        ["silpo_get_product_by_id", tool("silpo_get_product_by_id", { productId: { type: "string" } }, ["productId"])],
      ]),
      callTool: async (request) => {
        calls.push(request);
        if (request.name === "silpo_get_my_shopping_cart") return { structuredContent: { shoppingCartId: "cart" } };
        if (request.name === "silpo_get_shopping_cart_by_id") return { structuredContent: { cart: { deliveryType: "SelfPickup", timeslot: { start: now, end: now }, shipments: [{ branchId: "branch", companyId: "company" }] } } };
        if (request.name === "silpo_get_time_slots") return { structuredContent: { slots: [] } };
        if (request.name === "silpo_find_products_batch") return { structuredContent: { queries: [
          { query: "сир", products: [{ id: "cheese", name: "Сир", currentPrice: 99, displayRatio: "200 г", available: true, branchId: "branch", companyId: "company" }] },
          { query: "сир твердий", products: [{ id: "hard-cheese", name: "Сир твердий", currentPrice: 125, displayRatio: "180 г", available: true, branchId: "branch", companyId: "company" }] },
          { query: "cheese", products: [] },
        ] } };
        return { structuredContent: { id: "hard-cheese", name: "Сир твердий", currentPrice: 125, displayRatio: "180 г", available: true, branchId: "branch", companyId: "company" } };
      },
      close,
    };
    const openSession = vi.fn(async () => session);
    const gateway = createDebugCatalogGateway({ openSession });

    const search = await gateway.search(["сир", "сир твердий", "cheese"]);
    const inspected = await gateway.inspect("hard-cheese");
    await gateway.close();

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({ name: "silpo_find_products_batch", arguments: {
      branchId: "branch", deliveryType: "SelfPickup", timeslotStart: now, timeslotEnd: now,
      products: ["сир", "сир твердий", "cheese"],
    } });
    expect(search.groups.map((group) => group.query)).toEqual(["сир", "сир твердий", "cheese"]);
    expect(search.groups[1].products).toEqual([expect.objectContaining({ productId: "hard-cheese", unitPriceCents: 12500, available: true })]);
    expect(inspected).toEqual([expect.objectContaining({ productId: "hard-cheese" })]);
    expect(calls.filter((call) => call.name === "silpo_get_my_shopping_cart")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "silpo_get_shopping_cart_by_id")).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
