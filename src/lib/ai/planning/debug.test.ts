import { describe, expect, it } from "vitest";

import { createSingleParticipantDebugInput, serializeDebugError } from "./debug";
import { PlanningSafetyError } from "./errors";

describe("createSingleParticipantDebugInput", () => {
  it("creates an in-memory event for only the authenticated user", () => {
    const input = createSingleParticipantDebugInput({
      userId: "user-1",
      displayName: "Ірина",
      now: new Date("2026-09-09T12:00:00.000Z"),
    });

    expect(input.host.participantId).toBe("user-1");
    expect(input.participants).toHaveLength(1);
    expect(input.participants[0]).toMatchObject({
      id: "user-1",
      displayName: "Ірина",
      contextCompleteness: "unknown",
      foodIntent: { kind: "none" },
    });
    expect(input.event.startsAt).toBe("2026-09-10T12:00:00.000Z");
  });
});

describe("serializeDebugError", () => {
  it("preserves machine-readable safety issues", () => {
    const result = serializeDebugError(
      new PlanningSafetyError([
        {
          code: "missing_check",
          message: "Missing safety check.",
          participantId: "user-1",
        },
      ]),
    );

    expect(result).toEqual({
      name: "PlanningSafetyError",
      message: "Missing safety check.",
      issues: [
        {
          code: "missing_check",
          message: "Missing safety check.",
          participantId: "user-1",
        },
      ],
    });
  });
});
