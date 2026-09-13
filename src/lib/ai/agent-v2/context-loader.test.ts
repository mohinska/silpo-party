import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createParticipantContextLoader } from "./context-loader";

const partyId = "10000000-0000-4000-8000-000000000001";
const participantId = "00000000-0000-4000-8000-000000000001";

describe("participant-scoped context loader", () => {
  it("maps declared allergies/restrictions semantically and dislikes literally", async () => {
    const load = createParticipantContextLoader(partyId, {
      readMembershipProfile: async () => ({
        member: true,
        profile: {
          allergies: "peanut, milk",
          dietary_restrictions: "vegan",
          dislikes: "cilantro",
          preferences: "spicy; Ukrainian",
          updated_at: "2026-09-13T09:00:00.000Z",
        },
      }),
      readPersonalFoodContext: async () => null,
      now: () => new Date("2026-09-13T10:00:00.000Z"),
    });
    const result = await load(participantId, "profile", 0);
    expect(result).toMatchObject({ status: "success", source: "profile", favorites: ["spicy", "Ukrainian"] });
    expect(result.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "semantic", value: "peanut", ownerId: participantId }),
      expect.objectContaining({ kind: "semantic", value: "vegan", ownerId: participantId }),
      expect.objectContaining({ kind: "exclude_term", value: "cilantro", ownerId: participantId }),
    ]));
  });

  it("treats explicitly empty profile and Silpo tool arrays as known-none", async () => {
    const load = createParticipantContextLoader(partyId, {
      readMembershipProfile: async () => ({ member: true, profile: { allergies: "", dietary_restrictions: "", dislikes: "", preferences: "", updated_at: "2026-09-13T09:00:00.000Z" } }),
      readPersonalFoodContext: async () => ({
        silpo_get_my_food_restrictions: { structuredContent: { restrictions: [] } },
        silpo_get_my_favorites: { structuredContent: { items: [] } },
      }),
      now: () => new Date("2026-09-13T10:00:00.000Z"),
    });
    await expect(load(participantId, "profile", 0)).resolves.toMatchObject({ status: "success", rules: [], favorites: [] });
    await expect(load(participantId, "silpo", 0)).resolves.toMatchObject({ status: "success", rules: [], favorites: [] });
  });

  it("retains previous values through an error refresh and denies nonmembers", async () => {
    const failed = createParticipantContextLoader(partyId, {
      readMembershipProfile: async () => { throw new Error("database unavailable"); },
      readPersonalFoodContext: async () => null,
      now: () => new Date("2026-09-13T10:00:00.000Z"),
    });
    await expect(failed(participantId, "profile", 7)).resolves.toMatchObject({ status: "error", version: 8, errorCode: "context_unavailable" });

    const denied = createParticipantContextLoader(partyId, {
      readMembershipProfile: async () => ({ member: false, profile: null }),
      readPersonalFoodContext: async () => null,
      now: () => new Date("2026-09-13T10:00:00.000Z"),
    });
    await expect(denied(participantId, "profile", 0)).rejects.toThrow(/membership/i);
  });
});
