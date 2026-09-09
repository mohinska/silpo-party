const SENSITIVE_KEY =
  /(access.?token|refresh.?token|authorization|cookie|password|secret|ciphertext|api.?key)/i;

export type ParticipantContextResult =
  | { status: "available"; data: unknown }
  | { status: "unavailable"; reason: string };

export type ParticipantContextLoader = (
  participantId: string,
) => Promise<ParticipantContextResult>;

export type ParticipantContextTraceEntry =
  | {
      participantId: string;
      status: "available";
      sources?: string[];
      restrictionCount?: number;
      favoriteCount?: number;
      ambiguousFragmentCount?: number;
    }
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

  async function load({ participantId }: { participantId: string }) {
    if (!allowedIds.has(participantId)) {
      throw new Error(`Participant ${participantId} is not part of this event.`);
    }

    const loaded = await loader(participantId);
    const entry: ParticipantContextTraceEntry =
      loaded.status === "available"
        ? {
            participantId,
            status: "available",
          }
        : {
            participantId,
            status: "unavailable",
            reason: loaded.reason,
          };

    trace.push(entry);
    return loaded;
  }

  async function execute({ participantId }: { participantId: string }) {
    await load({ participantId });
    return trace.at(-1)!;
  }

  return { execute, load, trace };
}
