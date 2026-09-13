import "server-only";
import { z } from "zod";
import { createAdminClient } from "../../supabase/admin";
import { WorkspaceSchema, type Workspace } from "./state";
import { projectDraft } from "./draft";

const uuid = z.uuid();
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "waiting_for_input", "blocked", "cancelled", "superseded"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const SourceEventKindSchema = z.enum(["chat", "request_edit", "context_refresh", "manual_edit", "approval", "resume"]);
export type SourceEventKind = z.infer<typeof SourceEventKindSchema>;
export const ActivityCodeSchema = z.enum(["queued", "working", "draft_updated", "waiting_for_input", "blocked", "completed", "failed", "cancelled", "superseded"]);
export type ActivityCode = z.infer<typeof ActivityCodeSchema>;
const ClaimSchema = z.object({ job_id: uuid, party_id: uuid, event_id: uuid, fence: counter, input_revision: counter, draft_revision: counter, step_sequence: counter, workspace: WorkspaceSchema, checkpoint: z.record(z.string(), z.unknown()) });
export type ClaimedWork = z.infer<typeof ClaimSchema>;
export type RpcTransport = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
export class RepositoryError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "RepositoryError"; }
}

/** Server callers must supply actorId from authenticated identity, never request JSON.
 * The database independently checks membership/host authority. Raw chat is queued
 * unchanged; intent parsing belongs to the worker and cannot grant actor authority. */
export function createAgentV2Repository(transport?: RpcTransport) {
  const rpc: RpcTransport = transport ?? ((name, args) => createAdminClient().rpc(name, args));
  async function call(name: string, args: Record<string, unknown>) {
    const result = await rpc(name, args);
    if (result.error) throw new RepositoryError(result.error.message, result.error.code);
    return result.data;
  }
  return {
    async enqueue(input: { partyId: string; actorId: string; idempotencyKey: string; kind: SourceEventKind; payload: Record<string, unknown>; initialWorkspace: Workspace; changesInput?: boolean }) {
      const partyId = uuid.parse(input.partyId);
      const actorId = uuid.parse(input.actorId);
      const workspace = WorkspaceSchema.parse(input.initialWorkspace);
      if (workspace.partyId !== partyId || !workspace.participants[actorId]) throw new Error("Invalid initial party workspace");
      if (["actorId", "actor_id", "participantId", "participant_id", "hostId", "host_id"].some(key => key in input.payload)) throw new Error("Event payload cannot supply actor authority");
      const kind = SourceEventKindSchema.parse(input.kind);
      const payload = kind === "chat" ? z.object({ text: z.string().trim().min(1).max(2000), messageId: uuid.optional(), replyToMessageId: uuid.optional() }).strict().parse(input.payload) : input.payload;
      return z.string().min(1).parse(await call("agent_v2_enqueue", { p_party_id: partyId, p_actor_id: actorId, p_idempotency_key: z.string().min(1).max(200).parse(input.idempotencyKey), p_kind: kind, p_payload: payload, p_changes_input: input.changesInput ?? false, p_initial_workspace: workspace }));
    },
    async claim(workerId: string, leaseSeconds = 60): Promise<ClaimedWork | null> {
      const data = await call("agent_v2_claim", { p_worker_id: z.string().trim().min(1).parse(workerId), p_lease_seconds: z.number().int().min(1).max(60).parse(leaseSeconds) });
      return z.array(ClaimSchema).max(1).parse(data)[0] ?? null;
    },
    async checkpoint(input: { jobId: string; workerId: string; fence: number; expectedInputRevision: number; expectedDraftRevision: number; stepSequence: number; workspace: Workspace; messages: unknown[]; checkpoint: Record<string, unknown>; publish?: boolean; activityCode?: ActivityCode }) {
      const workspace = WorkspaceSchema.parse(input.workspace);
      await call("agent_v2_checkpoint", { p_job_id: uuid.parse(input.jobId), p_worker_id: z.string().min(1).parse(input.workerId), p_fence: counter.parse(input.fence), p_expected_input: counter.parse(input.expectedInputRevision), p_expected_draft: counter.parse(input.expectedDraftRevision), p_step: counter.parse(input.stepSequence), p_workspace: workspace, p_messages: z.array(z.unknown()).parse(input.messages), p_checkpoint: input.checkpoint, p_projection: input.publish ? projectDraft(workspace) : null, p_activity_code: input.activityCode ? ActivityCodeSchema.parse(input.activityCode) : null });
    },
    async acknowledge(input: { jobId: string; workerId: string; fence: number; stepSequence: number; status: Exclude<RunStatus, "running"> }) {
      const status = RunStatusSchema.exclude(["running"]).parse(input.status);
      await call("agent_v2_ack", { p_job_id: uuid.parse(input.jobId), p_worker_id: z.string().min(1).parse(input.workerId), p_fence: counter.parse(input.fence), p_step: counter.parse(input.stepSequence), p_status: status });
    },
    async approve(input: { partyId: string; actorId: string; draftRevision: number; idempotencyKey: string }) {
      return uuid.parse(await call("agent_v2_approve", { p_party_id: uuid.parse(input.partyId), p_actor_id: uuid.parse(input.actorId), p_draft_revision: counter.parse(input.draftRevision), p_idempotency_key: z.string().min(1).max(200).parse(input.idempotencyKey) }));
    },
  };
}

export async function readAgentV2Workspace(partyId: string): Promise<Workspace | null> {
  const { data, error } = await createAdminClient().from("party_agent_workspaces").select("workspace").eq("party_id", uuid.parse(partyId)).maybeSingle();
  if (error) throw new RepositoryError(error.message, error.code);
  return data ? WorkspaceSchema.parse(data.workspace) : null;
}

export const SourceEventSchema = z.object({ id: uuid, party_id: uuid, actor_id: uuid, idempotency_key: z.string(), kind: SourceEventKindSchema, payload: z.record(z.string(), z.unknown()), input_revision: counter, created_at: z.string() });
export type SourceEvent = z.infer<typeof SourceEventSchema>;
export async function readAgentV2Event(eventId: string): Promise<SourceEvent> {
  const { data, error } = await createAdminClient().from("party_agent_events").select("*").eq("id", uuid.parse(eventId)).single();
  if (error) throw new RepositoryError(error.message, error.code);
  return SourceEventSchema.parse(data);
}

export async function readAgentV2Steps(partyId: string, afterSequence = 0) {
  const { data, error } = await createAdminClient().from("party_agent_steps").select("step_sequence,job_id,fence,input_revision,messages,checkpoint").eq("party_id", uuid.parse(partyId)).gt("step_sequence", counter.parse(afterSequence)).order("step_sequence", { ascending: true });
  if (error) throw new RepositoryError(error.message, error.code);
  return z.array(z.object({ step_sequence: counter, job_id: uuid, fence: counter, input_revision: counter, messages: z.array(z.unknown()), checkpoint: z.record(z.string(), z.unknown()) })).parse(data);
}
