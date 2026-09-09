import { tool } from "ai";
import { z } from "zod";

const SENSITIVE_KEY =
  /(access.?token|refresh.?token|authorization|cookie|password|secret|ciphertext|api.?key)/i;

export type ParticipantContextResult =
  | { status: "available"; data: unknown }
  | { status: "unavailable"; reason: string };

export type ParticipantContextLoader = (
  participantId: string,
) => Promise<ParticipantContextResult>;

export type ParticipantContextTraceEntry =
  | { participantId: string; status: "available"; data: unknown }
  | { participantId: string; status: "unavailable"; reason: string };

export function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveData);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveData(nestedValue),
      ]),
    );
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return String(value);
}

export function createParticipantContextAccess({
  allowedParticipantIds,
  loader,
}: {
  allowedParticipantIds: string[];
  loader: ParticipantContextLoader;
}) {
  const allowedIds = new Set(allowedParticipantIds);
  const trace: ParticipantContextTraceEntry[] = [];

  async function execute({ participantId }: { participantId: string }) {
    if (!allowedIds.has(participantId)) {
      throw new Error(`Participant ${participantId} is not part of this event.`);
    }

    const loaded = await loader(participantId);
    const entry: ParticipantContextTraceEntry =
      loaded.status === "available"
        ? {
            participantId,
            status: "available",
            data: redactSensitiveData(loaded.data),
          }
        : {
            participantId,
            status: "unavailable",
            reason: loaded.reason,
          };

    trace.push(entry);
    return entry;
  }

  return { execute, trace };
}

export function createParticipantContextTool(
  access: ReturnType<typeof createParticipantContextAccess>,
) {
  return tool({
    description:
      "Fetch the current event participant's personal Silpo profile, food restrictions, and favorites. Missing data means unknown, not unrestricted.",
    inputSchema: z.object({
      participantId: z
        .string()
        .describe("Opaque participant ID copied exactly from the event input."),
    }),
    execute: access.execute,
  });
}
