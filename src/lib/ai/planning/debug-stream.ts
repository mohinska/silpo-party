export type PlanningDebugStage =
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

export type PlanningDebugStatus = "started" | "completed" | "failed";

export type PlanningDebugError = {
  name: string;
  message: string;
  stack?: string;
};

export type PlanningDebugEvent = {
  stage: PlanningDebugStage;
  status: PlanningDebugStatus;
  at: string;
  elapsedMs: number;
  durationMs?: number;
  participantId?: string;
  data?: unknown;
  error?: PlanningDebugError;
};

export type PlanningDebugEventSink = (event: PlanningDebugEvent) => void;

export function sanitizePlanningDebugEvent(
  event: PlanningDebugEvent,
): PlanningDebugEvent {
  return {
    ...event,
    ...(event.data === undefined
      ? {}
      : { data: redactSensitiveData(event.data) }),
  };
}

export function encodeDebugStreamEvent(event: PlanningDebugEvent): string {
  return `${JSON.stringify(sanitizePlanningDebugEvent(event))}\n`;
}

function errorDetails(error: unknown): PlanningDebugError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { name: "UnknownError", message: String(error) };
}

export function createPlanningDebugEmitter(
  sink: PlanningDebugEventSink | undefined,
  now: () => number = Date.now,
) {
  const runStartedAt = now();
  const stageStarts = new Map<string, number>();
  const keyFor = (stage: PlanningDebugStage, participantId?: string) =>
    `${stage}:${participantId ?? "run"}`;

  function base(
    stage: PlanningDebugStage,
    status: PlanningDebugStatus,
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
    } satisfies PlanningDebugEvent;
  }

  return {
    started(
      stage: PlanningDebugStage,
      data?: unknown,
      participantId?: string,
    ) {
      stageStarts.set(keyFor(stage, participantId), now());
      sink?.({ ...base(stage, "started", participantId), data });
    },
    completed(
      stage: PlanningDebugStage,
      data?: unknown,
      participantId?: string,
    ) {
      sink?.({ ...base(stage, "completed", participantId), data });
    },
    failed(stage: PlanningDebugStage, error: unknown, participantId?: string) {
      sink?.({
        ...base(stage, "failed", participantId),
        error: errorDetails(error),
      });
    },
  };
}

export function parseDebugStreamChunk(
  previousRemainder: string,
  chunk: string,
): { events: PlanningDebugEvent[]; remainder: string } {
  const lines = `${previousRemainder}${chunk}`.split("\n");
  const remainder = lines.pop() ?? "";
  const events = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PlanningDebugEvent);
  return { events, remainder };
}
import { redactSensitiveData } from "./context";
