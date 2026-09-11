import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { runDebugPartySupervisor, type SupervisorDependencies } from "./supervisor";
import type { DebugPartyWorkspace } from "./repository";
import { readToolData } from "../../silpo/tool-data";
import type { CandidatePreselector } from "./candidate-preselector";

const { rawCall, withMcp, openMcp, retrieveRecipe } = vi.hoisted(() => ({ rawCall: vi.fn(), withMcp: vi.fn(), openMcp: vi.fn(), retrieveRecipe: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/silpo/mcp", () => ({ withSilpoMcp: withMcp, openSilpoMcpSession: openMcp, readToolData: (value: unknown) => readToolData(value) }));
vi.mock("../planning/recipe-retrieval", () => ({ retrieveRecipe }));

const now = "2026-09-10T12:00:00.000Z";
function response(toolName: string, input: object = {}): LanguageModelV4GenerateResult {
  return { content: [{ type: "reasoning", text: "PRIVATE REASONING" },
    { type: "tool-call", toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
}

function setup(outputs = [response("complete", { reply: "Кошик готовий." })]) {
  const member = { partyId: "party", participantId: "host", role: "host" as const, contextStatus: "ready" as const, joinedAt: now, updatedAt: now };
  const context = { id: "context", partyId: "party", participantId: "host", intentRevision: 1, contextStatus: "ready" as const,
    purchaseHistoryStatus: "unavailable" as const, dietaryRestrictions: [], favorites: [], recentProducts: [], summary: "Овочі", collectedAt: now, createdAt: now, updatedAt: now };
  const workspace: DebugPartyWorkspace = { party: { id: "party", code: "ABCDEFGH", hostId: "host", status: "ready", budgetCents: 10000, cartRevision: 0, createdAt: now, updatedAt: now },
    member, members: [member], intents: [{ id: "intent", partyId: "party", participantId: "host", revision: 1, request: "Овочі", createdAt: now, updatedAt: now }], contexts: [context], cartItems: [], recipes: [] };
  const events: unknown[] = [];
  const finishes: unknown[] = [];
  const model = new MockLanguageModelV4({ doGenerate: outputs });
  const repository = { loadWorkspace: vi.fn(async () => workspace),
    startRun: vi.fn(async () => ({ id: "run" })),
    appendToolEvent: vi.fn(async (event) => { events.push(event); }),
    completeRun: vi.fn(async (event) => { finishes.push(event); }),
    replaceContext: vi.fn(async ({ context: value }) => value),
    saveRecipe: vi.fn(async ({ recipe }) => {
      const saved = { id: "recipe-row", ...recipe, createdAt: now, updatedAt: now };
      workspace.recipes = [...workspace.recipes, saved];
      return saved;
    }),
    findEvidence: vi.fn(async () => null), saveEvidence: vi.fn(async ({ evidence }) => evidence), applyCartCommand: vi.fn() };
  const personalAgent = vi.fn(async () => context);
  const dependencies: SupervisorDependencies = { code: "ABCDEFGH", actorId: "host", model,
    repository: repository as unknown as SupervisorDependencies["repository"], personalAgent,
    catalogAdapter: async (_host, operation) => operation({ search: async () => [], inspect: async () => [] }),
    loadMessage: async () => ({ partyId: "party", actorId: "host", content: "Додай овочі" }) };
  return { dependencies, workspace, model, repository, personalAgent, events, finishes };
}
const build = { mode: "build", partyId: "party", actorId: "host" };

describe("debug party supervisor", () => {
  it("passes compact planning context to the candidate preselector", async () => {
    const f = setup([response("searchProducts", { queries: ["вода"] }), response("complete", { reply: "Воду знайдено." })]);
    f.dependencies.catalogAdapter = async (_host, operation) => operation({
      search: async () => [{ productId: "water", companyId: "company", branchId: "branch", name: "Вода негазована", unit: "1 л", unitPriceCents: 3000, discountCents: null, imageUrl: null, available: true }],
      inspect: async () => [],
    });
    const candidatePreselector = vi.fn<CandidatePreselector>(async ({ candidates }) => ({
      normalizedIntent: { productKind: "вода", requestedAttributes: [], exclusions: [] },
      verdicts: candidates.map((candidate) => ({ evidenceId: candidate.evidenceId, verdict: "match" as const, reason: "Питна вода." })),
    }));
    (f.dependencies as SupervisorDependencies & { candidatePreselector: CandidatePreselector }).candidatePreselector = candidatePreselector;

    await runDebugPartySupervisor(build, f.dependencies);

    expect(candidatePreselector).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.stringContaining("Овочі"),
      candidates: [expect.objectContaining({ evidenceId: expect.any(String), productId: "water" })],
    }));
    expect(JSON.stringify(candidatePreselector.mock.calls)).not.toMatch(/access_token|authorization|raw/i);
    const searchEvent = f.events.find((entry): entry is { metadata: { trace?: { preselection?: { status: string } } } } => typeof entry === "object" && entry !== null
      && "toolName" in entry && entry.toolName === "searchProducts" && "status" in entry && entry.status === "completed");
    expect(searchEvent?.metadata.trace?.preselection).toMatchObject({ status: "completed" });
  });

  it("requires personal preprocessing, persists context, and never exposes cart tools in preprocess", async () => {
    const f = setup([response("prepareParticipantContext"), response("complete", { reply: "Контекст готовий." })]);
    const result = await runDebugPartySupervisor({ mode: "preprocess", partyId: "party", participantId: "host", intentRevision: 1 }, f.dependencies);
    expect(result.status).toBe("completed");
    expect(f.personalAgent).toHaveBeenCalledWith(expect.objectContaining({ participantId: "host" }));
    expect(f.repository.replaceContext).toHaveBeenCalledWith(expect.objectContaining({ participantId: "host" }));
    expect(f.model.doGenerateCalls[0].toolChoice).toEqual({ type: "tool", toolName: "prepareParticipantContext" });
    expect(f.model.doGenerateCalls[0].tools?.map((tool) => tool.name)).toEqual(["prepareParticipantContext"]);
  });

  it.each(["missing", "stale", "pending"])("refuses %s contexts before any model call", async (kind) => {
    const f = setup();
    if (kind === "missing") f.workspace.contexts = [];
    if (kind === "stale") f.workspace.contexts[0].intentRevision = 2;
    if (kind === "pending") f.workspace.members[0].contextStatus = "pending";
    await expect(runDebugPartySupervisor(build, f.dependencies)).rejects.toThrow(/context|контекст/i);
    expect(f.model.doGenerateCalls).toHaveLength(0);
  });

  it("processes a first chat automatically while other members remain silent", async () => {
    const f = setup();
    f.workspace.party.status = "collecting";
    f.workspace.contexts = [];
    f.workspace.members[0].contextStatus = "pending";
    f.workspace.members.push({ ...f.workspace.members[0], participantId: "silent", role: "member" });
    const result = await runDebugPartySupervisor({ ...build, mode: "chat", messageId: "message" }, f.dependencies);
    expect(result.status).toBe("completed");
    expect(f.repository.replaceContext).toHaveBeenCalledWith(expect.objectContaining({ participantId: "host" }));
    expect(f.model.doGenerateCalls[0].tools?.map((tool) => tool.name)).toContain("addProduct");
  });

  it("allows an explicit rebuild when a joined member has not sent any intent", async () => {
    const f = setup();
    f.workspace.party.status = "collecting";
    f.workspace.members.push({ ...f.workspace.members[0], participantId: "silent", role: "member", contextStatus: "pending" });
    expect(await runDebugPartySupervisor(build, f.dependencies)).toMatchObject({ status: "completed" });
  });

  it("requires current context for other members who have submitted intent in chat mode", async () => {
    const f = setup();
    f.workspace.members.push({ ...f.workspace.members[0], participantId: "other", role: "member", contextStatus: "pending" });
    f.workspace.intents.push({ ...f.workspace.intents[0], participantId: "other" });
    await expect(runDebugPartySupervisor({ ...build, mode: "chat", messageId: "message" }, f.dependencies)).rejects.toThrow(/contexts/);
    expect(f.model.doGenerateCalls).toHaveLength(0);
  });

  it("reuses current personal context and passes cumulative chat history to the supervisor", async () => {
    const f = setup();
    f.workspace.chatMessages = ["Піца", "Додай воду", "Прибери піцу"].map((content, index) => ({
      id: `m${index}`, partyId: "party", participantId: "host", role: "user", content, status: "completed", createdAt: now, updatedAt: now,
    }));
    await runDebugPartySupervisor({ ...build, mode: "chat", messageId: "message" }, f.dependencies);
    expect(f.personalAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(f.model.doGenerateCalls[0].prompt)).toContain("Прибери піцу");
  });

  it("rejects actor and party substitution before starting a run", async () => {
    const f = setup();
    await expect(runDebugPartySupervisor({ ...build, actorId: "other" }, f.dependencies)).rejects.toThrow();
    await expect(runDebugPartySupervisor({ ...build, partyId: "other" }, f.dependencies)).rejects.toThrow();
    expect(f.repository.startRun).not.toHaveBeenCalled();
  });

  it("exposes the same local cart tools in build and chat and emits only short completion text", async () => {
    const f = setup([response("complete", { reply: "Г".repeat(400) })]);
    const first = await runDebugPartySupervisor(build, f.dependencies);
    const chat = setup();
    await runDebugPartySupervisor({ ...build, mode: "chat", messageId: "message" }, chat.dependencies);
    const names = f.model.doGenerateCalls[0].tools?.map((tool) => tool.name);
    expect(names).toContain("addProduct");
    expect(names).toContain("resolveRecipe");
    expect(names).not.toContain("writeSilpoCart");
    expect(names).toEqual(chat.model.doGenerateCalls[0].tools?.map((tool) => tool.name));
    expect(JSON.stringify(f.model.doGenerateCalls[0].prompt)).toContain("unitPriceCents is the final payable price");
    expect(first.reply.length).toBeLessThanOrEqual(240);
    expect(first.status).toBe("completed");
    expect(JSON.stringify([first, f.events, f.finishes])).not.toContain("PRIVATE REASONING");
    expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "complete", status: "completed" })]));
  });

  it("runs recipe facts through the isolated recipe subagent before exposing them to the cart agent", async () => {
    const f = setup([response("resolveRecipe", { query: "Карбонара" }), response("complete", { reply: "Рецепт додано." })]);
    retrieveRecipe.mockResolvedValue({
      id: "recipe", title: "Карбонара", source: { provider: "silpo", title: "Карбонара" }, baseServings: 2,
      ingredients: [{ name: "Спагеті", quantity: 100, unit: "g", variant: "standard", optional: false }],
    });
    const normalizer = vi.fn(async () => ({ include: [{ sourceIndex: 0, optional: false }] }));
    (f.dependencies as SupervisorDependencies & { recipeNormalizer: typeof normalizer }).recipeNormalizer = normalizer;

    await runDebugPartySupervisor(build, f.dependencies);

    expect(normalizer).toHaveBeenCalledWith(expect.objectContaining({ recipe: expect.objectContaining({ title: "Карбонара" }) }));
    expect(f.repository.saveRecipe).toHaveBeenCalledWith(expect.objectContaining({ recipe: expect.objectContaining({ ingredients: [expect.objectContaining({ name: "Спагеті", quantity: 100, unit: "g" })] }) }));
    expect(JSON.stringify(f.model.doGenerateCalls[1].prompt)).toContain('"partyRequirements":[{"name":"Спагеті","quantity":100,"unit":"g"');
  });

  it("persists a safe failing Silpo MCP method and code in the debug event", async () => {
    const f = setup([response("searchProducts", { queries: ["вода"] }), response("complete", { reply: "Пошук тимчасово недоступний." })]);
    f.dependencies.catalogAdapter = async () => { throw new Error("MCP_READ:silpo_find_products_batch:MCP_503"); };

    await runDebugPartySupervisor(build, f.dependencies);

    expect(f.events).toContainEqual(expect.objectContaining({
      toolName: "searchProducts", status: "failed", metadata: { mcpTool: "silpo_find_products_batch", errorCode: "MCP_503" },
    }));
  });

  it("reads safe MCP metadata from a wrapped upstream error", async () => {
    const f = setup([response("searchProducts", { queries: ["вода"] }), response("complete", { reply: "Пошук тимчасово недоступний." })]);
    f.dependencies.catalogAdapter = async () => {
      throw new Error("Catalog read failed", { cause: new Error("MCP_READ:silpo_find_products_batch:MCP_503") });
    };

    await runDebugPartySupervisor(build, f.dependencies);

    expect(f.events).toContainEqual(expect.objectContaining({
      toolName: "searchProducts", status: "failed", metadata: { mcpTool: "silpo_find_products_batch", errorCode: "MCP_503" },
    }));
  });

  it("records compact batch candidates rather than raw MCP data", async () => {
    const f = setup([response("searchProducts", { queries: ["вода", "water"] }), response("complete", { reply: "Знайшов варіанти." })]);
    f.dependencies.catalogAdapter = async (_host, operation) => operation({
      search: async () => [{ productId: "water", companyId: "company", branchId: "branch", name: "Вода", unit: "1 л", unitPriceCents: 3000, discountCents: null, imageUrl: null, available: true }],
      inspect: async () => [],
    });

    await runDebugPartySupervisor(build, f.dependencies);

    const event = f.events.find((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null
      && "toolName" in entry && entry.toolName === "searchProducts" && "status" in entry && entry.status === "completed");
    expect(event).toMatchObject({ metadata: { trace: { type: "catalog.response", queries: ["вода", "water"], candidates: expect.arrayContaining([expect.objectContaining({ productId: "water", evidenceId: expect.any(String) })]) } } });
    expect(JSON.stringify(event)).not.toMatch(/access_token|authorization|raw/i);
  });

  it("stops at the step limit without claiming success", async () => {
    const f = setup([response("inspectCart"), response("inspectCart")]);
    f.dependencies.environment = { AI_DEBUG_MAX_STEPS: "2" };
    const result = await runDebugPartySupervisor(build, f.dependencies);
    expect(result).toMatchObject({ status: "failed", reason: "step_limit" });
    expect(f.model.doGenerateCalls).toHaveLength(2);
    expect(f.finishes).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("caps concurrent catalog calls and uses the Host identity", async () => {
    const output = response("searchProducts", { queries: ["овочі"] });
    output.content.push({ type: "tool-call", toolCallId: "extra", toolName: "searchProducts", input: '{"queries":["фрукти"]}' });
    const f = setup([output]);
    f.dependencies.environment = { AI_DEBUG_MAX_MCP_CALLS: "1" };
    const hosts: string[] = [];
    f.dependencies.catalogAdapter = async (host, operation) => { hosts.push(host); return operation({ search: async () => [], inspect: async () => [] }); };
    const result = await runDebugPartySupervisor(build, f.dependencies);
    expect(hosts).toEqual(["host"]);
    expect(result).toMatchObject({ status: "failed", reason: "tool_limit" });
  });

  it.each(["total", "tool"])("stops a hanging %s operation and sanitizes failure output", async (kind) => {
    const f = setup([response("searchProducts", { queries: ["SECRET"] })]);
    f.dependencies.environment = { AI_DEBUG_TOTAL_TIMEOUT_MS: kind === "total" ? "20" : "1000", AI_DEBUG_TOOL_TIMEOUT_MS: kind === "tool" ? "20" : "1000" };
    if (kind === "total") f.dependencies.model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });
    else f.dependencies.catalogAdapter = () => new Promise(() => {});
    const result = await runDebugPartySupervisor(build, f.dependencies);
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    expect(JSON.stringify([result, f.events, f.finishes])).not.toMatch(/SECRET|PRIVATE REASONING/);
  });

  it("counts every raw catalog read including Host cart discovery", async () => {
    const f = setup([response("searchProducts", { queries: ["овочі"] })]);
    f.dependencies.catalogAdapter = undefined;
    f.dependencies.environment = { AI_DEBUG_MAX_MCP_CALLS: "1" };
    rawCall.mockReset().mockResolvedValue({ structuredContent: { cartId: "cart" } });
    openMcp.mockResolvedValue({ client: { callTool: rawCall }, close: async () => undefined, tools: new Map([
      ["silpo_get_my_shopping_cart", { name: "silpo_get_my_shopping_cart", inputSchema: { type: "object" } }],
      ["silpo_get_shopping_cart_by_id", { name: "silpo_get_shopping_cart_by_id", inputSchema: { type: "object" } }],
    ]) });
    const result = await runDebugPartySupervisor(build, f.dependencies);
    expect(result).toMatchObject({ status: "failed", reason: "tool_limit" });
    expect(openMcp).toHaveBeenCalledWith("host");
    expect(rawCall).toHaveBeenCalledTimes(1);
    expect(rawCall).toHaveBeenCalledWith({ name: "silpo_get_my_shopping_cart", arguments: {} });
  });

  it("reports model step timeouts as timeouts", async () => {
    const f = setup();
    f.dependencies.environment = { AI_DEBUG_TOTAL_TIMEOUT_MS: "1000", AI_DEBUG_TOOL_TIMEOUT_MS: "20" };
    f.dependencies.model = new MockLanguageModelV4({ doGenerate: ({ abortSignal }) => new Promise((_, reject) => {
      abortSignal!.addEventListener("abort", () => reject(abortSignal!.reason), { once: true });
    }) });
    expect(await runDebugPartySupervisor(build, f.dependencies)).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("does not persist a personal context that arrives after its timeout", async () => {
    const f = setup([response("prepareParticipantContext")]);
    let resolve!: (value: DebugPartyWorkspace["contexts"][number]) => void;
    f.dependencies.personalAgent = () => new Promise((done) => { resolve = done; });
    f.dependencies.environment = { AI_DEBUG_TOOL_TIMEOUT_MS: "20", AI_DEBUG_TOTAL_TIMEOUT_MS: "1000" };
    const result = await runDebugPartySupervisor({ mode: "preprocess", partyId: "party", participantId: "host", intentRevision: 1 }, f.dependencies);
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    resolve(f.workspace.contexts[0]);
    await new Promise((done) => setTimeout(done, 0));
    expect(f.repository.replaceContext).not.toHaveBeenCalled();
  });
});
