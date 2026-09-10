import { describe, expect, it, vi } from "vitest";
import { collectPersonalContext, PersonalSignalsSchema, type PersonalNormalizer } from "./personal-agent";
import type { PersonalMcpAdapter, AdvertisedPersonalTool } from "./mcp-tools";
import { DebugParticipantContextSchema } from "./schemas";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/silpo/oauth", () => ({ getAccessToken: vi.fn(), SILPO_MCP_URL: "https://example.invalid/mcp" }));

const foodRequest = { partyId: "party-1", participantId: "user-1", revision: 2, request: "Овочева вечеря" };
const tool = (name: string, description: string): AdvertisedPersonalTool => ({
  name, description, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
});
function adapter(entries: Array<[AdvertisedPersonalTool, unknown]>) {
  const calls: string[] = [];
  const mcpAdapter: PersonalMcpAdapter = async (userId, operation) => {
    expect(userId).toBe("user-1");
    return operation({
      tools: entries.map(([metadata]) => metadata),
      callTool: async ({ name, arguments: args }) => {
        expect(args).toEqual({});
        calls.push(name);
        const entry = entries.find(([metadata]) => metadata.name === name);
        if (!entry) throw new Error("Unadvertised tool");
        if (entry[1] instanceof Error) throw entry[1];
        return { structuredContent: entry[1] };
      },
    });
  };
  return { calls, mcpAdapter };
}

