export type PlanningTraceStage =
  | "request"
  | "input"
  | "context"
  | "signals"
  | "normalization"
  | "prompt"
  | "model"
  | "contract"
  | "safety"
  | "result";

export type PlanningTraceStatus = "started" | "completed" | "failed";

export type PlanningTraceError = {
  name: string;
  message: string;
  stack?: string;
};

export type PlanningTraceEvent = {
  stage: PlanningTraceStage;
  status: PlanningTraceStatus;
  at: string;
  elapsedMs: number;
  durationMs?: number;
  participantId?: string;
  data?: unknown;
  error?: PlanningTraceError;
};

export type PlanningTraceEventSink = (event: PlanningTraceEvent) => void;

export function sanitizePlanningTraceEvent(
  event: PlanningTraceEvent,
): PlanningTraceEvent {
  const safeData = event.data === undefined ? undefined : safeTraceData(event);
  const eventWithoutData = Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "data"),
  ) as Omit<PlanningTraceEvent, "data">;
  return {
    ...eventWithoutData,
    ...(safeData === undefined ? {} : { data: safeData }),
  };
}

function safeTraceData(event: PlanningTraceEvent): unknown {
  if (event.status === "failed") return undefined;
  const data = event.data && typeof event.data === "object"
    ? event.data as Record<string, unknown>
    : undefined;

  switch (event.stage) {
    case "context":
      return data?.status ? { status: data.status } : undefined;
    case "signals":
      return data?.signals && typeof data.signals === "object"
        ? { status: (data.signals as Record<string, unknown>).completeness }
        : undefined;
    case "normalization":
      return data?.mode ? { mode: data.mode } : undefined;
    case "safety":
      return data?.checks && Array.isArray(data.checks)
        ? { checkCount: data.checks.length }
        : undefined;
    case "input":
      return { status: event.status === "completed" ? "validated" : "received" };
    case "prompt":
    case "model":
    case "contract":
      return { status: event.status === "completed" ? "completed" : "started" };
    default:
      return undefined;
  }
}

export function encodeTraceStreamEvent(event: PlanningTraceEvent): string {
  return `${JSON.stringify(sanitizePlanningTraceEvent(event))}\n`;
}

function errorDetails(error: unknown): PlanningTraceError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.replace(/(?:Bearer\s+|token|secret|password|api.?key)[^\s]*/gi, "[REDACTED]").slice(0, 240),
    };
  }
  return { name: "UnknownError", message: String(error) };
}

export function createPlanningTraceEmitter(
  sink: PlanningTraceEventSink | undefined,
  now: () => number = Date.now,
) {
  const runStartedAt = now();
  const stageStarts = new Map<string, number>();
  const keyFor = (stage: PlanningTraceStage, participantId?: string) =>
    `${stage}:${participantId ?? "run"}`;

  function base(
    stage: PlanningTraceStage,
    status: PlanningTraceStatus,
    participantId?: string,
  ) {
    const timestamp = now();
    const stageStartedAt = stageStarts.get(keyFor(stage, participantId));
    return {
      stage,
      status,
      at: new Date(timestamp).toISOString(),
      elapsedMs: timestamp - runStartedAt,
      ...(stageStartedAt === undefined
        ? {}
        : { durationMs: timestamp - stageStartedAt }),
      ...(participantId ? { participantId } : {}),
    } satisfies PlanningTraceEvent;
  }

  return {
    started(
      stage: PlanningTraceStage,
      data?: unknown,
      participantId?: string,
    ) {
      stageStarts.set(keyFor(stage, participantId), now());
      sink?.(sanitizePlanningTraceEvent({ ...base(stage, "started", participantId), data }));
    },
    completed(
      stage: PlanningTraceStage,
      data?: unknown,
      participantId?: string,
    ) {
      sink?.(sanitizePlanningTraceEvent({ ...base(stage, "completed", participantId), data }));
    },
    failed(stage: PlanningTraceStage, error: unknown, participantId?: string) {
      sink?.(sanitizePlanningTraceEvent({
        ...base(stage, "failed", participantId),
        error: errorDetails(error),
      }));
    },
  };
}

export function parseTraceStreamChunk(
  previousRemainder: string,
  chunk: string,
): { events: PlanningTraceEvent[]; remainder: string } {
  const lines = `${previousRemainder}${chunk}`.split("\n");
  const remainder = lines.pop() ?? "";
  const events = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PlanningTraceEvent);
  return { events, remainder };
}
