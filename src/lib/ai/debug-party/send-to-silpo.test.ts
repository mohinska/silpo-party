import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendFrozenDebugCart } from "./send-to-silpo";

const now = "2026-09-10T12:00:00.000Z";
const hostId = "host";
const memberId = "member";

function snapshot(items = [snapshotItem()]) {
  return {
    id: "snapshot", partyId: "party", cartRevision: 4, totalCents: 1200,
    finalizedAt: now, items,
  };
}

function snapshotItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "line-milk", snapshotId: "snapshot", productId: "milk", companyId: "company", branchId: "branch",
    name: "Milk", quantity: 2, unit: "1 л", unitPriceCents: 600, discountCents: null,
    imageUrl: null, evidenceId: "evidence", observedAt: now, createdAt: now,
    ...overrides,
  };
}

function setup(overrides: {
  party?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  live?: Array<Record<string, unknown>>;
  cart?: Array<Record<string, unknown>>;
  apply?: (host: string, lines: unknown[]) => Promise<Array<Record<string, unknown>>>;
  priorRun?: Record<string, unknown> | null;
} = {}) {
  const writes: Record<string, unknown>[] = [];
  const repository = {
    loadFrozenSnapshot: vi.fn(async () => ({
      party: { id: "party", hostId, status: "finalized", ...overrides.party },
      snapshot: overrides.snapshot ?? snapshot(),
    })),
    findSendRun: vi.fn(async () => overrides.priorRun ?? null),
    saveSendRun: vi.fn(async (run) => writes.push(run)),
    markPartySent: vi.fn(async () => undefined),
  };
  const cart = {
    revalidate: vi.fn(async () => overrides.live ?? [{
      productId: "milk", companyId: "company", branchId: "branch", available: true, unitPriceCents: 600,
    }]),
    readCart: vi.fn(async () => overrides.cart ?? []),
    applyLines: vi.fn(overrides.apply ?? (async (_host, lines) => lines.map((line) => ({ itemId: (line as { id: string }).id, status: "applied" })))),
  };
  return { repository, cart, writes };
}

describe("sendFrozenDebugCart", () => {
  it("rejects members and parties that are not finalized before opening the Host cart", async () => {
    const member = setup();
    await expect(sendFrozenDebugCart({ code: "ABCDEFGH", actorId: memberId, confirmChanges: false }, member)).rejects.toThrow("Організатор");
    expect(member.cart.revalidate).not.toHaveBeenCalled();

    const unfinished = setup({ party: { status: "ready" } });
    await expect(sendFrozenDebugCart({ code: "ABCDEFGH", actorId: hostId, confirmChanges: false }, unfinished)).rejects.toThrow("фінал");
    expect(unfinished.cart.revalidate).not.toHaveBeenCalled();
  });

  it("keeps the parsed frozen snapshot immutable while it validates current products", async () => {
    const state = setup();
    const frozen = Object.freeze(snapshot([Object.freeze(snapshotItem())]));
    state.repository.loadFrozenSnapshot.mockResolvedValueOnce({ party: { id: "party", hostId, status: "finalized" }, snapshot: frozen });

    await sendFrozenDebugCart({ code: "ABCDEFGH", actorId: hostId, confirmChanges: true }, state);

    expect(frozen).toEqual(snapshot());
    expect(state.writes.at(-1)).toMatchObject({ lineResults: [{ itemId: "line-milk", status: "applied" }] });
  });

  it("requires Host confirmation for live price or availability changes without mutating the cart", async () => {
    const state = setup({ live: [{ productId: "milk", companyId: "company", branchId: "branch", available: false, unitPriceCents: 750 }] });

    await expect(sendFrozenDebugCart({ code: "ABCDEFGH", actorId: hostId, confirmChanges: false }, state)).resolves.toMatchObject({
      status: "confirmation_required",
      changes: [{ itemId: "line-milk", available: false, unitPriceCents: 750 }],
    });
    expect(state.cart.applyLines).not.toHaveBeenCalled();
  });

  it("returns the completed idempotency result without duplicate external writes", async () => {
    const state = setup({ priorRun: { id: "run", status: "completed", lineResults: [{ itemId: "line-milk", status: "applied" }] } });

    await expect(sendFrozenDebugCart({ code: "ABCDEFGH", actorId: hostId, confirmChanges: true }, state)).resolves.toMatchObject({ status: "completed", idempotent: true });
    expect(state.cart.revalidate).not.toHaveBeenCalled();
    expect(state.cart.applyLines).not.toHaveBeenCalled();
  });

  it("records a retryable per-line failure when the external cart mutation aborts", async () => {
    const state = setup({ apply: async () => { throw new Error("MCP timed out"); } });

    await expect(sendFrozenDebugCart({ code: "ABCDEFGH", actorId: hostId, confirmChanges: true }, state)).resolves.toMatchObject({
      status: "partial", lineResults: [{ itemId: "line-milk", status: "failed" }],
    });
    expect(state.writes.at(-1)).toMatchObject({ status: "partial", lineResults: [{ itemId: "line-milk", status: "failed" }] });
  });

  it("reconciles a partial retry against the real cart before writing only unfinished lines", async () => {
    const second = snapshotItem({ id: "line-bread", productId: "bread", name: "Bread", quantity: 1, unitPriceCents: 500 });
    const state = setup({
      snapshot: snapshot([snapshotItem(), second]),
      live: [
        { productId: "milk", companyId: "company", branchId: "branch", available: true, unitPriceCents: 600 },
        { productId: "bread", companyId: "company", branchId: "branch", available: true, unitPriceCents: 500 },
      ],
      cart: [{ productId: "milk", companyId: "company", branchId: "branch", quantity: 2 }],
      priorRun: { id: "run", status: "partial", lineResults: [{ itemId: "line-milk", status: "applied" }, { itemId: "line-bread", status: "failed" }] },
    });

    await expect(sendFrozenDebugCart({ code: "ABCDEFGH", actorId: hostId, confirmChanges: true }, state)).resolves.toMatchObject({ status: "completed" });
    expect(state.cart.applyLines).toHaveBeenCalledWith(hostId, [expect.objectContaining({ id: "line-bread" })]);
    expect(state.writes.at(-1)).toMatchObject({ status: "completed", lineResults: expect.arrayContaining([
      { itemId: "line-milk", status: "already_applied" }, { itemId: "line-bread", status: "applied" },
    ]) });
  });
});
