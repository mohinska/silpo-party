import { describe, expect, it, vi } from "vitest";

import { confirmMealProposal } from "./proposal-lifecycle";
import type { MealProposal } from "./proposal-schemas";

const proposal: MealProposal = {
  id: "proposal-1", partyId: "party-1", status: "pending", currency: "UAH", budgetCents: 10000,
  dishes: [], recipes: [], mergedIngredients: [], estimatedTotalCents: 5000, budgetStatus: "within", alternatives: [], unresolved: [],
  productLines: [{ requirementKeys: ["milk"], productId: "p", companyId: "c", branchId: "b", name: "Milk", packageCount: 1, packageQuantity: 1, packageUnit: "piece", unitPriceCents: 5000, lineTotalCents: 5000 }],
  createdAt: "2026-09-10T00:00:00.000Z",
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadProposal: vi.fn(async () => proposal),
    loadManualLines: vi.fn(async () => [{ id: "manual", name: "Apples" }]),
    loadAiLines: vi.fn(async () => [{ id: "old-ai", productId: "old" }]),
    replaceAiLines: vi.fn(async () => undefined),
    writeCart: vi.fn(async () => undefined),
    readCart: vi.fn(async () => ({ lines: [{ productId: "p", companyId: "c", branchId: "b", quantity: 1 }] })),
    markProposal: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("proposal confirmation", () => {
  it("allows only the Host and does not mutate before confirmation", async () => {
    const deps = dependencies();
    await expect(confirmMealProposal({ partyId: "party-1", proposalId: "proposal-1", actorId: "guest", hostId: "host", confirmed: true }, deps)).rejects.toThrow(/host/i);
    expect(deps.writeCart).not.toHaveBeenCalled();
  });

  it("rejects without any cart mutation", async () => {
    const deps = dependencies();
    await confirmMealProposal({ partyId: "party-1", proposalId: "proposal-1", actorId: "host", hostId: "host", confirmed: false }, deps);
    expect(deps.writeCart).not.toHaveBeenCalled();
    expect(deps.markProposal).toHaveBeenCalledWith("proposal-1", "rejected");
  });

  it("preserves manual lines, writes AI lines, and validates final read-back", async () => {
    const deps = dependencies();
    await confirmMealProposal({ partyId: "party-1", proposalId: "proposal-1", actorId: "host", hostId: "host", confirmed: true }, deps);
    expect(deps.replaceAiLines).toHaveBeenCalledWith("party-1", proposal.productLines, [{ id: "manual", name: "Apples" }]);
    expect(deps.readCart).toHaveBeenCalledAfter(deps.writeCart);
    expect(deps.markProposal).toHaveBeenCalledWith("proposal-1", "applied");
  });

  it("keeps the proposal retryable on MCP failure or mismatched read-back", async () => {
    const failed = dependencies({ writeCart: vi.fn(async () => { throw new Error("Bearer private-token raw response"); }) });
    await expect(confirmMealProposal({ partyId: "party-1", proposalId: "proposal-1", actorId: "host", hostId: "host", confirmed: true }, failed)).rejects.not.toThrow(/private-token|raw response/i);
    expect(failed.markProposal).toHaveBeenCalledWith("proposal-1", "failed", expect.not.stringMatching(/private-token/i));

    const mismatch = dependencies({ readCart: vi.fn(async () => ({ lines: [] })) });
    await expect(confirmMealProposal({ partyId: "party-1", proposalId: "proposal-1", actorId: "host", hostId: "host", confirmed: true }, mismatch)).rejects.toThrow(/read-back/i);
  });

  it("does not leak raw MCP or token fields in its public error", async () => {
    const deps = dependencies({ readCart: vi.fn(async () => { throw { access_token: "secret", response: { private: true } }; }) });
    await expect(confirmMealProposal({ partyId: "party-1", proposalId: "proposal-1", actorId: "host", hostId: "host", confirmed: true }, deps)).rejects.toThrow("Silpo cart synchronization failed. You can retry safely.");
  });
});
