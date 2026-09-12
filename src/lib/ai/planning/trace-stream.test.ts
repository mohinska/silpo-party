import { describe, expect, it } from "vitest";

import {
  encodeTraceStreamEvent,
  createPlanningTraceEmitter,
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
  it("keeps food payloads out of serialized traces", () => {
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

    expect(sanitizePlanningTraceEvent(event)).not.toHaveProperty("data.structuredContent");
    expect(JSON.stringify(sanitizePlanningTraceEvent(event))).not.toContain("Тофу");
    expect(encodeTraceStreamEvent(event)).toMatch(/\n$/);
    expect(encodeTraceStreamEvent(event)).not.toContain("private-token");
  });

  it("sanitizes events before sending them to a trace sink", () => {
    const events: PlanningTraceEvent[] = [];
    const emitter = createPlanningTraceEmitter((event) => events.push(event));

    emitter.completed("context", {
      raw: { silpo_get_my_favorites: { items: [{ name: "Тофу" }] } },
      status: "available",
    });

    expect(JSON.stringify(events)).not.toContain("Тофу");
    expect(events[0].data).toEqual({ status: "available" });
  });
});
