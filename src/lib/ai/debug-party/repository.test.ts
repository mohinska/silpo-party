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
  it("projects stale state and bounded run/tool metadata without raw outputs", async () => {
    const repository = new DebugPartyRepository(port({ findWorkspace: async () => ({
      party: { ...party, cart_stale: true }, members: [hostMember], intents: [], contexts: [], cartItems: [],
      runs: [{ id: "run-1", actor_id: "user-host", mode: "chat", status: "running", created_at: now, error: "secret error", prompt: "secret prompt" }],
      toolEvents: [{ id: "event-1", run_id: "run-1", tool_name: "searchProducts", status: "completed", duration_ms: 10, created_at: now,
        metadata: { count: 3, mcpTool: "silpo_find_products_batch", errorCode: "MCP_429", token: "secret" }, output: "secret output" }],
    }) }));
    const workspace = await repository.loadWorkspace("ABCDEFGH", "user-host");
    expect(workspace.cartStale).toBe(true);
    expect(workspace.runs).toEqual([{ id: "run-1", actorId: "user-host", mode: "chat", status: "running", createdAt: now }]);
    expect(workspace.toolEvents).toEqual([{ id: "event-1", runId: "run-1", toolName: "searchProducts", status: "completed", durationMs: 10, createdAt: now, count: 3, mcpTool: "silpo_find_products_batch", errorCode: "MCP_429" }]);
    expect(JSON.stringify(workspace)).not.toContain("secret");
  });

  it("returns the frozen snapshot independently of live cart rows", async () => {
    const repository = new DebugPartyRepository(port({ findWorkspace: async () => ({
      party: { ...party, status: "finalized" }, members: [hostMember], intents: [], contexts: [], cartItems: [],
      snapshot: { id: "snapshot", party_id: "party-1", cart_revision: 4, total_cents: 1250, finalized_at: now,
        items: [{ id: "frozen-item", snapshot_id: "snapshot", product_id: "product", company_id: "company", branch_id: "branch", name: "Вода", quantity: 1, unit: "шт", unit_price_cents: 1250, discount_cents: null, image_url: null, evidence_id: "evidence", observed_at: now, created_at: now }] },
      sendStatus: "partial",
    }) }));
    const workspace = await repository.loadWorkspace("ABCDEFGH", "user-host");
    expect(workspace.snapshot).toMatchObject({ id: "snapshot", totalCents: 1250, items: [{ name: "Вода" }] });
    expect(workspace.cartItems).toEqual([]);
    expect(workspace.sendStatus).toBe("partial");
  });

  it("authorizes chat against membership and derives attribution from the actor", async () => {
    const inserted: unknown[] = [];
    const repository = new DebugPartyRepository(port({ insertMessage: async (input) => {
      inserted.push(input);
      return { id: "message", party_id: input.partyId, participant_id: input.actorId, role: "user", content: input.content,
        status: "queued", created_at: now, updated_at: now };
    } }));
    await expect(repository.appendChatMessage("ABCDEFGH", "user-outsider", "Add water")).rejects.toThrow();
    expect(inserted).toEqual([]);
    expect(await repository.appendChatMessage("ABCDEFGH", "user-host", "  Add water  ")).toMatchObject({ participantId: "user-host", content: "Add water" });
    expect(inserted).toEqual([{ partyId: "party-1", actorId: "user-host", content: "Add water" }]);
  });

  it("denies member budget and finalization writes before persistence", async () => {
    const writes: string[] = [];
    const repository = new DebugPartyRepository(port({ findWorkspace: async () => ({ party,
      members: [{ ...hostMember, role: "member" }], intents: [], contexts: [], cartItems: [] }),
      updateBudget: async () => { writes.push("budget"); }, finalizeParty: async () => { writes.push("finalize"); return "snapshot"; } }));
    await expect(repository.saveBudget("ABCDEFGH", "user-host", 100)).rejects.toThrow("Host");
    await expect(repository.finalizeParty("ABCDEFGH", "user-host")).rejects.toThrow("Host");
    expect(writes).toEqual([]);
  });
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
