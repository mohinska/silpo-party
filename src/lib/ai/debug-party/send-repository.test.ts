import { describe, expect, it } from "vitest";

import { createFrozenDebugCartSendRepositoryFromClients } from "./send-repository";

const now = "2026-09-10T12:00:00.000Z";

type Call = { table: string; operation: string; value?: unknown };

function query(result: { data: unknown; error: unknown }, calls: Call[], table: string) {
  const chain = {
    select(value: string) { calls.push({ table, operation: "select", value }); return chain; },
    eq(column: string, value: unknown) { calls.push({ table, operation: `eq:${column}`, value }); return chain; },
    maybeSingle: async () => result,
    upsert: (value: unknown) => { calls.push({ table, operation: "upsert", value }); return Promise.resolve(result); },
    update: (value: unknown) => { calls.push({ table, operation: "update", value }); return chain; },
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  };
  return chain;
}

function setup() {
  const authenticatedCalls: Call[] = [];
  const adminCalls: Call[] = [];
  const responses: Record<string, { data: unknown; error: unknown }> = {
    debug_parties: { data: { id: "party", host_id: "host", status: "finalized" }, error: null },
    debug_party_members: { data: { participant_id: "host", role: "host" }, error: null },
    debug_cart_snapshots: { data: { id: "snapshot", party_id: "party", cart_revision: 3, total_cents: 1200, finalized_at: now }, error: null },
    debug_cart_snapshot_items: { data: [{
      id: "item", snapshot_id: "snapshot", product_id: "milk", company_id: "company", branch_id: "branch",
      name: "Milk", quantity: 2, unit: "1 л", unit_price_cents: 600, discount_cents: null,
      image_url: null, evidence_id: "evidence", observed_at: now, created_at: now,
    }], error: null },
    debug_send_runs: { data: { id: "run", status: "partial", line_results: [{ itemId: "item", status: "failed" }] }, error: null },
  };
  const repository = createFrozenDebugCartSendRepositoryFromClients({
    requireActor: async () => {},
    authenticated: { from: (table: string) => query(responses[table], authenticatedCalls, table) },
    admin: { from: (table: string) => query({ data: null, error: null }, adminCalls, table) },
  });
  return { repository, authenticatedCalls, adminCalls, responses };
}

describe("FrozenDebugCartSendRepository", () => {
  it("loads only the authenticated actor's finalized snapshot and maps database rows to the frozen schema", async () => {
    const state = setup();

    await expect(state.repository.loadFrozenSnapshot({ code: "ABCDEFGH", actorId: "host" })).resolves.toEqual({
      party: { id: "party", hostId: "host", status: "finalized" },
      snapshot: {
        id: "snapshot", partyId: "party", cartRevision: 3, totalCents: 1200, finalizedAt: now,
        items: [{ id: "item", snapshotId: "snapshot", productId: "milk", companyId: "company", branchId: "branch", name: "Milk", quantity: 2, unit: "1 л", unitPriceCents: 600, discountCents: null, imageUrl: null, evidenceId: "evidence", observedAt: now, createdAt: now }],
      },
    });
    expect(state.authenticatedCalls).toEqual(expect.arrayContaining([
      { table: "debug_parties", operation: "eq:code", value: "ABCDEFGH" },
      { table: "debug_party_members", operation: "eq:participant_id", value: "host" },
      { table: "debug_cart_snapshot_items", operation: "eq:snapshot_id", value: "snapshot" },
    ]));
  });

  it("refuses a missing authenticated membership before exposing a frozen snapshot", async () => {
    const state = setup();
    state.responses.debug_party_members = { data: null, error: null };

    await expect(state.repository.loadFrozenSnapshot({ code: "ABCDEFGH", actorId: "member" })).rejects.toThrow("учасником");
    expect(state.authenticatedCalls.some((call) => call.table === "debug_cart_snapshots")).toBe(false);
  });

  it("writes bounded line results under the deterministic party/idempotency key and marks only the Host party as sent", async () => {
    const state = setup();

    await state.repository.saveSendRun({ partyId: "party", snapshotId: "snapshot", actorId: "host", idempotencyKey: "snapshot", status: "partial", lineResults: [{ itemId: "item", status: "failed", error: "timeout" }], error: "timeout" });
    await state.repository.markPartySent({ partyId: "party", actorId: "host" });

    expect(state.adminCalls).toEqual(expect.arrayContaining([
      { table: "debug_send_runs", operation: "upsert", value: expect.objectContaining({ party_id: "party", snapshot_id: "snapshot", actor_id: "host", idempotency_key: "snapshot", status: "partial", line_results: [{ itemId: "item", status: "failed", error: "timeout" }] }) },
      { table: "debug_parties", operation: "update", value: expect.objectContaining({ status: "sent" }) },
      { table: "debug_parties", operation: "eq:host_id", value: "host" },
      { table: "debug_parties", operation: "eq:status", value: "finalized" },
    ]));
  });

  it("returns the persisted prior run without leaking database field names", async () => {
    const state = setup();

    await expect(state.repository.findSendRun({ partyId: "party", idempotencyKey: "snapshot" })).resolves.toEqual({
      id: "run", status: "partial", lineResults: [{ itemId: "item", status: "failed" }],
    });
  });
});
