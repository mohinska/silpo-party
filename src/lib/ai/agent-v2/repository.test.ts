import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createAgentV2Repository, type RpcTransport } from "./repository";
import { createWorkspace } from "./state";
import { calculateDraft, publishDraft } from "./draft";

const partyId = "10000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000001";

describe("agent v2 repository boundary", () => {
  it("preserves raw chat and binds event authority to supplied authenticated actor", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc: RpcTransport = async (name, args) => { calls.push({ name, args }); return { data: "job-1", error: null }; };
    const repo = createAgentV2Repository(rpc);
    expect(await repo.enqueue({ partyId, actorId, idempotencyKey: "msg-1", kind: "chat", payload: { text: "Can we have rice?" }, initialWorkspace: createWorkspace(partyId, [actorId]) })).toBe("job-1");
    expect(calls[0]).toMatchObject({ name: "agent_v2_enqueue", args: { p_actor_id: actorId, p_changes_input: false, p_payload: { text: "Can we have rice?" } } });
    await expect(repo.enqueue({ partyId, actorId, idempotencyKey: "msg-2", kind: "chat", payload: { text: "Hi", actorId: "spoofed" }, initialWorkspace: createWorkspace(partyId, [actorId]) })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("derives public projection from validated workspace and passes lease CAS fields", async () => {
    let args: Record<string, unknown> = {};
    const repo = createAgentV2Repository(async (_name, parameters) => { args = parameters; return { data: null, error: null }; });
    const workspace = createWorkspace(partyId, [actorId]);
    const next = publishDraft(workspace, calculateDraft(workspace, [], [], null), 0, 0);
    await repo.checkpoint({ jobId: "20000000-0000-4000-8000-000000000001", workerId: "w", fence: 7, expectedInputRevision: 0, expectedDraftRevision: 0, stepSequence: 1, workspace: next, messages: [], checkpoint: { phase: "planning", privateReason: "secret" }, publish: true });
    expect(args).toMatchObject({ p_fence: 7, p_expected_input: 0, p_expected_draft: 0, p_step: 1 });
    expect(JSON.stringify(args.p_projection)).not.toContain("secret");
    expect(args.p_projection).toMatchObject({ draftRevision: 1, ready: false });
  });
  it("surfaces stale database writes and rejects malformed claimed state", async () => {
    const stale = createAgentV2Repository(async () => ({ data: null, error: { message: "Stale worker or revision", code: "P0001" } }));
    await expect(stale.claim("w")).rejects.toThrow("Stale worker or revision");
    const malformed = createAgentV2Repository(async () => ({ data: [{ workspace: {} }], error: null }));
    await expect(malformed.claim("w")).rejects.toThrow();
  });
});
