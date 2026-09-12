import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const callTool = vi.fn(async ({ name }: { name: string }) => {
  if (name === "silpo_get_my_shopping_cart") return { cartId: "cart-1" };
  if (name === "silpo_get_shopping_cart_by_id") return { branchId: "branch-1", companyId: "company-1", deliveryType: "delivery", timeslotStart: "2026-09-12T10:00:00Z", timeslotEnd: "2026-09-12T12:00:00Z" };
  if (name === "silpo_get_time_slots") return { slots: [] };
  if (name === "silpo_find_products_batch") return {
    queries: [{ query: "Оливкова олія", products: [{ id: "oil-1", name: "Оливкова олія Extra Virgin", companyId: "company-1", branchId: "branch-1", priceCents: 3999, available: true }] }],
  };
  throw new Error(`Unexpected tool ${name}`);
});

vi.mock("@/lib/silpo/mcp", () => ({
  readToolData: (value: unknown) => value,
  withSilpoMcp: vi.fn(),
  withSilpoMcpAccessToken: vi.fn(async (_token: string, operation: (client: unknown, tools: Map<string, unknown>) => Promise<unknown>) => operation({ callTool }, new Map([
    ["silpo_get_my_shopping_cart", { name: "silpo_get_my_shopping_cart", inputSchema: { type: "object", properties: {}, required: [] } }],
    ["silpo_get_shopping_cart_by_id", { name: "silpo_get_shopping_cart_by_id", inputSchema: { type: "object", properties: { cartId: { type: "string" } }, required: ["cartId"] } }],
    ["silpo_get_time_slots", { name: "silpo_get_time_slots", inputSchema: { type: "object", properties: { branchId: { type: "string" } }, required: ["branchId"] } }],
    ["silpo_find_products_batch", { name: "silpo_find_products_batch", inputSchema: { type: "object", properties: { queries: { type: "array", items: { type: "object", properties: { query: { type: "string" }, quantity: { type: "number" } }, required: ["query", "quantity"] } } }, required: ["queries"] } }],
  ]))),
}));

import { findSilpoProductsBatchWithAccessToken } from "./cart";

describe("Silpo batch product search", () => {
  it("resolves all ingredient queries in one authorized MCP session", async () => {
    const result = await findSilpoProductsBatchWithAccessToken("token", ["Оливкова олія"]);

    expect(result.get("Оливкова олія")).toEqual([expect.objectContaining({ productId: "oil-1", name: "Оливкова олія Extra Virgin" })]);
    expect(callTool.mock.calls.filter(([request]) => request.name === "silpo_find_products_batch")).toHaveLength(1);
  });
});
