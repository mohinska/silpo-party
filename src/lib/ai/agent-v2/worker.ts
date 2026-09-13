import "server-only";
import type { LanguageModel, ModelMessage } from "ai";
import type { ClaimedWork, RunStatus } from "./repository";
import { AgentV2CheckpointSchema, executeAgentV2Slice, type AgentV2RuntimeDependencies } from "./runtime";
import { z } from "zod";
import type { CommerceReadAdapter } from "./commerce-contract";

type WorkerRepository = {
  claim(workerId: string, leaseSeconds?: number): Promise<ClaimedWork | null>;
  checkpointAndAcknowledge(input: { jobId: string; workerId: string; fence: number; expectedInputRevision: number; expectedDraftRevision: number; expectedSourceRevision: number; eventProcessed: boolean; stepSequence: number; workspace: ClaimedWork["workspace"]; messages: unknown[]; checkpoint: Record<string, unknown>; publish: boolean; activityCode: "working" | "completed" | "waiting_for_input" | "blocked"; question?: { id: string; recipientId: string; content: string } | null; status: Exclude<RunStatus, "running">; nextAttemptAt?: string | null }): Promise<void>;
};
type WorkerEvent = { id: string; actor_id: string; kind: "chat" | "request_edit" | "context_refresh" | "manual_edit" | "approval" | "resume"; payload: Record<string, unknown>; source_sequence: number };
export type AgentV2WorkerDependencies = AgentV2RuntimeDependencies & { workerId: string; model: LanguageModel | null; repository: WorkerRepository; readEvent(eventId: string): Promise<WorkerEvent>; readSteps(partyId: string, afterSequence: number): Promise<Array<{ step_sequence: number; messages: unknown[] }>>; budgetForParty(partyId: string): Promise<number | null>; openCommerce?<T>(scope: { partyId: string; actorId: string; signal?: AbortSignal }, operation: (commerce: CommerceReadAdapter) => Promise<T>): Promise<T> };

/** Claims and executes one model/tool step. The durable checkpoint is always
 * written before the fence-protected acknowledgement; lease expiry recovers it. */
export async function runAgentV2WorkerSlice(deps: AgentV2WorkerDependencies) {
  const claim = await deps.repository.claim(deps.workerId, 60);
  if (!claim) return null;
  const [event, prior] = await Promise.all([
    deps.readEvent(claim.event_id),
    claim.step_sequence ? deps.readSteps(claim.party_id, Math.max(0, claim.step_sequence - 1)) : Promise.resolve([]),
  ]);
  const last = prior.at(-1);
  if (claim.step_sequence && (!last || last.step_sequence !== claim.step_sequence)) throw new Error("Missing durable message checkpoint");
  if (event.source_sequence > claim.processed_source_revision + 1) throw new Error("Source gap: an earlier event must be processed first");
  let messages = (last?.messages ?? []) as ModelMessage[];
  let checkpoint = claim.checkpoint;
  if (event.kind === "resume") {
    const reply = z.object({ text: z.string().trim().min(1).max(2000), messageId: z.string().min(1), replyToMessageId: z.string().min(1) }).parse(event.payload);
    const current = AgentV2CheckpointSchema.parse(checkpoint);
    const question = current.openQuestions.find(item => item.id === reply.replyToMessageId);
    if (!question || question.recipientId !== event.actor_id) throw new Error("Private reply does not match a recipient-owned question");
    if (!current.resumeMessageIds.includes(reply.messageId)) messages = [...messages, { role: "user", content: reply.text }];
    checkpoint = { ...current, activeEventId: event.id, resumeMessageIds: [...new Set([...current.resumeMessageIds, reply.messageId])].slice(-100) };
  }
  const result = await executeAgentV2Slice({
    ...deps,
    withCommerce: deps.openCommerce
      ? operation => deps.openCommerce!({ partyId: claim.party_id, actorId: event.actor_id }, operation)
      : deps.withCommerce,
    event: { id: event.id, actorId: event.actor_id, kind: event.kind, payload: event.payload, sourceSequence: event.source_sequence },
    workspace: claim.workspace,
    checkpoint,
    messages,
    budgetCents: await deps.budgetForParty(claim.party_id),
  });
  const nextStep = claim.step_sequence + 1;
  // An event is incorporated only after an authorized reducer/tool outcome was
  // persisted. A no-tool text slice remains queued for the next durable step.
  const progressed = result.eventProcessed;
  // A newer source may arrive after this claim. The resulting draft remains a
  // valid versioned provisional snapshot; the source watermark/approval gate
  // marks it stale instead of replaying this model step.
  const publish = result.publish;
  // A missing model/dependency is visible in the durable checkpoint but has not
  // interpreted the raw source event. Keep it queued so it cannot advance the
  // watermark across itself or allow an approval to leap over lost intent.
  const acknowledgedStatus = result.status === "blocked" && !progressed && result.checkpoint.nextAttemptAt ? "queued" : result.status;
  await deps.repository.checkpointAndAcknowledge({ jobId: claim.job_id, workerId: deps.workerId, fence: claim.fence, expectedInputRevision: claim.input_revision, expectedDraftRevision: claim.draft_revision, expectedSourceRevision: claim.source_revision, eventProcessed: progressed, stepSequence: nextStep, workspace: result.workspace, messages: result.messages, checkpoint: result.checkpoint, publish, activityCode: result.activityCode, question: result.question, status: acknowledgedStatus, nextAttemptAt: acknowledgedStatus === "queued" ? result.checkpoint.nextAttemptAt : null });
  return { jobId: claim.job_id, status: result.status, stepSequence: nextStep };
}
