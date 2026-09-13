import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadAgentV2Presentation } from "./presentation";

const partyId = "10000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000001";
const draft = {
  schemaVersion: 2 as const,
  partyId,
  inputRevision: 3,
  draftRevision: 4,
  ready: true,
  lines: [{ productId: "rice", name: "Rice", companyId: "c", branchId: "b", packageCount: 2, packageQuantity: 500, packageUnit: "g" as const, unitPriceCents: 1000, lineTotalCents: 2000, eaterIds: [actorId] }],
  totalCents: 2000,
  unresolvedCount: 0,
  blockerCodes: [],
};

describe("agent v2 public presentation", () => {
  it("rejects a server caller that is not a current party member", async () => {
    await expect(loadAgentV2Presentation({ partyId, actorId }, {
      isMember: async () => false,
      readState: async () => { throw new Error("must not read"); },
    })).rejects.toThrow(/membership/i);
  });

  it("derives ready, stale, pending and applied state without private fields", async () => {
    const result = await loadAgentV2Presentation({ partyId, actorId }, {
      isMember: async () => true,
      readState: async () => ({
        workspace: { inputRevision: 3, draftRevision: 4, sourceRevision: 8, processedSourceRevision: 8 },
        draft,
        activity: { code: "completed", createdAt: "2026-09-13T12:00:00.000Z" },
        operation: { id: "20000000-0000-4000-8000-000000000001", draftRevision: 4, status: "verified", updatedAt: "2026-09-13T12:01:00.000Z" },
        activeJobs: 0,
      }),
    });
    expect(result).toMatchObject({ draft, ready: true, stale: false, pending: false, appliedRevision: 4, operationId: "20000000-0000-4000-8000-000000000001", operationStatus: "verified" });
    expect(JSON.stringify(result)).not.toMatch(/workspace|private|evidence|checkpoint/i);
  });

  it("marks an otherwise-ready draft stale while newer source work exists", async () => {
    const result = await loadAgentV2Presentation({ partyId, actorId }, {
      isMember: async () => true,
      readState: async () => ({
        workspace: { inputRevision: 3, draftRevision: 4, sourceRevision: 9, processedSourceRevision: 8 },
        draft,
        activity: { code: "queued", createdAt: "2026-09-13T12:00:00.000Z" },
        operation: null,
        activeJobs: 1,
      }),
    });
    expect(result).toMatchObject({ ready: false, stale: true, pending: true, appliedRevision: null });
  });

  it("keeps an approved pre-write operation resumable from the exact ready revision", async () => {
    const result = await loadAgentV2Presentation({ partyId, actorId }, {
      isMember: async () => true,
      readState: async () => ({
        workspace: { inputRevision: 3, draftRevision: 4, sourceRevision: 8, processedSourceRevision: 8 },
        draft,
        activity: { code: "cart_approved", createdAt: "2026-09-13T12:00:00.000Z" },
        operation: { id: "20000000-0000-4000-8000-000000000001", draftRevision: 4, status: "approved", updatedAt: "2026-09-13T12:01:00.000Z" },
        activeJobs: 0,
      }),
    });

    expect(result).toMatchObject({ ready: true, stale: false, pending: false, appliedRevision: null, operationStatus: "approved" });
  });
});
