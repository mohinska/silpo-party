import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { createDebugHarnessSession, harnessFailureCodeForTool, runDebugHarness } from "./harness";
import type { CandidatePreselector } from "./candidate-preselector";
import type { RecipeNormalizer } from "../planning/recipe-agent";

vi.mock("server-only", () => ({}));

function response(toolName: string, input: object): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: "call", toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
  };
}

describe("AI Debug local harness", () => {
  it("uses only stable failure codes for the active agent boundary", () => {
    expect(harnessFailureCodeForTool("resolveRecipe")).toBe("HARNESS_RECIPE_FAILED");
    expect(harnessFailureCodeForTool("searchProducts")).toBe("HARNESS_CATALOG_FAILED");
    expect(harnessFailureCodeForTool(undefined)).toBe("HARNESS_AGENT_FAILED");
  });

  it("returns a safe failure when a model ignores the total timeout", async () => {
    const model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });

    await expect(runDebugHarness({ message: "додай воду", mcpAccessToken: "never-return" }, {
      model,
      environment: { AI_DEBUG_TOTAL_TIMEOUT_MS: "20", AI_DEBUG_TOOL_TIMEOUT_MS: "1000" },
      createGateway: () => ({ search: async () => ({ groups: [] }), inspect: async () => [], close: async () => undefined }),
    })).rejects.toMatchObject({ code: "HARNESS_AGENT_FAILED" });
  });

  it("allows a slow catalog tool to finish without cancelling the next agent step", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [response("searchProducts", { queries: ["вода"] }), response("complete", { reply: "Воду додано." })] });

    const result = await runDebugHarness({ message: "додай воду", mcpAccessToken: "never-return" }, {
      model,
      environment: { AI_DEBUG_TOTAL_TIMEOUT_MS: "1000", AI_DEBUG_TOOL_TIMEOUT_MS: "10" },
      candidatePreselector: async ({ candidates }) => ({
        normalizedIntent: { productKind: "вода", requestedAttributes: [], exclusions: [] },
        verdicts: candidates.map((candidate) => ({ evidenceId: candidate.evidenceId, verdict: "match", reason: "Питна вода." })),
      }),
      createGateway: () => ({
        search: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { groups: [{ query: "вода", products: [{ productId: "water", companyId: "company", branchId: "branch", name: "Вода негазована", unit: "1 л", unitPriceCents: 3000, discountCents: null, imageUrl: null, available: true }] }] };
        },
        inspect: async () => [], close: async () => undefined,
      }),
    } as never);

    expect(result.reply).toBe("Воду додано.");
    expect(result.trace.map((entry) => entry.toolName)).toEqual(["searchProducts", "complete"]);
  });

  it("keeps the failed recipe-tool boundary when the agent cannot continue", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [response("resolveRecipe", { query: "Карбонара" })] });

    await expect(runDebugHarness({ message: "паста карбонара", mcpAccessToken: "never-return" }, {
      model,
      retrieveRecipe: async () => { throw new Error("upstream recipe source failed"); },
      createGateway: () => ({ search: async () => ({ groups: [] }), inspect: async () => [], close: async () => undefined }),
    })).rejects.toMatchObject({ code: "HARNESS_RECIPE_SOURCE_FAILED" });
  });

  it("reports a recipe-normalizer failure without exposing its response", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [response("resolveRecipe", { query: "Карбонара" })] });
    const recipeNormalizer: RecipeNormalizer = async () => { throw new Error("invalid provider response"); };

    await expect(runDebugHarness({ message: "паста карбонара", mcpAccessToken: "never-return" }, {
      model,
      recipeNormalizer,
      retrieveRecipe: async () => ({
        id: "carbonara", title: "Карбонара", source: { provider: "silpo", title: "Карбонара", url: "https://silpo.ua/recipes/karbonara" }, baseServings: 2,
        ingredients: [{ name: "Спагеті", quantity: 200, unit: "g", variant: "standard", optional: false }],
      }),
      createGateway: () => ({ search: async () => ({ groups: [] }), inspect: async () => [], close: async () => undefined }),
    })).rejects.toMatchObject({ code: "HARNESS_RECIPE_NORMALIZER_FAILED" });
  });

  it("runs the sourced recipe subagent and keeps normalized ingredients in the local session", async () => {
    const session = createDebugHarnessSession();
    const model = new MockLanguageModelV4({ doGenerate: [response("resolveRecipe", { query: "Карбонара" }), response("complete", { reply: "Рецепт готовий." })] });
    const recipeNormalizer: RecipeNormalizer = async () => ({ include: [{ sourceIndex: 0, optional: false }, { sourceIndex: 1, optional: false }] });
    const result = await runDebugHarness({ message: "зробімо карбонару", mcpAccessToken: "never-return" }, {
      session,
      model,
      recipeNormalizer,
      retrieveRecipe: async () => ({
        id: "carbonara", title: "Карбонара", source: { provider: "silpo", title: "Карбонара", url: "https://silpo.ua/recipes/carbonara" }, baseServings: 2,
        ingredients: [
          { name: "Спагеті", quantity: 200, unit: "g", variant: "standard", optional: false },
          { name: "Бекон", quantity: 150, unit: "g", variant: "standard", optional: false },
        ],
      }),
      createGateway: () => ({ search: async () => ({ groups: [] }), inspect: async () => [], close: async () => undefined }),
    } as never);

    expect(result.trace[0]).toMatchObject({ toolName: "resolveRecipe", status: "completed" });
    expect(result.trace[0].recipe).toMatchObject({ title: "Карбонара", sourceUrl: "https://silpo.ua/recipes/carbonara" });
    expect(result.trace[0].recipe?.ingredients[0]).toMatchObject({ name: "Спагеті", quantity: 200, unit: "g" });
    expect(session.workspace.recipes).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/never-return|access_token|authorization|raw/i);
  });

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
