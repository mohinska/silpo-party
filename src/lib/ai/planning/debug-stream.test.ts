import { describe, expect, it } from "vitest";

import {
  encodeDebugStreamEvent,
  parseDebugStreamChunk,
  sanitizePlanningDebugEvent,
  type PlanningDebugEvent,
} from "./debug-stream";

describe("parseDebugStreamChunk", () => {
  it("keeps an incomplete NDJSON record for the next chunk", () => {
    const first = parseDebugStreamChunk(
      "",
      '{"stage":"input","status":"started","at":"2026-09-09T12:00:00.000Z","elapsedMs":0}\n{"stage":"con',
    );

    expect(first.events).toHaveLength(1);
    expect(first.remainder).toBe('{"stage":"con');

    const second = parseDebugStreamChunk(
      first.remainder,
      'text","status":"started","at":"2026-09-09T12:00:01.000Z","elapsedMs":1000}\n',
    );

    expect(second.events).toEqual<PlanningDebugEvent[]>([
      {
        stage: "context",
        status: "started",
        at: "2026-09-09T12:00:01.000Z",
        elapsedMs: 1000,
      },
    ]);
    expect(second.remainder).toBe("");
  });
});

describe("debug stream serialization", () => {
  it("redacts credential fields while preserving inspectable payloads", () => {
    const event: PlanningDebugEvent = {
      stage: "context",
      status: "completed",
      at: "2026-09-09T12:00:00.000Z",
      elapsedMs: 15,
      data: {
        headers: { authorization: "Bearer private-token" },
        structuredContent: { items: [{ name: "Тофу" }] },
      },
    };

    expect(sanitizePlanningDebugEvent(event)).toMatchObject({
      data: {
        headers: { authorization: "[REDACTED]" },
        structuredContent: { items: [{ name: "Тофу" }] },
      },
    });
    expect(encodeDebugStreamEvent(event)).toMatch(/\n$/);
    expect(encodeDebugStreamEvent(event)).not.toContain("private-token");
  });
});
