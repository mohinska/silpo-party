import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { createDebugHarnessSession, runDebugHarness } from "./harness";
import type { CandidatePreselector } from "./candidate-preselector";

vi.mock("server-only", () => ({}));

function response(toolName: string, input: object): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: "call", toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
  };
}

describe("AI Debug local harness", () => {
  it("returns safe candidate-preselection verdicts from ephemeral state", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [response("searchProducts", { queries: ["вода"] }), response("complete", { reply: "Воду знайдено." })] });
    const candidatePreselector = vi.fn<CandidatePreselector>(async ({ candidates }) => ({
      normalizedIntent: { productKind: "вода", requestedAttributes: [], exclusions: [] },
      verdicts: candidates.map((candidate) => ({ evidenceId: candidate.evidenceId, verdict: "match" as const, reason: "Питна вода." })),
    }));
    const result = await runDebugHarness({ message: "додай воду", mcpAccessToken: "never-return" }, {
      model,
      candidatePreselector,
      createGateway: () => ({
        search: async () => ({ groups: [{ query: "вода", products: [{ productId: "water", companyId: "company", branchId: "branch", name: "Вода негазована", unit: "1 л", unitPriceCents: 3000, discountCents: null, imageUrl: null, available: true }] }] }),
        inspect: async () => [], close: async () => undefined,
      }),
    } as never);

    expect(candidatePreselector).toHaveBeenCalledWith(expect.objectContaining({ request: "додай воду" }));
    expect(result.trace[0].trace?.preselection).toMatchObject({ status: "completed" });
    expect(result.trace[0].trace?.candidates[0]?.preselection).toMatchObject({ verdict: "match" });
    expect(JSON.stringify(result)).not.toMatch(/never-return|access_token|authorization|raw/i);
  });

  it("runs only against injected ephemeral state and returns a safe reply", async () => {
    const session = createDebugHarnessSession();
    const model = new MockLanguageModelV4({ doGenerate: [response("complete", { reply: "Готово." })] });
    const result = await runDebugHarness({ message: "додай воду", mcpAccessToken: "never-return" }, {
      session,
      model,
      createGateway: () => ({ search: async () => ({ groups: [] }), inspect: async () => [], close: async () => undefined }),
    });

    expect(result).toMatchObject({ reply: "Готово.", cart: { items: [] }, trace: [expect.objectContaining({ toolName: "complete", status: "completed" })] });
    expect(JSON.stringify(result)).not.toMatch(/never-return|access_token|authorization/i);
  });
});
