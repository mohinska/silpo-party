import { afterEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { createDebugPartyModel, resolveDebugPartyLimits } from "./provider";

const env = { AI_API_KEY: "test-key", AI_BASE_URL: "https://api.deepseek.com" };
afterEach(() => vi.unstubAllGlobals());

it("requires DeepSeek credentials and keeps the planner model default", () => {
  expect(() => createDebugPartyModel({})).toThrow(/AI_API_KEY/);
  expect(() => createDebugPartyModel({ AI_API_KEY: "key" })).toThrow(/AI_BASE_URL/);
  expect(() => createDebugPartyModel({ ...env, AI_PROVIDER: "other" })).toThrow(/Unsupported/);
  expect(createDebugPartyModel(env).modelId).toBe("deepseek-v4-flash");
  expect(createDebugPartyModel({ ...env, AI_PLANNER_MODEL: "custom" }).modelId).toBe("custom");
});

it("sends normal tool-loop requests without forcing JSON response format", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ id: "reply", model: "deepseek-v4-flash", created: 0,
      choices: [{ index: 0, message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }));
  await generateText({ model: createDebugPartyModel(env), prompt: "Привіт", maxRetries: 0 });
  expect(body.response_format).toBeUndefined();
});

it("validates limits so invalid settings cannot disable bounds", () => {
  expect(resolveDebugPartyLimits({})).toEqual({ maxSteps: 20, maxMcpCalls: 40, totalMs: 180000, toolMs: 15000, stepMs: 15000 });
  for (const value of ["0", "-1", "NaN", "1.5"]) {
    expect(() => resolveDebugPartyLimits({ AI_DEBUG_MAX_STEPS: value })).toThrow();
  }
});
