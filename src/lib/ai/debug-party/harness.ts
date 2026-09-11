import "server-only";

import { ToolLoopAgent, isStepCount, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { createDebugCatalogGateway, type DebugCatalogGateway } from "./catalog-gateway";
import { catalogSearchTrace } from "./catalog-trace";
import { DebugHarnessTraceSchema, type DebugHarnessTrace } from "./harness-contract";
import { createLocalCartTools } from "./cart-tools";
import type { CandidatePreselector } from "./candidate-preselector";
import { retrieveRecipe } from "../planning/recipe-retrieval";
import { createRecipeNormalizer, normalizeRecipeForCart, type RecipeNormalizer } from "../planning/recipe-agent";
import type { Recipe } from "../planning/proposal-schemas";
import { mergedRecipeRequirements } from "./recipe-ledger";
import type { CartMutation, DebugPartyRepository, DebugPartyWorkspace } from "./repository";
import { createDebugCandidatePreselector, createDebugPartyModel, resolveDebugPartyLimits, type DebugPartyEnvironment } from "./provider";
import type { DebugCartItem, DebugProductEvidence } from "./schemas";

const HarnessInputSchema = z.strictObject({
  message: z.string().trim().min(1).max(2_000),
  mcpAccessToken: z.string().trim().min(1).max(16_000),
});
export type DebugHarnessSession = {
  readonly id: string;
  workspace: DebugPartyWorkspace;
  readonly evidence: Map<string, DebugProductEvidence>;
  trace: DebugHarnessTrace[];
};

type HarnessDependencies = {
  session?: DebugHarnessSession;
  model?: LanguageModel;
  environment?: DebugPartyEnvironment;
  createGateway?: (accessToken: string) => DebugCatalogGateway;
  candidatePreselector?: CandidatePreselector;
  recipeNormalizer?: RecipeNormalizer;
  retrieveRecipe?: (input: { dishName: string; requestedUrl?: string }) => Promise<Recipe>;
};

const PARTY_ID = "harness-party";
const ACTOR_ID = "harness-user";
const PARTY_CODE = "HARNESS1";
const instructions = `You are the local AI Debug basket agent. Use searchProducts for every product request, select evidence IDs from its verified candidates based on the user's message, then mutate only the local cart. Never invent products, prices, availability, IDs, or cart revisions. unitPriceCents is the final payable price for one unit; discountCents is only a saving from the former price, so never subtract it from unitPriceCents. For a generic request with multiple suitable catalog products, call compareAlternatives before choosing. searchProducts provides medianUnitPriceCents; choose a normal matching product at or below that median rather than automatically choosing the lowest price. You may use general quality judgement from verified names and brands, but never invent ratings or popularity. Search products are semantic matches; do not use partial products while a match exists. If requiresAlternateSearch is true, use different search terms. For an explicit dish or recipe URL, call resolveRecipe before product search. It returns only sourced, normalized ingredients. Use partyRequirements and the current cart to search only for missing requirements. Use one to three short alternative queries in a batch. Finish every turn with complete and a short Ukrainian reply.`;

export function createDebugHarnessSession(): DebugHarnessSession {
  const timestamp = new Date().toISOString();
  const member = { partyId: PARTY_ID, participantId: ACTOR_ID, role: "host" as const, contextStatus: "ready" as const, joinedAt: timestamp, updatedAt: timestamp };
  return {
    id: crypto.randomUUID(), evidence: new Map(), trace: [],
    workspace: {
      party: { id: PARTY_ID, code: PARTY_CODE, hostId: ACTOR_ID, budgetCents: null, status: "ready", cartRevision: 0, createdAt: timestamp, updatedAt: timestamp },
      member, members: [member], intents: [], contexts: [], recipes: [], cartItems: [], chatMessages: [],
    },
  };
}

export function harnessFailureCodeForTool(toolName: string | undefined) {
  if (toolName === "resolveRecipe") return "HARNESS_RECIPE_FAILED" as const;
  if (["searchProducts", "inspectProduct"].includes(toolName ?? "")) return "HARNESS_CATALOG_FAILED" as const;
  return "HARNESS_AGENT_FAILED" as const;
}

type DebugHarnessFailureCode = ReturnType<typeof harnessFailureCodeForTool>
  | "HARNESS_RECIPE_SOURCE_FAILED"
  | "HARNESS_RECIPE_NORMALIZER_FAILED";

class DebugHarnessRunError extends Error {
  readonly code: DebugHarnessFailureCode;

  constructor(toolName: string | undefined, code?: DebugHarnessFailureCode) {
    super("AI Debug harness run failed.");
    this.code = code ?? harnessFailureCodeForTool(toolName);
  }
}

export async function runDebugHarness(input: unknown, dependencies: HarnessDependencies = {}) {
  const request = HarnessInputSchema.parse(input);
  const session = dependencies.session ?? createDebugHarnessSession();
  const limits = resolveDebugPartyLimits(dependencies.environment);
  const repository = createInMemoryRepository(session);
  const gateway = dependencies.createGateway?.(request.mcpAccessToken) ?? createTemporaryGateway(request.mcpAccessToken);
  const model = dependencies.model ?? createDebugPartyModel(dependencies.environment);
  const candidatePreselector = dependencies.candidatePreselector ?? createDebugCandidatePreselector(dependencies.environment);
  const cartTools = createLocalCartTools({
    partyId: PARTY_ID, code: PARTY_CODE, actorId: ACTOR_ID, hostId: ACTOR_ID, runId: crypto.randomUUID(), repository, catalogGateway: gateway,
    candidatePreselector,
    selectionContext: () => ({ request: request.message, constraints: { dietaryRestrictions: [], favorites: [], recentProductNames: [] } }),
  });
  const tools: ToolSet = cartTools;
  let reply: string | undefined;
  let activeToolName: string | undefined;
  let lastFailedToolName: string | undefined;
  let lastFailureCode: DebugHarnessFailureCode | undefined;
  session.trace = [];
  const complete = {
    description: "Finish with a concise Ukrainian reply.",
    inputSchema: z.strictObject({ reply: z.string().trim().min(1).max(500) }),
    execute: async ({ reply: value }: { reply: string }) => {
      reply = value.slice(0, 240);
      return { completed: true, reply };
    },
  };
  const resolveRecipe = {
    description: "Retrieve one sourced recipe and its normalized grocery ingredients. This does not mutate a Silpo cart.",
    inputSchema: z.strictObject({ query: z.string().trim().min(1).max(200), url: z.url().optional() }),
    execute: async ({ query, url }: { query: string; url?: string }) => {
      let sourceRecipe: Recipe;
      try {
        sourceRecipe = await (dependencies.retrieveRecipe ?? retrieveRecipe)({ dishName: query, requestedUrl: url });
      } catch {
        lastFailureCode = "HARNESS_RECIPE_SOURCE_FAILED";
        throw new Error("Recipe source is unavailable.");
      }
      let normalized: Recipe;
      try {
        normalized = await normalizeRecipeForCart(sourceRecipe, dependencies.recipeNormalizer ?? createRecipeNormalizer(dependencies.environment));
      } catch {
        lastFailureCode = "HARNESS_RECIPE_NORMALIZER_FAILED";
        throw new Error("Recipe normalization is unavailable.");
      }
      const timestamp = new Date().toISOString();
      const saved = {
        id: crypto.randomUUID(), partyId: PARTY_ID, recipeId: normalized.id, title: normalized.title, sourceUrl: normalized.source.url ?? null,
        baseServings: normalized.baseServings, ingredients: normalized.ingredients, createdAt: timestamp, updatedAt: timestamp,
      };
      session.workspace.recipes = [...session.workspace.recipes.filter((recipe) => recipe.recipeId !== saved.recipeId), saved];
      return {
        title: saved.title, sourceUrl: saved.sourceUrl, servings: saved.baseServings,
        ingredients: saved.ingredients.map(({ name, quantity, unit, optional }) => ({ name, quantity, unit, optional })),
        partyRequirements: mergedRecipeRequirements(session.workspace.recipes),
      };
    },
  };
  const agentTools: ToolSet = { ...tools, resolveRecipe, complete };
  try {
    const agent = new ToolLoopAgent<never, ToolSet>({
      model, instructions, tools: agentTools, activeTools: Object.keys(agentTools), toolOrder: Object.keys(agentTools), maxRetries: 0,
      stopWhen: [isStepCount(limits.maxSteps), () => reply !== undefined],
      onToolExecutionStart: ({ toolCall }) => { activeToolName = toolCall.toolName; },
      onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
        const metadata = traceMetadata(toolCall.toolName, toolCall.input, toolOutput);
        if (toolOutput.type === "tool-error") lastFailedToolName = toolCall.toolName;
        session.trace.push(DebugHarnessTraceSchema.parse({
          toolName: toolCall.toolName,
          status: toolOutput.type === "tool-error" ? "failed" : "completed",
          durationMs: Math.max(0, Math.round(toolExecutionMs)),
          ...metadata,
        }));
        activeToolName = undefined;
      },
    });
    await finishBeforeDeadline(
      agent.generate({
        prompt: JSON.stringify({ message: request.message, cart: compactCart(session.workspace), recipeRequirements: mergedRecipeRequirements(session.workspace.recipes) }),
        abortSignal: AbortSignal.timeout(limits.totalMs),
        timeout: { totalMs: limits.totalMs, stepMs: limits.stepMs },
      }),
      limits.totalMs,
      () => new DebugHarnessRunError(activeToolName),
    );
  } catch {
    throw new DebugHarnessRunError(activeToolName ?? lastFailedToolName, lastFailureCode);
  } finally {
    await gateway.close().catch(() => undefined);
  }
  return { sessionId: session.id, reply: reply ?? "Не вдалося завершити. Спробуйте ще раз.", cart: compactCart(session.workspace), trace: session.trace };
}

