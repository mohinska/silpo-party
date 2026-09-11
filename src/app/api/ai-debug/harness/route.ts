import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createDebugHarnessSession, runDebugHarness, type DebugHarnessSession } from "../../../../lib/ai/debug-party/harness";
import { DebugHarnessTraceSchema } from "../../../../lib/ai/debug-party/harness-contract";

const RequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2_000),
  mcpAccessToken: z.string().trim().min(1).max(16_000),
  sessionId: z.string().uuid().optional(),
});
const ResponseSchema = z.strictObject({
  sessionId: z.string().uuid(),
  reply: z.string().trim().min(1).max(240),
  cart: z.strictObject({
    revision: z.number().int().nonnegative(), totalCents: z.number().int().nonnegative(),
    items: z.array(z.strictObject({ id: z.string().min(1).max(200), productId: z.string().min(1).max(200), name: z.string().min(1).max(500), quantity: z.number().finite().positive(), unit: z.string().min(1).max(500), unitPriceCents: z.number().int().nonnegative(), evidenceId: z.string().min(1).max(200) })).max(100),
  }),
  trace: z.array(DebugHarnessTraceSchema).max(100),
});

const sessions = new Map<string, { session: DebugHarnessSession; touchedAt: number }>();
const sessionLifetimeMs = 2 * 60 * 60 * 1_000;
const HarnessFailureCodeSchema = z.enum([
  "HARNESS_AGENT_FAILED",
  "HARNESS_RECIPE_FAILED",
  "HARNESS_CATALOG_FAILED",
  "HARNESS_RUN_FAILED",
]);

function authorized(value: string | null) {
  const secret = process.env.AI_DEBUG_HARNESS_SECRET;
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
  for (const [id, entry] of sessions) if (now - entry.touchedAt > sessionLifetimeMs) sessions.delete(id);
}

function harnessFailureCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "HARNESS_RUN_FAILED";
  return HarnessFailureCodeSchema.safeParse(error.code).data ?? "HARNESS_RUN_FAILED";
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" || !localRequest(request)) return Response.json({ error: "Not found." }, { status: 404 });
  if (!authorized(request.headers.get("authorization"))) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = RequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "Invalid harness request." }, { status: 400 });
  const now = Date.now();
  pruneSessions(now);
  const existing = body.data.sessionId ? sessions.get(body.data.sessionId)?.session : undefined;
  const session = existing ?? createDebugHarnessSession();
  try {
    const result = ResponseSchema.parse(await runDebugHarness({ message: body.data.message, mcpAccessToken: body.data.mcpAccessToken }, { session }));
    sessions.set(result.sessionId, { session, touchedAt: now });
    return Response.json(result, { status: 200 });
  } catch (error) {
    return Response.json({ error: "Harness run failed.", code: harnessFailureCode(error) }, { status: 502 });
  }
}
