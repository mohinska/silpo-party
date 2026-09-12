import { timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import { parseIntentDelta } from "@/lib/ai/agents/intent";
import { searchQueriesForHarness } from "@/lib/ai/agents/harness-queries";
import { runSupervisorDecision } from "@/lib/ai/agents/supervisor";
import { createConfiguredPlanningProvider } from "@/lib/ai/planning/provider";
import { aggregateIngredients, scaleRecipe } from "@/lib/ai/planning/meal-proposal";
import { normalizeRecipeForCart } from "@/lib/ai/planning/recipe-agent";
import { retrieveRecipeForRequest } from "@/lib/ai/planning/recipe-retrieval";
import { findSilpoProductsBatchWithAccessToken } from "@/lib/silpo/cart";

const RequestSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  mcpAccessToken: z.string().trim().min(1).max(16_000),
  sessionId: z.string().uuid().optional(),
}).strict();

const CandidateSchema = z.object({
  productId: z.string().max(200),
  companyId: z.string().max(200),
  branchId: z.string().max(200),
  name: z.string().max(500),
  priceCents: z.number().int().nonnegative().nullable(),
  displayRatio: z.string().max(200).nullable(),
}).strict();

const TraceSchema = z.object({
  id: z.string().uuid(),
  stage: z.enum(["intent", "supervisor", "recipe", "ingredients", "product_search"]),
  status: z.enum(["completed", "failed"]),
  durationMs: z.number().int().nonnegative(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().max(100).optional(),
}).strict();

const ResponseSchema = z.object({
  sessionId: z.string().uuid(),
  reply: z.string().trim().min(1).max(1_000),
  trace: z.array(TraceSchema).max(100),
}).strict();

type Trace = z.infer<typeof TraceSchema>;
type HarnessSession = { messages: string[]; touchedAt: number };
const sessions = new Map<string, HarnessSession>();
const sessionLifetimeMs = 2 * 60 * 60 * 1_000;

function authorized(value: string | null) {
  const secret = process.env.AI_AGENT_HARNESS_SECRET;
  if (!secret || !value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function localRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function pruneSessions(now: number) {
  for (const [id, session] of sessions) if (now - session.touchedAt > sessionLifetimeMs) sessions.delete(id);
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/MCP|Silpo/i.test(message)) return "MCP_OPERATION_FAILED";
  if (/provider|AI|JSON/i.test(message)) return "AI_OPERATION_FAILED";
  return "AGENT_OPERATION_FAILED";
}

function elapsed(start: number) {
  return Math.max(0, Date.now() - start);
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" || !localRequest(request)) return Response.json({ error: "Not found." }, { status: 404 });
  if (!authorized(request.headers.get("authorization"))) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = RequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "Invalid harness request." }, { status: 400 });

  const now = Date.now();
  pruneSessions(now);
  const sessionId = body.data.sessionId && sessions.has(body.data.sessionId) ? body.data.sessionId : randomUUID();
  const session = sessions.get(sessionId) ?? { messages: [], touchedAt: now };
  session.messages.push(body.data.message);
  session.messages = session.messages.slice(-30);
  session.touchedAt = now;
  const trace: Trace[] = [];

  let provider: ReturnType<typeof createConfiguredPlanningProvider> | undefined;
  try { provider = createConfiguredPlanningProvider(); } catch { /* local fallback is still useful for MCP debugging */ }

  const intentStart = Date.now();
  let intent;
  try {
    intent = await parseIntentDelta(body.data.message, provider ? { generate: provider.participantNormalizerModel().generateJsonText } : undefined);
    trace.push({ id: randomUUID(), stage: "intent", status: "completed", durationMs: elapsed(intentStart), input: { message: body.data.message }, output: intent });
  } catch (error) {
    trace.push({ id: randomUUID(), stage: "intent", status: "failed", durationMs: elapsed(intentStart), errorCode: safeErrorCode(error) });
    return Response.json({ sessionId, reply: "Не вдалося розібрати повідомлення.", trace }, { status: 502 });
  }

  const supervisorStart = Date.now();
  const decision = await runSupervisorDecision({
    partyState: { hasIntent: true, hasBudget: true, hasProposal: false },
    message: body.data.message,
    generate: provider?.supervisorModel().generateJsonText,
  });
  trace.push({ id: randomUUID(), stage: "supervisor", status: "completed", durationMs: elapsed(supervisorStart), output: decision });

  const shouldResolveRecipe = Boolean(intent.dishName) && (intent.kind === "dish" || intent.kind === "recipe" || decision.actions.some((action) => action.type === "resolve_recipe" || action.type === "normalize_ingredients"));
  let ingredients: Array<{ name: string; variant: string }> | undefined;
  let recipeFailed = false;
  if (shouldResolveRecipe && intent.dishName) {
    const recipeStart = Date.now();
    try {
      const recipe = await retrieveRecipeForRequest({ dishName: intent.dishName, requestedUrl: intent.recipeUrl, targetServings: intent.servings });
      const scaledRecipe = scaleRecipe(recipe, intent.servings ?? recipe.baseServings);
      const shouldNormalize = decision.actions.some((action) => action.type === "normalize_ingredients");
      const normalizedRecipe = shouldNormalize && provider
        ? await normalizeRecipeForCart(scaledRecipe, async ({ system, recipe: signals }) => provider!.participantNormalizerModel().generateJsonText({ system, prompt: JSON.stringify(signals) }))
        : scaledRecipe;
      const mergedIngredients = aggregateIngredients(normalizedRecipe.ingredients.map((ingredient) => ({ dishId: normalizedRecipe.id, ...ingredient })));
      ingredients = mergedIngredients.map(({ name, variant }) => ({ name, variant }));
      trace.push({
        id: randomUUID(),
        stage: "recipe",
        status: "completed",
        durationMs: elapsed(recipeStart),
        input: { dishName: intent.dishName, servings: intent.servings ?? recipe.baseServings },
        output: { title: recipe.title, source: recipe.source, servings: scaledRecipe.baseServings },
      });
      trace.push({
        id: randomUUID(),
        stage: "ingredients",
        status: "completed",
        durationMs: 0,
        output: { ingredients: mergedIngredients.map(({ name, variant, quantity, unit, optional }) => ({ name, variant, quantity, unit, optional })) },
      });
    } catch (error) {
      recipeFailed = true;
      trace.push({ id: randomUUID(), stage: "recipe", status: "failed", durationMs: elapsed(recipeStart), input: { dishName: intent.dishName }, errorCode: safeErrorCode(error) });
    }
  }

  const queries = recipeFailed ? [] : searchQueriesForHarness({ intent, actions: decision.actions, ingredients });
  const candidates: Array<z.infer<typeof CandidateSchema>> = [];
  if (queries.length) {
    const searchStart = Date.now();
    try {
      const productsByQuery = await findSilpoProductsBatchWithAccessToken(body.data.mcpAccessToken, queries);
      for (const query of queries) {
        const safeProducts = (productsByQuery.get(query) ?? []).slice(0, 12).map((product) => CandidateSchema.parse({
        ...product,
        priceCents: product.priceCents ?? null,
        displayRatio: product.displayRatio ?? null,
        }));
        candidates.push(...safeProducts);
        trace.push({ id: randomUUID(), stage: "product_search", status: "completed", durationMs: elapsed(searchStart), input: { query }, output: { query, candidates: safeProducts } });
      }
    } catch (error) {
      for (const query of queries) trace.push({ id: randomUUID(), stage: "product_search", status: "failed", durationMs: elapsed(searchStart), input: { query }, errorCode: safeErrorCode(error) });
    }
  }

  sessions.set(sessionId, session);
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.productId, candidate])).values()];
  const reply = recipeFailed
    ? `${decision.reply} Не вдалося підтвердити рецепт, тому пошук товарів не запускався.`
    : uniqueCandidates.length
    ? `${decision.reply} Знайдено ${uniqueCandidates.length} підтверджених товарів.`
    : `${decision.reply} Підтверджених товарів не знайдено.`;
  return Response.json(ResponseSchema.parse({ sessionId, reply, trace }));
}
