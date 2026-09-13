import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createHostCommerceAuthorityRepository, createPartyHostCommerceAuthorityRepository, resolveVerifiedHostCommerceAuthority, resolveVerifiedPartyHostCommerceAuthority, withVerifiedHostCommerce } from "./host-commerce";

describe("verified Host commerce authority", () => {
  it("binds a database operation's approved actor to its party Host", async () => {
    const repository = createHostCommerceAuthorityRepository(async operationId => operationId === "op" ? { partyId: "party", hostId: "host", approvedBy: "host" } : null);
    await expect(repository.resolveApprovedHost({ operationId: "op", actorId: "host" })).resolves.toEqual({ partyId: "party", hostId: "host", approvedBy: "host" });
    await expect(repository.resolveApprovedHost({ operationId: "op", actorId: "member" })).resolves.toBeNull();
  });
  it("issues authority only from a repository-bound approved Host operation", async () => {
    const calls: unknown[] = [];
    const authority = await resolveVerifiedHostCommerceAuthority({ operationId: "op", actorId: "host" }, {
      async resolveApprovedHost(input) { calls.push(input); return { partyId: "party", hostId: "host", approvedBy: "host" }; },
    });
    expect(calls).toEqual([{ operationId: "op", actorId: "host" }]);
    await expect(resolveVerifiedHostCommerceAuthority({ operationId: "op", actorId: "member" }, {
      async resolveApprovedHost() { return null; },
    })).rejects.toThrow(/host authority/i);
    await expect(withVerifiedHostCommerce({ hostId: "host" } as never, async () => "never")).rejects.toThrow(/verified host authority/i);
    expect(authority).toBeDefined();
  });
});

describe("verified party member commerce authority", () => {
  it("issues read authority for a current party member", async () => {
    const repository = createPartyHostCommerceAuthorityRepository(async ({ partyId, actorId }) => ({
      partyId,
      hostId: "host",
      memberPartyId: partyId,
      memberUserId: actorId,
    }));

    await expect(resolveVerifiedPartyHostCommerceAuthority({ partyId: "party", actorId: "member" }, repository)).resolves.toMatchObject({
      scope: "party_read",
      partyId: "party",
      hostId: "host",
    });
  });

  it("denies a nonmember even when the party host exists", async () => {
    const repository = createPartyHostCommerceAuthorityRepository(async ({ partyId }) => ({
      partyId,
      hostId: "host",
      memberPartyId: partyId,
      memberUserId: "another-member",
    }));

    await expect(resolveVerifiedPartyHostCommerceAuthority({ partyId: "party", actorId: "nonmember" }, repository)).rejects.toThrow(/party.*host.*authority/i);
  });

  it("denies mismatched party or membership rows", async () => {
    const repository = createPartyHostCommerceAuthorityRepository(async () => ({
      partyId: "other-party",
      hostId: "host",
      memberPartyId: "party",
      memberUserId: "member",
    }));

    await expect(resolveVerifiedPartyHostCommerceAuthority({ partyId: "party", actorId: "member" }, repository)).rejects.toThrow(/party.*host.*authority/i);
  });
});