async function finishBeforeDeadline<T>(operation: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createTemporaryGateway(accessToken: string): DebugCatalogGateway {
  return createDebugCatalogGateway({
    async openSession() {
      const { openSilpoMcpSessionWithAccessToken } = await import("@/lib/silpo/mcp");
      const session = await openSilpoMcpSessionWithAccessToken(accessToken);
      return { tools: session.tools, callTool: (request) => session.client.callTool(request), close: () => session.close() };
    },
  });
}

function createInMemoryRepository(session: DebugHarnessSession): Pick<DebugPartyRepository, "loadWorkspace" | "applyCartCommand" | "saveEvidence" | "findEvidence"> {
  return {
    async loadWorkspace(code, actorId) {
      if (code !== PARTY_CODE || actorId !== ACTOR_ID) throw new Error("Harness identity mismatch.");
      return session.workspace;
    },
    async findEvidence({ evidenceId }) {
      return session.evidence.get(evidenceId) ?? null;
    },
    async saveEvidence({ evidence }) {
      session.evidence.set(evidence.id, evidence);
      return evidence;
    },
    async applyCartCommand({ expectedRevision, mutation }) {
      if (expectedRevision !== session.workspace.party.cartRevision) return { status: "stale" as const, currentRevision: session.workspace.party.cartRevision };
      const itemId = applyMutation(session, mutation);
      const updatedAt = new Date().toISOString();
      session.workspace.party = { ...session.workspace.party, cartRevision: session.workspace.party.cartRevision + 1, updatedAt };
      return { status: "applied" as const, currentRevision: session.workspace.party.cartRevision, itemId };
    },
  };
}

function applyMutation(session: DebugHarnessSession, mutation: CartMutation) {
  const items = session.workspace.cartItems;
  if (mutation.type === "remove") {
    session.workspace.cartItems = items.filter((item) => item.id !== mutation.itemId);
    return mutation.itemId;
  }
  if (mutation.type === "quantity") {
    session.workspace.cartItems = items.map((item) => item.id === mutation.itemId ? { ...item, quantity: mutation.quantity, updatedAt: new Date().toISOString() } : item);
    return mutation.itemId;
  }
  const evidence = session.evidence.get(mutation.evidenceId);
  if (!evidence) throw new Error("Harness product evidence is missing.");
  const existing = mutation.type === "replace" ? items.find((item) => item.id === mutation.itemId) : undefined;
  const id = existing?.id ?? crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const next: DebugCartItem = {
    id, partyId: PARTY_ID, productId: evidence.productId, companyId: evidence.companyId, branchId: evidence.branchId,
    name: evidence.name, quantity: mutation.quantity, unit: evidence.unit, unitPriceCents: evidence.unitPriceCents,
    discountCents: evidence.discountCents, imageUrl: evidence.imageUrl, evidenceId: evidence.id, observedAt: evidence.observedAt,
    introducedRevision: session.workspace.party.cartRevision + 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
  };
  session.workspace.cartItems = mutation.type === "replace" ? items.map((item) => item.id === id ? next : item) : [...items, next];
  return id;
}

function compactCart(workspace: DebugPartyWorkspace) {
  return {
    revision: workspace.party.cartRevision,
    totalCents: workspace.cartItems.reduce((total, item) => total + Math.round(item.unitPriceCents * item.quantity), 0),
    items: workspace.cartItems.map((item) => ({ id: item.id, productId: item.productId, name: item.name, quantity: item.quantity, unit: item.unit, unitPriceCents: item.unitPriceCents, evidenceId: item.evidenceId })),
  };
}

function traceMetadata(toolName: string, input: unknown, toolOutput: unknown) {
  const selectedEvidenceId = input && typeof input === "object" && "evidenceId" in input && typeof input.evidenceId === "string" ? input.evidenceId : null;
  if (toolOutput && typeof toolOutput === "object" && "type" in toolOutput && toolOutput.type === "tool-error") {
    const error = "error" in toolOutput ? toolOutput.error : undefined;
    const message = error instanceof Error ? error.message : "";
    const match = message.match(/^MCP_READ:silpo_[a-z0-9_]{1,120}:(MCP_[A-Z0-9_-]{1,80})$/);
    return { trace: null, selectedEvidenceId, errorCode: match?.[1] ?? "TOOL_OPERATION_FAILED", recipe: null };
  }
  if (toolName === "searchProducts" && toolOutput && typeof toolOutput === "object" && "output" in toolOutput && input && typeof input === "object") {
    const output = toolOutput.output;
    if (output && typeof output === "object" && "products" in output && "queries" in input) {
      const candidates = "traceCandidates" in output ? output.traceCandidates : output.products;
      const preselection = "preselection" in output ? output.preselection : undefined;
      try { return { trace: catalogSearchTrace({ mcpTool: "silpo_find_products_batch", queries: input.queries, candidates, preselection }), selectedEvidenceId, errorCode: null, recipe: null }; }
      catch { return { trace: null, selectedEvidenceId, errorCode: null, recipe: null }; }
    }
  }
  if (toolName === "resolveRecipe" && toolOutput && typeof toolOutput === "object" && "output" in toolOutput) {
    const recipe = DebugHarnessTraceSchema.shape.recipe.unwrap().safeParse(toolOutput.output);
    return { trace: null, selectedEvidenceId, errorCode: null, recipe: recipe.success ? recipe.data : null };
  }
  return { trace: null, selectedEvidenceId, errorCode: null, recipe: null };
}