describe("collectPersonalContext", () => {
  it("collects advertised food capabilities, keeps the newest five purchases, and exposes no contact data", async () => {
    const fake = adapter([
      [tool("account_food", "Read my profile"), { allergies: ["Peanuts"], phone: "+380123", address: "private street", name: "Private Person", access_token: "secret-token" }],
      [tool("diet_info", "Read my dietary restrictions"), { restrictions: [{ name: "No gluten" }], email: "private@example.org" }],
      [tool("liked_food", "Read my favorites"), { favorites: [{ name: "Carrot", phone: "private" }], rawReceipt: "raw receipt" }],
      [tool("purchase_feed", "List my recent orders"), { orders: [1, 7, 3, 6, 2, 5, 4].map((n) => ({
        createdAt: `2026-09-0${n}T12:00:00Z`, address: "private street", receipt: "raw receipt",
        products: [{ productId: `p${n}`, name: `Food ${n}`, access_token: "secret-token" }],
      })) }],
    ]);
    let received: unknown;
    const normalizer: PersonalNormalizer = async (input) => {
      received = input.signals;
      return { dietaryRestrictions: [], favorites: [], summary: "Овочева вечеря з урахуванням обмежень." };
    };
    const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 4, mcpAdapter: fake.mcpAdapter, normalizer });
    expect(fake.calls).toEqual(["account_food", "diet_info", "liked_food", "purchase_feed"]);
    expect(result.recentProducts.map((p) => p.productId)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(result.dietaryRestrictions.map((r) => r.label)).toEqual(["Peanuts", "No gluten"]);
    expect(result.favorites.map((r) => r.label)).toContain("Carrot");
    expect(result.purchaseHistoryStatus).toBe("available");
    expect(result).toMatchObject({ partyId: "party-1", participantId: "user-1", intentRevision: 2, contextStatus: "ready" });
    expect(DebugParticipantContextSchema.parse(result)).toEqual(result);
    expect(PersonalSignalsSchema.parse(received)).toEqual(received);
    expect(JSON.stringify([result, received])).not.toMatch(/access_token|phone|address|raw receipt|secret-token|Private Person|private@/i);
  });

  it("records missing or failed purchase capability as unavailable", async () => {
    for (const entries of [[], [[tool("list_orders", "List orders"), new Error("upstream secret")]]] as Array<Array<[AdvertisedPersonalTool, unknown]>>) {
      const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 4, mcpAdapter: adapter(entries).mcpAdapter });
      expect(result.purchaseHistoryStatus).toBe("unavailable");
      expect(result.recentProducts).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("upstream secret");
    }
  });

  it("enforces the call budget and refuses writes or required inputs it cannot supply", async () => {
    const fake = adapter([
      [{ ...tool("update_profile", "Update profile"), annotations: { readOnlyHint: false } }, {}],
      [{ ...tool("delete_orders", "Delete orders"), annotations: { readOnlyHint: true, destructiveHint: true } }, {}],
      [{ ...tool("get_orders", "Read orders"), inputSchema: { type: "object", required: ["customerId"], properties: { customerId: { type: "string" } } } }, {}],
      [tool("get_profile", "Read profile"), { restrictions: ["Vegan"] }],
      [tool("get_favorites", "Read favorites"), { favorites: ["Rice"] }],
    ]);
    const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 1, mcpAdapter: fake.mcpAdapter });
    expect(fake.calls).toEqual(["get_profile"]);
    expect(result.dietaryRestrictions[0].label).toBe("Vegan");
    expect(result.purchaseHistoryStatus).toBe("unavailable");
  });

  it("bounds extraction before normalization, including cycles, giant arrays, text, and deep responses", async () => {
    const cyclic: Record<string, unknown> = { favorites: Array.from({ length: 10_000 }, (_, n) => ({ name: `Food ${n} ${"x".repeat(1_000)}` })) };
    cyclic.self = cyclic;
    let inputSize = 0;
    const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 1,
      mcpAdapter: adapter([[tool("get_favorites", "Read favorites"), cyclic]]).mcpAdapter,
      normalizer: async ({ signals }) => {
        inputSize = JSON.stringify(signals).length;
        expect(signals.favorites.length).toBeLessThanOrEqual(30);
        expect(signals.favorites.every((f) => f.label.length <= 500)).toBe(true);
        return { summary: "Вподобання враховано.", favorites: [], dietaryRestrictions: [] };
      },
    });
    expect(inputSize).toBeGreaterThan(0);
    expect(inputSize).toBeLessThan(20_000);
    expect(result.favorites.length).toBeLessThanOrEqual(30);
  });

  it("fails closed on cross-participant intents before opening a session", async () => {
    const fake = adapter([]);
    await expect(collectPersonalContext({ userId: "user-2", foodRequest, callBudget: 4, mcpAdapter: fake.mcpAdapter })).rejects.toThrow(/participant/i);
    expect(fake.calls).toEqual([]);
  });

  it("discards malformed normalization without losing deterministic restrictions", async () => {
    const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 1,
      mcpAdapter: adapter([[tool("get_restrictions", "Read restrictions"), { allergies: ["Sesame"] }]]).mcpAdapter,
      normalizer: async () => ({ summary: "unsafe", access_token: "model-secret", dietaryRestrictions: [], favorites: [] }),
    });
    expect(result.dietaryRestrictions[0].label).toBe("Sesame");
    expect(JSON.stringify(result)).not.toContain("model-secret");
  });

  it("protects deterministic facts from normalizer mutation", async () => {
    const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 1,
      mcpAdapter: adapter([[tool("get_restrictions", "Read restrictions"), { allergies: ["Sesame"] }]]).mcpAdapter,
      normalizer: async ({ signals }) => {
        signals.dietaryRestrictions.length = 0;
        return { summary: "Вечеря", dietaryRestrictions: [], favorites: [] };
      },
    });
    expect(result.dietaryRestrictions.map((fact) => fact.label)).toEqual(["Sesame"]);
  });

  it("decodes bounded MCP text while treating oversized and malformed orders as unavailable", async () => {
    for (const raw of [
      { content: [{ type: "text", text: "x".repeat(100_000) }] },
      { structuredContent: { unexpected: "not order data" } },
      { isError: true, content: [{ type: "text", text: "secret-token" }] },
    ]) {
      const mcpAdapter: PersonalMcpAdapter = async (_id, operation) => operation({ tools: [tool("get_orders", "Read orders")], callTool: async () => raw });
      const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 1, mcpAdapter });
      expect(result.purchaseHistoryStatus).toBe("unavailable");
    }
    const mcpAdapter: PersonalMcpAdapter = async (_id, operation) => operation({
      tools: [tool("silpo_get_my_food_restrictions", "Read restrictions")],
      callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ allergies: ["Milk"], phone: "private" }) }] }),
    });
    const result = await collectPersonalContext({ userId: "user-1", foodRequest, callBudget: 1, mcpAdapter });
    expect(result.dietaryRestrictions.map((fact) => fact.label)).toEqual(["Milk"]);
  });

  it("preserves the legacy readToolData import and envelope behavior", async () => {
    const { readToolData } = await import("../../silpo/mcp");
    expect(readToolData({ structuredContent: { label: "Rice" }, content: [{ text: "ignored" }] })).toEqual({ label: "Rice" });
    expect(readToolData({ content: [{ text: '{"label":"Rice"}' }] })).toEqual({ label: "Rice" });
    expect(readToolData({ content: [{ text: "plain" }, { text: "true" }] })).toEqual(["plain", true]);
  });
});
