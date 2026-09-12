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
  return {
    ...event,
    ...(event.data === undefined
      ? {}
      : { data: redactSensitiveData(event.data) }),
  };
}

export function encodeTraceStreamEvent(event: PlanningTraceEvent): string {
  return `${JSON.stringify(sanitizePlanningTraceEvent(event))}\n`;
}

function errorDetails(error: unknown): PlanningTraceError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
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
      sink?.({ ...base(stage, "started", participantId), data });
    },
    completed(
      stage: PlanningTraceStage,
      data?: unknown,
      participantId?: string,
    ) {
      sink?.({ ...base(stage, "completed", participantId), data });
    },
    failed(stage: PlanningTraceStage, error: unknown, participantId?: string) {
      sink?.({
        ...base(stage, "failed", participantId),
        error: errorDetails(error),
      });
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
import { redactSensitiveData } from "./context";
