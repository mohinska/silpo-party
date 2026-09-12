import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { runPartyAgentRun } from "@/lib/ai/agents/party-runner";

const RequestSchema = z.object({ runId: z.string().uuid().optional() }).strict();

function authorized(request: Request) {
  const secret = process.env.AGENT_WORKER_SECRET;
  const value = request.headers.get("authorization");
  if (!secret || !value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = RequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "Invalid agent run request." }, { status: 400 });
  const runId = await runPartyAgentRun(body.data.runId);
  return Response.json({ runId });
}
