import { describe, expect, it } from "vitest";

import {
  DebugPartyRepository,
  type DebugPartyPersistencePort,
} from "./repository";

const now = "2026-09-10T09:00:00.000Z";

const party = {
  id: "party-1",
  code: "ABCDEFGH",
  host_id: "user-host",
  budget_cents: null,
  status: "ready",
  cart_revision: 4,
  cart_stale: false,
  created_at: now,
  updated_at: now,
};

const hostMember = {
  party_id: "party-1",
  participant_id: "user-host",
  role: "host",
  context_status: "ready",
  joined_at: now,
  updated_at: now,
};

function port(overrides: Partial<DebugPartyPersistencePort> = {}): DebugPartyPersistencePort {
  return {
    findWorkspace: async () => ({ party, members: [hostMember], intents: [], contexts: [], cartItems: [] }),
    findMembership: async (_partyId, participantId) => participantId === "user-host" ? hostMember : null,
    insertRun: async (input) => ({
      id: "run-1",
      party_id: input.partyId,
      actor_id: input.actorId,
      mode: input.mode,
      status: "running",
      message_id: input.messageId ?? null,
      intent_revision: input.intentRevision ?? null,
      model: input.model ?? null,
      max_steps: input.maxSteps ?? null,
      error: null,
      started_at: now,
      finished_at: null,
      created_at: now,
      updated_at: now,
    }),
    insertToolEvent: async () => undefined,
    upsertContext: async (input) => input.context,
    advanceCartRevision: async () => ({ status: "stale", currentRevision: 4 }),
    updateRun: async () => undefined,
    insertEvidence: async () => undefined,
    findEvidence: async () => null,
    ...overrides,
  };
}

describe("DebugPartyRepository", () => {
  it("rejects a user who is not a party participant", async () => {
    const repository = new DebugPartyRepository(port({ findWorkspace: async () => null }));

    await expect(repository.loadWorkspace("ABCDEFGH", "user-outsider")).rejects.toThrow("учасник");
  });

  it("uses the persisted membership role for Host-only runs, not party metadata", async () => {
    const memberRole = { ...hostMember, role: "member" as const };
    const repository = new DebugPartyRepository(port({ findMembership: async () => memberRole }));

    await expect(repository.startRun({ partyId: "party-1", actorId: "user-host", mode: "build" })).rejects.toThrow("Host");
  });

  it("returns the current revision when an atomic cart update is stale", async () => {
    const repository = new DebugPartyRepository(port());

    await expect(repository.applyCartCommand({
      partyId: "party-1",
      actorId: "user-host",
      expectedRevision: 3,
      mutation: { type: "add", evidenceId: "evidence-1", quantity: 1 },
    })).resolves.toEqual({ status: "stale", currentRevision: 4 });
  });

  it("returns the single revision increment produced by the atomic RPC", async () => {
    const repository = new DebugPartyRepository(port({
      advanceCartRevision: async () => ({ status: "applied", currentRevision: 5, itemId: "item-1" }),
    }));

    await expect(repository.applyCartCommand({
      partyId: "party-1",
      actorId: "user-host",
      expectedRevision: 4,
      mutation: { type: "add", evidenceId: "evidence-1", quantity: 1 },
    })).resolves.toEqual({ status: "applied", currentRevision: 5, itemId: "item-1" });
  });

  it("maps internal database fields away before parsing a workspace row", async () => {
    const repository = new DebugPartyRepository(port());

    const workspace = await repository.loadWorkspace("ABCDEFGH", "user-host");

    expect(workspace.party).toMatchObject({ id: "party-1", cartRevision: 4 });
    expect(workspace.party).not.toHaveProperty("cartStale");
  });
});
