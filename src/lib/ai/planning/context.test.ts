import { describe, expect, it } from "vitest";

import { createParticipantContextAccess } from "./context";

describe("createParticipantContextAccess", () => {
  it("refuses participant IDs outside the current event", async () => {
    let loaderCalls = 0;
    const access = createParticipantContextAccess({
      allowedParticipantIds: ["p1"],
      loader: async () => {
        loaderCalls += 1;
        return { status: "available", data: {} };
      },
    });

    await expect(access.execute({ participantId: "p404" })).rejects.toThrow(
      /not part of this event/i,
    );
    expect(loaderCalls).toBe(0);
  });

  it("returns and traces an explicit unavailable result", async () => {
    const access = createParticipantContextAccess({
      allowedParticipantIds: ["p1"],
      loader: async () => ({
        status: "unavailable",
        reason: "Silpo account is not connected.",
      }),
    });

    const result = await access.execute({ participantId: "p1" });

    expect(result).toEqual({
      participantId: "p1",
      status: "unavailable",
      reason: "Silpo account is not connected.",
    });
    expect(access.trace).toEqual([result]);
  });

  it("keeps raw MCP data out of the trace", async () => {
    const access = createParticipantContextAccess({
      allowedParticipantIds: ["p1"],
      loader: async () => ({
        status: "available",
        data: {
          profile: { favoriteStore: "Le Silpo" },
          access_token: "secret-token",
          nested: { clientSecretCiphertext: "ciphertext", ordinaryKey: "kept" },
        },
      }),
    });

    const result = await access.execute({ participantId: "p1" });

    expect(result).toEqual({ participantId: "p1", status: "available" });
    expect(JSON.stringify(result)).not.toMatch(/Le Silpo|ordinaryKey|secret-token/);
    expect(access.trace).toEqual([result]);
  });
});
