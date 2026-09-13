import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createWorkspace } from "./state";
import { runAgentV2WorkerSlice } from "./worker";

const partyId = "10000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000001";

describe("v2 durable worker", () => {
  it("persists a blocked missing-model slice before its terminal acknowledgement", async () => {
    const calls: string[] = [];
    let acknowledged = "";
    const result = await runAgentV2WorkerSlice({
      workerId: "test-worker", model: null,
      repository: {
        claim: async () => ({ job_id: "20000000-0000-4000-8000-000000000001", party_id: partyId, event_id: "30000000-0000-4000-8000-000000000001", attempts: 1, fence: 1, input_revision: 0, draft_revision: 0, source_revision: 1, processed_source_revision: 0, step_sequence: 0, workspace: createWorkspace(partyId, [actorId]), checkpoint: {} }),
        checkpointAndAcknowledge: async input => { acknowledged = input.status; calls.push("checkpoint_and_ack"); },
      },
      readEvent: async () => ({ id: "30000000-0000-4000-8000-000000000001", actor_id: actorId, kind: "chat" as const, payload: { text: "rice" }, source_sequence: 1 }),
      readSteps: async () => [], budgetForParty: async () => null,
    });
    expect(result).toMatchObject({ status: "blocked" });
    expect(calls).toEqual(["checkpoint_and_ack"]);
    expect(acknowledged).toBe("queued");
  });

  it("resumes from the persisted SDK messages without replaying an earlier model call", async () => {
    const messages = [{ role: "assistant" as const, content: [{ type: "text" as const, text: "previous" }] }];
    let readAfter = -1;
    await runAgentV2WorkerSlice({
      workerId: "test-worker", model: null,
      repository: { claim: async () => ({ job_id: "20000000-0000-4000-8000-000000000001", party_id: partyId, event_id: "30000000-0000-4000-8000-000000000001", attempts: 1, fence: 2, input_revision: 0, draft_revision: 0, source_revision: 1, processed_source_revision: 0, step_sequence: 4, workspace: createWorkspace(partyId, [actorId]), checkpoint: {} }), checkpointAndAcknowledge: async () => {} },
      readEvent: async () => ({ id: "30000000-0000-4000-8000-000000000001", actor_id: actorId, kind: "chat" as const, payload: { text: "rice" }, source_sequence: 1 }),
      readSteps: async (_party, after) => { readAfter = after; return [{ step_sequence: 4, messages }]; }, budgetForParty: async () => null,
    });
    expect(readAfter).toBe(3);
  });

  it("never runs a later source event across an unprocessed source gap", async () => {
    const checkpointAndAcknowledge = vi.fn();
    await expect(runAgentV2WorkerSlice({
      workerId: "test-worker", model: null,
      repository: { claim: async () => ({ job_id: "20000000-0000-4000-8000-000000000001", party_id: partyId, event_id: "30000000-0000-4000-8000-000000000001", attempts: 1, fence: 2, input_revision: 0, draft_revision: 0, source_revision: 2, processed_source_revision: 0, step_sequence: 0, workspace: createWorkspace(partyId, [actorId]), checkpoint: {} }), checkpointAndAcknowledge },
      readEvent: async () => ({ id: "30000000-0000-4000-8000-000000000001", actor_id: actorId, kind: "chat" as const, payload: { text: "later" }, source_sequence: 2 }),
      readSteps: async () => [], budgetForParty: async () => null,
    })).rejects.toThrow(/source gap/i);
    expect(checkpointAndAcknowledge).not.toHaveBeenCalled();
  });

  it("persists a recipient-owned reply once but keeps the question open until processing succeeds", async () => {
    const originalMessages = [{ role: "assistant" as const, content: [{ type: "text" as const, text: "asked" }] }];
    let saved: Record<string, unknown> | undefined;
    await runAgentV2WorkerSlice({
      workerId: "test-worker", model: null,
      repository: { claim: async () => ({ job_id: "20000000-0000-4000-8000-000000000001", party_id: partyId, event_id: "30000000-0000-4000-8000-000000000001", attempts: 1, fence: 2, input_revision: 0, draft_revision: 0, source_revision: 2, processed_source_revision: 1, step_sequence: 4, workspace: createWorkspace(partyId, [actorId]), checkpoint: { schemaVersion: 1, logicalRunId: "original", activeEventId: "old", modelSteps: 1, noProgressSteps: 0, transientAttempts: {}, nextAttemptAt: null, commerce: { schemaVersion: 1, inputRevision: 0, draftRevision: 0, cart: null, requirements: [], products: [], selections: [], searchRevisions: {} }, candidateDraft: null, openQuestions: [{ id: "40000000-0000-4000-8000-000000000001", taskId: "diet", recipientId: actorId, sourceEventId: "old" }], lastProgressFingerprint: "", lastStep: null } }), checkpointAndAcknowledge: async input => { saved = input; } },
      readEvent: async () => ({ id: "30000000-0000-4000-8000-000000000001", actor_id: actorId, kind: "resume" as const, payload: { text: "Yes", messageId: "50000000-0000-4000-8000-000000000001", replyToMessageId: "40000000-0000-4000-8000-000000000001" }, source_sequence: 2 }),
      readSteps: async () => [{ step_sequence: 4, messages: originalMessages }], budgetForParty: async () => null,
    });
    expect(saved?.messages).toEqual([...originalMessages, { role: "user", content: "Yes" }]);
    expect((saved?.checkpoint as { logicalRunId: string; openQuestions: unknown[] }).logicalRunId).toBe("original");
    expect((saved?.checkpoint as { openQuestions: unknown[] }).openQuestions).toHaveLength(1);
    expect((saved?.checkpoint as { resumeMessageIds: string[] }).resumeMessageIds).toEqual(["50000000-0000-4000-8000-000000000001"]);
  });

  it("turns an exhausted unscheduled dependency failure into a terminal block", async () => {
    let acknowledged = "";
    await runAgentV2WorkerSlice({
      workerId: "test-worker", model: null,
      repository: {
        claim: async () => ({
          job_id: "20000000-0000-4000-8000-000000000001", party_id: partyId,
          event_id: "30000000-0000-4000-8000-000000000001", attempts: 3, fence: 1,
          input_revision: 0, draft_revision: 0, source_revision: 1,
          processed_source_revision: 0, step_sequence: 0,
          workspace: createWorkspace(partyId, [actorId]),
          checkpoint: { schemaVersion: 1, logicalRunId: "run", activeEventId: "30000000-0000-4000-8000-000000000001", modelSteps: 0, noProgressSteps: 0, transientAttempts: { model: 2 }, nextAttemptAt: null, commerce: { schemaVersion: 1, inputRevision: 0, draftRevision: 0, cart: null, requirements: [], products: [], selections: [], searchRevisions: {} }, candidateDraft: null, openQuestions: [], lastProgressFingerprint: "", lastStep: null },
        }),
        checkpointAndAcknowledge: async input => { acknowledged = input.status; },
      },
      readEvent: async () => ({ id: "30000000-0000-4000-8000-000000000001", actor_id: actorId, kind: "chat", payload: { text: "rice" }, source_sequence: 1 }),
      readSteps: async () => [], budgetForParty: async () => null,
    });
    expect(acknowledged).toBe("blocked");
  });
});
