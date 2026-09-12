import { describe, expect, it } from "vitest";

import {
  encodeTraceStreamEvent,
  parseTraceStreamChunk,
  sanitizePlanningTraceEvent,
  type PlanningTraceEvent,
} from "./trace-stream";

describe("parseTraceStreamChunk", () => {
  it("keeps an incomplete NDJSON record for the next chunk", () => {
    const first = parseTraceStreamChunk(
      "",
      '{"stage":"input","status":"started","at":"2026-09-09T12:00:00.000Z","elapsedMs":0}\n{"stage":"con',
    );

    expect(first.events).toHaveLength(1);
    expect(first.remainder).toBe('{"stage":"con');

    const second = parseTraceStreamChunk(
      first.remainder,
      'text","status":"started","at":"2026-09-09T12:00:01.000Z","elapsedMs":1000}\n',
    );

    expect(second.events).toEqual<PlanningTraceEvent[]>([
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

describe("trace stream serialization", () => {
  it("redacts credential fields while preserving inspectable payloads", () => {
    const event: PlanningTraceEvent = {
      stage: "context",
      status: "completed",
      at: "2026-09-09T12:00:00.000Z",
      elapsedMs: 15,
      data: {
        headers: { authorization: "Bearer private-token" },
        structuredContent: { items: [{ name: "Тофу" }] },
      },
    };

    expect(sanitizePlanningTraceEvent(event)).toMatchObject({
      data: {
        headers: { authorization: "[REDACTED]" },
        structuredContent: { items: [{ name: "Тофу" }] },
      },
    });
    expect(encodeTraceStreamEvent(event)).toMatch(/\n$/);
    expect(encodeTraceStreamEvent(event)).not.toContain("private-token");
  });
});
