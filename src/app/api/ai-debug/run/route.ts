import { getCurrentUser } from "@/lib/auth";
import {
  createSingleParticipantDebugInput,
  serializeDebugError,
} from "@/lib/ai/planning/debug";
import {
  encodeDebugStreamEvent,
  type PlanningDebugEvent,
} from "@/lib/ai/planning/debug-stream";
import { planEvent } from "@/lib/ai/planning";
import { getPersonalSilpoContext } from "@/lib/silpo/mcp";

export const runtime = "nodejs";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const displayName =
    user.user_metadata.full_name ??
    user.user_metadata.name ??
    user.email ??
    "Користувач";
  const input = createSingleParticipantDebugInput({
    userId: user.id,
    displayName,
  });
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: PlanningDebugEvent) => {
        controller.enqueue(encoder.encode(encodeDebugStreamEvent(event)));
      };

      send({
        stage: "request",
        status: "started",
        at: new Date(startedAt).toISOString(),
        elapsedMs: 0,
        data: {
          provider: process.env.AI_PROVIDER?.trim() || "deepseek",
          baseUrl: process.env.AI_BASE_URL?.trim() || "not configured",
          normalizerModel:
            process.env.AI_NORMALIZER_MODEL?.trim() || "deepseek-v4-flash",
          plannerModel:
            process.env.AI_PLANNER_MODEL?.trim() || "deepseek-v4-flash",
          eventId: input.event.id,
          participantId: user.id,
        },
      });

      void (async () => {
        try {
          const result = await planEvent(input, {
            loadParticipantContext: async (participantId) => {
              if (participantId !== user.id) {
                throw new Error(
                  "Debug context access is limited to the current user.",
                );
              }

              const context = await getPersonalSilpoContext(user.id);
              return context
                ? { status: "available" as const, data: context }
                : {
                    status: "unavailable" as const,
                    reason:
                      "Silpo account is not connected or context is unavailable.",
                  };
            },
            onDebugEvent: send,
          });

          send({
            stage: "result",
            status: "completed",
            at: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
            durationMs: Date.now() - startedAt,
            data: { input, result },
          });
        } catch (error) {
          const serialized = serializeDebugError(error);
          send({
            stage: "result",
            status: "failed",
            at: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
            durationMs: Date.now() - startedAt,
            error: {
              name: serialized.name,
              message: serialized.message,
              ...(serialized.issues
                ? { stack: JSON.stringify(serialized.issues, null, 2) }
                : {}),
            },
          });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
