import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createMcpCommerceAdapter, type ListedCommerceTool } from "@/lib/ai/agent-v2/commerce-contract";
import { createParticipantContextLoader } from "@/lib/ai/agent-v2/context-loader";
import { runHarnessAgentTurn, type HarnessAgentState } from "@/lib/ai/agent-v2/harness-runtime";
import { createConfiguredAgentModel } from "@/lib/ai/planning/provider";
import { readToolData, withSilpoMcpAccessToken } from "@/lib/silpo/mcp";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  mcpAccessToken: z.string().trim().min(1).max(16_000),
  sessionId: z.uuid().optional(),
}).strict();

const TraceSchema = z.object({
  id: z.uuid(),
  stage: z.literal("agent_step"),
  status: z.enum(["completed", "failed"]),
  durationMs: z.number().int().nonnegative(),
  input: z.object({ step: z.number().int().positive() }).strict(),
  output: z.object({ status: z.string(), outcome: z.string(), finishReason: z.string(), evidenceIds: z.array(z.string()) }).strict(),
}).strict();

const ResponseSchema = z.object({
  sessionId: z.uuid(),
  reply: z.string().trim().min(1).max(1_000),
  trace: z.array(TraceSchema).max(20),
}).strict();

type HarnessSession = { state: HarnessAgentState | null; touchedAt: number };
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

async function personalFoodContext(accessToken: string) {
  return withSilpoMcpAccessToken(accessToken, async (client, tools) => {
    const names = ["silpo_get_my_food_restrictions", "silpo_get_my_favorites"];
    const entries = await Promise.all(names.filter(name => tools.has(name)).map(async name => [
      name,
      readToolData(await client.callTool({ name, arguments: {} })),
    ] as const));
    return Object.fromEntries(entries);
  });
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" || !localRequest(request)) return Response.json({ error: "Not found." }, { status: 404 });
  if (!authorized(request.headers.get("authorization"))) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = RequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "Invalid harness request." }, { status: 400 });

  const now = Date.now();
  pruneSessions(now);
  const sessionId = body.data.sessionId && sessions.has(body.data.sessionId) ? body.data.sessionId : randomUUID();
  const session = sessions.get(sessionId) ?? { state: null, touchedAt: now };
  let model: ReturnType<typeof createConfiguredAgentModel> | null = null;
  try { model = createConfiguredAgentModel(); } catch { /* Runtime records the unavailable model explicitly. */ }

  try {
    const result = await runHarnessAgentTurn(session.state, body.data.message, {
      model,
      withCommerce: operation => withSilpoMcpAccessToken(body.data.mcpAccessToken, async (client, tools) => {
        const listed = [...tools.values()] as ListedCommerceTool[];
        const adapter = createMcpCommerceAdapter(listed, (input, options) => client.callTool(input, undefined, options));
        return operation(adapter);
      }),
      loadContext: async (partyId, participantId, source, previousVersion) => {
        if (source === "profile") return { source, version: previousVersion + 1, status: "error", errorCode: "profile_unavailable_in_harness" };
        return createParticipantContextLoader(partyId, {
          readMembershipProfile: async (expectedPartyId, expectedParticipantId) => ({
            member: expectedPartyId === partyId && expectedParticipantId === participantId,
            profile: null,
          }),
          readPersonalFoodContext: () => personalFoodContext(body.data.mcpAccessToken),
        })(participantId, source, previousVersion);
      },
    });
    session.state = result.state;
    session.touchedAt = now;
    sessions.set(sessionId, session);
    const trace = result.trace.map(item => ({
      id: randomUUID(),
      stage: "agent_step" as const,
      status: item.status === "blocked" ? "failed" as const : "completed" as const,
      durationMs: item.durationMs,
      input: { step: item.step },
      output: { status: item.status, outcome: item.outcome, finishReason: item.finishReason, evidenceIds: item.evidenceIds },
    }));
    return Response.json(ResponseSchema.parse({ sessionId, reply: result.reply, trace }));
  } catch {
    return Response.json({ sessionId, reply: "Agent v2 harness завершився контрольованою помилкою.", trace: [] }, { status: 502 });
  }
}
