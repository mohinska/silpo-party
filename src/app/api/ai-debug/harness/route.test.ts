import { afterEach, describe, expect, it, vi } from "vitest";

const sessionId = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
const harness = vi.hoisted(() => ({ runDebugHarness: vi.fn(), createDebugHarnessSession: vi.fn(() => ({ id: sessionId, trace: [] })) }));
vi.mock("../../../../lib/ai/debug-party/harness", () => harness);
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  harness.runDebugHarness.mockReset();
  harness.createDebugHarnessSession.mockClear();
});

function request(body: unknown, authorization?: string) {
  return new Request("http://localhost:3000/api/ai-debug/harness", {
    method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
  });
}

describe("AI Debug harness route", () => {
  it.each([
    ["production", undefined, 404],
    ["development", undefined, 401],
    ["development", "Bearer wrong", 401],
  ])("refuses %s requests without a valid local developer secret", async (nodeEnv, authorization, status) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("AI_DEBUG_HARNESS_SECRET", "local-secret");

    expect((await POST(request({ message: "вода", mcpAccessToken: "token" }, authorization))).status).toBe(status);
    expect(harness.runDebugHarness).not.toHaveBeenCalled();
  });

  it("runs an authorized development request and does not echo the token", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_DEBUG_HARNESS_SECRET", "local-secret");
    harness.runDebugHarness.mockResolvedValue({ sessionId, reply: "Готово.", cart: { revision: 0, totalCents: 0, items: [] }, trace: [] });

    const response = await POST(request({ message: "вода", mcpAccessToken: "private-token" }, "Bearer local-secret"));

    expect(response.status).toBe(200);
    expect(harness.runDebugHarness).toHaveBeenCalledWith(expect.objectContaining({ message: "вода", mcpAccessToken: "private-token" }), expect.any(Object));
    expect(await response.text()).not.toContain("private-token");
  });

  it("returns the safe normalized recipe trace instead of converting it into a 502", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_DEBUG_HARNESS_SECRET", "local-secret");
    harness.runDebugHarness.mockResolvedValue({
      sessionId, reply: "Рецепт додано.", cart: { revision: 0, totalCents: 0, items: [] },
      trace: [{
        toolName: "resolveRecipe", status: "completed", durationMs: 25, trace: null, selectedEvidenceId: null, errorCode: null,
        recipe: { title: "Карбонара", sourceUrl: "https://silpo.ua/recipes/carbonara", servings: 2, ingredients: [{ name: "Спагеті", quantity: 200, unit: "g", optional: false }] },
      }],
    });

    const response = await POST(request({ message: "карбонара", mcpAccessToken: "private-token" }, "Bearer local-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ trace: [{ recipe: { title: "Карбонара", ingredients: [{ name: "Спагеті" }] } }] });
  });

  it("returns a stable code and only normalized tool traces when the harness fails", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_DEBUG_HARNESS_SECRET", "local-secret");
    harness.runDebugHarness.mockRejectedValue(Object.assign(new Error("provider response included private-token"), { code: "HARNESS_RECIPE_FAILED" }));

    const response = await POST(request({ message: "карбонара", mcpAccessToken: "private-token" }, "Bearer local-secret"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Harness run failed.", code: "HARNESS_RECIPE_FAILED", trace: [] });
  });
});
