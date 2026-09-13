import { createHash, randomUUID } from "node:crypto";
import { ToolLoopAgent, isStepCount, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { bindCommerceRevision, CommerceStateSchema, createCommerceState, reviewCommerceDraft, searchRequirement, selectKnownProduct, summarizeProduct, type CommerceState, type ProductSummary } from "./catalog";
import { CommerceError, type CommerceReadAdapter } from "./commerce-contract";
import { publishDraft } from "./draft";
import { deriveRecipeRequirements, resolveRecipeSource, validateGeneratedRecipe } from "./recipes";
import { applyRequestEdit, refreshContext, type ContextRefresh, type Draft, type RequestEdit, type Workspace } from "./state";

const OutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), evidenceIds: z.array(z.string()), summary: z.string() }),
  z.object({ status: z.literal("no_match"), evidenceIds: z.array(z.string()), summary: z.string() }),
  z.object({ status: z.literal("waiting_for_input"), questionId: z.string(), recipientId: z.string(), taskId: z.string() }),
  z.object({ status: z.literal("retry"), code: z.literal("transient"), attempt: z.number().int().positive(), retryAfterMs: z.number().int().nonnegative() }),
  z.object({ status: z.literal("blocked"), code: z.enum(["auth", "contract", "unavailable", "stale", "limit", "no_progress"]), summary: z.string() }),
]);
export type ToolOutcome = z.infer<typeof OutcomeSchema>;

const CheckpointSchema = z.object({
  schemaVersion: z.literal(1), logicalRunId: z.string().min(1), activeEventId: z.string().min(1), modelSteps: z.number().int().nonnegative().max(20),
  noProgressSteps: z.number().int().nonnegative().max(2), transientAttempts: z.record(z.string(), z.number().int().nonnegative().max(3)),
  nextAttemptAt: z.string().datetime({ offset: true }).nullable(), commerce: CommerceStateSchema, candidateDraft: z.unknown().nullable(),
  resumeMessageIds: z.array(z.string().min(1)).max(100).default([]),
  appliedEventIds: z.array(z.string().min(1)).max(100).default([]),
  notifiedWarnings: z.array(z.string().min(1)).max(200).default([]),
  openQuestions: z.array(z.object({ id: z.string(), taskId: z.string(), recipientId: z.string(), sourceEventId: z.string() }).strict()), lastProgressFingerprint: z.string(),
  lastStep: z.object({ finishReason: z.string(), usage: z.unknown(), response: z.unknown(), providerMetadata: z.unknown(), evidenceIds: z.array(z.string()), outcome: OutcomeSchema }).nullable(),
}).strict();
export type AgentV2Checkpoint = z.infer<typeof CheckpointSchema>;

type RuntimeEvent = { id: string; actorId: string; kind: "chat" | "request_edit" | "context_refresh" | "manual_edit" | "approval" | "resume"; payload: Record<string, unknown>; sourceSequence: number };
type ContextLoader = (partyId: string, participantId: string, source: "profile" | "silpo", previousVersion: number, signal?: AbortSignal) => Promise<ContextRefresh>;
type CommerceScope = <T>(operation: (commerce: CommerceReadAdapter) => Promise<T>) => Promise<T>;
export type AgentV2RuntimeDependencies = { commerce?: CommerceReadAdapter; withCommerce?: CommerceScope; loadContext?: ContextLoader; resolveRecipe?: typeof resolveRecipeSource; now?: () => Date; };
export type ExecuteAgentV2SliceInput = AgentV2RuntimeDependencies & { model: LanguageModel | null; event: RuntimeEvent; workspace: Workspace; checkpoint: unknown; messages: ModelMessage[]; budgetCents: number | null; abortSignal?: AbortSignal };
type PrivateNotice = { id: string; recipientId: string; content: string };
export type ExecuteAgentV2SliceResult = { workspace: Workspace; checkpoint: AgentV2Checkpoint; messages: ModelMessage[]; status: "queued" | "completed" | "waiting_for_input" | "blocked"; publish: boolean; eventProcessed: boolean; activityCode: "working" | "completed" | "waiting_for_input" | "blocked"; question: { id: string; recipientId: string; content: string } | null; notices: PrivateNotice[] };

function initialCheckpoint(event: RuntimeEvent): AgentV2Checkpoint {
  return { schemaVersion: 1, logicalRunId: randomUUID(), activeEventId: event.id, modelSteps: 0, noProgressSteps: 0, transientAttempts: {}, nextAttemptAt: null, commerce: createCommerceState(), candidateDraft: null, resumeMessageIds: [], appliedEventIds: [], notifiedWarnings: [], openQuestions: [], lastProgressFingerprint: "", lastStep: null };
}

function warningKey(w: { code: string; requirementId?: string; recipientId: string }) {
  return `${w.code}:${w.requirementId ?? ""}:${w.recipientId}`;
}
function warningMessage(w: { requirementName?: string }) {
  return `Не вдалося гарантовано перевірити товар${w.requirementName ? ` для «${w.requirementName}»` : ""} на відповідність вашому задекларованому обмеженню (алергія/дієта). Перевірте склад самостійно перед підтвердженням кошика.`;
}

function parseCheckpoint(input: unknown, event: RuntimeEvent) {
  if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0) return initialCheckpoint(event);
  const parsed = CheckpointSchema.parse(input);
  if (parsed.activeEventId === event.id || event.kind === "resume") return { ...parsed, activeEventId: event.id };
  return {
    ...initialCheckpoint(event),
    commerce: parsed.commerce,
    openQuestions: parsed.openQuestions,
  };
}

function fingerprint(workspace: Workspace, commerce: CommerceState, draft: Draft | null, questions: AgentV2Checkpoint["openQuestions"]) {
  return createHash("sha256").update(JSON.stringify({ workspace, commerce, draft, questions })).digest("hex");
}

function instructions(event: RuntimeEvent, workspace: Workspace, checkpoint: AgentV2Checkpoint, budgetCents: number | null) {
  return [
    "You are a durable party-planning agent. Use tools for every material action; text never completes work.",
    "Call exactly one tool per step. Call complete_event only when the source request is fully incorporated and no draft work remains; publish_draft and targeted questions finish the current source automatically.",
    "Never write a cart. Only deterministic server tools decide readiness, prices, quantities, revisions, and publication.",
    "Do not disclose private context in shared output. The event actor may edit only their own requests.",
    "Use evidence-backed recipe and product tools. Unknown evidence is not safe. Ask a targeted question only to an affected member.",
    "When calling search_products, use concrete Ukrainian product-name query phrases (brand/type/variant synonyms for the ingredient), not the raw recipe sentence -- search is literal catalog matching, not semantic. Take productId only from a prior search_products/read_product tool result; never construct or parse one.",
    "A requirement search is capped at three revisions. Once reached, or once no acceptable candidate is found, stop retrying that requirement and continue with calculate_validate_draft/publish_draft/complete_event -- leaving it unresolved is a normal, visible per-line draft blocker, not a failure.",
    `Current private server state: ${JSON.stringify({ event: { id: event.id, actorId: event.actorId, kind: event.kind, payload: event.payload }, requests: workspace.requests, participantContexts: Object.fromEntries(Object.entries(workspace.participants).map(([id, participant]) => [id, participant.contexts])), artifacts: workspace.artifacts.map(a => ({ id: a.id, valid: a.valid, kind: a.kind, dependsOn: a.dependsOn })), commerce: { requirements: checkpoint.commerce.requirements, selections: checkpoint.commerce.selections, searchRevisions: checkpoint.commerce.searchRevisions }, draft: workspace.draft ? { inputRevision: workspace.draft.inputRevision, ready: workspace.draft.ready, blockers: workspace.draft.blockers.map(b => b.code) } : null, budgetCents, stepsRemaining: Math.max(0, 20 - checkpoint.modelSteps) })}`,
  ].join("\n");
}

function classified(error: unknown, checkpoint: AgentV2Checkpoint): ToolOutcome {
  if (error instanceof CommerceError) {
    if (error.code === "transient") {
      const key = "commerce"; const attempt = (checkpoint.transientAttempts[key] ?? 0) + 1;
      if (attempt <= 3) return { status: "retry", code: "transient", attempt, retryAfterMs: error.retryAfterMs ?? 250 * 2 ** (attempt - 1) };
    }
    const code = error.code === "contract" ? "contract" : error.code === "approval_required" ? "auth" : "unavailable";
    return { status: "blocked", code, summary: error.message };
  }
  return { status: "blocked", code: "unavailable", summary: error instanceof Error ? error.message : "Agent dependency unavailable" };
}

export async function executeAgentV2Slice(input: ExecuteAgentV2SliceInput): Promise<ExecuteAgentV2SliceResult> {
  const now = input.now ?? (() => new Date());
  const priorActiveEventId = input.checkpoint && typeof input.checkpoint === "object" && !Array.isArray(input.checkpoint)
    ? (input.checkpoint as { activeEventId?: unknown }).activeEventId
    : undefined;
  const startsNewSourceEvent = typeof priorActiveEventId === "string" && priorActiveEventId !== input.event.id;
  let workspace = structuredClone(input.workspace);
  let checkpoint = parseCheckpoint(input.checkpoint, input.event);
  let commerce = checkpoint.commerce;
  let candidateDraft = checkpoint.candidateDraft as Draft | null;
  let publish = false;
  let outcome: ToolOutcome = { status: "completed", evidenceIds: [], summary: "Model slice produced no durable tool outcome" };
  const observedOutcome = (): ToolOutcome => outcome;
  const questions = [...checkpoint.openQuestions];
  let privateQuestion: ExecuteAgentV2SliceResult["question"] = null;
  const notices: PrivateNotice[] = [];
  let notifiedWarnings = new Set(checkpoint.notifiedWarnings);
  let toolCallCount = 0;
  let eventCompletionRequested = false;
  if (!checkpoint.appliedEventIds.includes(input.event.id)) {
    try {
      if (input.event.kind === "request_edit") {
        const payload = z.object({ edit: z.unknown() }).passthrough().parse(input.event.payload);
        workspace = applyRequestEdit(workspace, input.event.actorId, payload.edit as RequestEdit);
        checkpoint = { ...checkpoint, appliedEventIds: [...checkpoint.appliedEventIds, input.event.id].slice(-100) };
      } else if (input.event.kind === "context_refresh") {
        const payload = z.object({ participantId: z.string().min(1), source: z.enum(["profile", "silpo"]) }).strict().parse(input.event.payload);
        if (payload.participantId !== input.event.actorId || !input.loadContext) throw new CommerceError("unavailable", "Authorized context adapter unavailable");
        const previousVersion = workspace.participants[payload.participantId]?.contexts[payload.source]?.version ?? 0;
        workspace = refreshContext(workspace, payload.participantId, await input.loadContext(workspace.partyId, payload.participantId, payload.source, previousVersion, input.abortSignal));
        checkpoint = { ...checkpoint, appliedEventIds: [...checkpoint.appliedEventIds, input.event.id].slice(-100) };
      }
    } catch (error) {
      outcome = classified(error, checkpoint);
      checkpoint = { ...checkpoint, lastStep: { finishReason: "source_reducer_error", usage: {}, response: {}, providerMetadata: {}, evidenceIds: [], outcome } };
      return { workspace: input.workspace, checkpoint, messages: input.messages, status: "blocked", publish: false, eventProcessed: false, activityCode: "blocked", question: null, notices: [] };
    }
  }
  const sourceAppliedWorkspace = structuredClone(workspace);
  const priorFingerprint = checkpoint.lastProgressFingerprint || fingerprint(workspace, commerce, candidateDraft, questions);

  if (!input.model) {
    const attempt = Math.min(3, (checkpoint.transientAttempts.model ?? 0) + 1);
    outcome = { status: "blocked", code: "unavailable", summary: "No configured native agent model" };
    checkpoint = {
      ...checkpoint,
      activeEventId: input.event.id,
      transientAttempts: { ...checkpoint.transientAttempts, model: attempt },
      nextAttemptAt: attempt < 3 ? new Date(now().getTime() + 5_000 * 2 ** (attempt - 1)).toISOString() : null,
      lastStep: { finishReason: "model_unavailable", usage: {}, response: {}, providerMetadata: {}, evidenceIds: [], outcome },
    };
    return { workspace, checkpoint, messages: input.messages, status: "blocked", publish: false, eventProcessed: false, activityCode: "blocked", question: null, notices: [] };
  }
  if (checkpoint.modelSteps >= 20) {
    outcome = { status: "blocked", code: "limit", summary: "Logical model-step limit reached" };
    checkpoint = { ...checkpoint, lastStep: { finishReason: "limit", usage: {}, response: {}, providerMetadata: {}, evidenceIds: [], outcome } };
    return { workspace, checkpoint, messages: input.messages, status: "blocked", publish: false, eventProcessed: false, activityCode: "blocked", question: null, notices: [] };
  }

  const fail = (error: unknown) => { outcome = classified(error, checkpoint); return outcome; };
  const ranTool = () => { toolCallCount += 1; };
  const withCommerce = async <T>(operation: (commerceAdapter: CommerceReadAdapter) => Promise<T>) => {
    if (input.commerce) return operation(input.commerce);
    if (input.withCommerce) return input.withCommerce(operation);
    throw new CommerceError("unavailable", "Commerce adapter unavailable");
  };
  const tools = {
    read_authorized_context: tool({ description: "Refresh one participant's authorized context.", inputSchema: z.object({ participantId: z.string().min(1), source: z.enum(["profile", "silpo"]) }).strict(), execute: async ({ participantId, source }) => { ranTool();
      if (!workspace.participants[participantId] || !input.loadContext) return { ...fail(new CommerceError("unavailable", "Authorized context adapter unavailable")), evidenceIds: [] };
      try { const previousVersion = workspace.participants[participantId].contexts[source]?.version ?? 0; workspace = refreshContext(workspace, participantId, await input.loadContext(workspace.partyId, participantId, source, previousVersion, input.abortSignal)); outcome = { status: "completed", evidenceIds: workspace.participants[participantId].contexts[source]?.evidenceRefs ?? [], summary: "Context refreshed" }; return outcome; } catch (error) { return fail(error); }
    }}),
    edit_request: tool({ description: "Edit only the current event actor's request.", inputSchema: z.object({ edit: z.object({ kind: z.enum(["add", "remove", "replace", "quantity", "servings", "eaters", "indifferent", "question"]), requestId: z.string().optional(), text: z.string().optional(), requestKind: z.enum(["dish", "recipe", "product"]).optional(), eaterIds: z.array(z.string()).optional(), servings: z.number().positive().optional(), quantity: z.number().positive().optional(), unit: z.enum(["g", "kg", "ml", "l", "piece", "tbsp", "tsp"]).optional() }).passthrough() }).strict(), execute: async ({ edit }) => { ranTool();
      try { workspace = applyRequestEdit(workspace, input.event.actorId, edit as RequestEdit); outcome = { status: "completed", evidenceIds: [], summary: "Request state updated" }; return outcome; } catch (error) { return fail(error); }
    }}),
    resolve_recipe: tool({ description: "Resolve a complete public recipe source for an existing request.", inputSchema: z.object({ requestId: z.string(), sourceUrl: z.string().url() }).strict(), execute: async ({ requestId, sourceUrl }) => { ranTool();
      try { const recipe = await (input.resolveRecipe ?? resolveRecipeSource)(sourceUrl, input.abortSignal); const derived = deriveRecipeRequirements(workspace, requestId, recipe); workspace = { ...workspace, evidence: [...workspace.evidence.filter(e => !derived.evidence.some(next => next.id === e.id)), ...derived.evidence], artifacts: [...workspace.artifacts.filter(a => !derived.artifacts.some(next => next.id === a.id)), ...derived.artifacts] }; commerce = { ...commerce, requirements: [...commerce.requirements.filter(r => r.requestId !== requestId), ...derived.requirements] }; outcome = { status: "completed", evidenceIds: derived.evidence.map(e => e.id), summary: "Recipe evidence resolved" }; return outcome; } catch (error) { return fail(error); }
    }}),
    submit_generated_recipe: tool({ description: "Submit a complete generated recipe with quantities and preparation steps.", inputSchema: z.object({ requestId: z.string(), recipe: z.unknown() }).strict(), execute: async ({ requestId, recipe }) => { ranTool();
      try { const derived = deriveRecipeRequirements(workspace, requestId, validateGeneratedRecipe(recipe)); workspace = { ...workspace, evidence: [...workspace.evidence, ...derived.evidence], artifacts: [...workspace.artifacts, ...derived.artifacts] }; commerce = { ...commerce, requirements: [...commerce.requirements.filter(r => r.requestId !== requestId), ...derived.requirements] }; outcome = { status: "completed", evidenceIds: derived.evidence.map(e => e.id), summary: "Generated recipe validated" }; return outcome; } catch (error) { return fail(error); }
    }}),
    search_products: tool({ description: "Search known products for one requirement (short, specific Ukrainian product-name query phrases per call -- e.g. brand/type/variant synonyms, not the raw recipe sentence; this is literal catalog search, not semantic). At most three revisions per requirement; once reached, or once no acceptable candidate is found, stop retrying and move on -- an unresolved requirement stays a visible per-line draft blocker, it does not block the whole run.", inputSchema: z.object({ requirementId: z.string(), queries: z.array(z.string().min(1)).min(1).max(30), substitutionsFor: z.string().optional() }).strict(), execute: async ({ requirementId, queries, substitutionsFor }) => { ranTool();
      try {
        const { state, matched, limitReached } = await withCommerce(api => searchRequirement(commerce, requirementId, queries, api, substitutionsFor));
        commerce = state;
        outcome = matched.length ? { status: "completed", evidenceIds: matched.map(p => p.evidence.id), summary: "Catalog search completed" } : { status: "no_match", evidenceIds: [], summary: limitReached ? "Search revision limit reached; stop retrying this requirement" : "No candidates matched this requirement" };
        return { ...outcome, products: matched.map(summarizeProduct), limitReached };
      } catch (error) { return fail(error); }
    }}),
    read_product: tool({ description: "Read full details for one already-discovered candidate. Use the productId from a prior search_products/read_product result.", inputSchema: z.object({ requirementId: z.string(), productId: z.string() }).strict(), execute: async ({ requirementId, productId }) => { ranTool();
      if (!commerce.requirements.some(r => r.id === requirementId)) return fail(new CommerceError("unavailable", "Catalog requirement unavailable"));
      let product: ProductSummary | null = null;
      try {
        await withCommerce(async api => {
          const cart = commerce.cart ?? await api.cart();
          const p = await api.details(cart, productId);
          commerce = { ...commerce, cart, products: [...commerce.products.filter(x => x.id !== p.id || x.companyId !== p.companyId || x.branchId !== p.branchId), p] };
          outcome = { status: "completed", evidenceIds: [p.evidence.id], summary: "Product details recorded" };
          product = summarizeProduct(p);
        });
        return { ...outcome, product };
      } catch (error) { return fail(error); }
    }}),
    select_product: tool({ description: "Select one already-known evidence-backed product by the productId returned from search_products or read_product.", inputSchema: z.object({ requirementId: z.string(), productId: z.string() }).strict(), execute: async ({ requirementId, productId }) => { ranTool(); try { commerce = selectKnownProduct(commerce, requirementId, productId); outcome = { status: "completed", evidenceIds: [], summary: "Known product selected" }; return outcome; } catch (error) { return fail(error); } }}),
    calculate_validate_draft: tool({ description: "Deterministically calculate readiness from evidence.", inputSchema: z.object({}).strict(), execute: async () => { ranTool();
      try {
        candidateDraft = reviewCommerceDraft(workspace, commerce, input.budgetCents);
        for (const w of candidateDraft.warnings) {
          const key = warningKey(w);
          if (!notifiedWarnings.has(key)) { notifiedWarnings.add(key); notices.push({ id: randomUUID(), recipientId: w.recipientId, content: warningMessage(w) }); }
        }
        outcome = { status: "completed", evidenceIds: [], summary: "Draft validation completed" }; return outcome;
      } catch (error) { return fail(error); }
    }}),
    publish_draft: tool({ description: "Publish only the current deterministically calculated draft.", inputSchema: z.object({}).strict(), execute: async () => { ranTool(); try { if (!candidateDraft) throw new Error("Calculate draft before publication"); workspace = publishDraft(workspace, candidateDraft, workspace.inputRevision, workspace.draftRevision); commerce = bindCommerceRevision(commerce, workspace); publish = true; outcome = { status: "completed", evidenceIds: [], summary: "Draft projection ready to publish" }; return outcome; } catch (error) { return fail(error); } }}),
    ask_targeted_question: tool({ description: "Pause for one affected participant's private answer.", inputSchema: z.object({ recipientId: z.string(), taskId: z.string(), question: z.string().trim().min(1).max(1000) }).strict(), execute: async ({ recipientId, taskId, question }) => { ranTool();
      if (!workspace.participants[recipientId]) return fail(new Error("Question recipient is not a party member"));
      const id = randomUUID(); questions.push({ id, taskId, recipientId, sourceEventId: input.event.id }); privateQuestion = { id, recipientId, content: question }; workspace = { ...workspace, outcomes: [...workspace.outcomes, { taskId, status: "waiting_for_input", artifactIds: [], recipientId, privateReason: "Targeted private question pending" }] }; outcome = { status: "waiting_for_input", questionId: id, recipientId, taskId }; return outcome;
    }}),
    complete_event: tool({ description: "Finish this source event only after its requested state and draft work are fully incorporated.", inputSchema: z.object({}).strict(), execute: async () => { ranTool(); eventCompletionRequested = true; outcome = { status: "completed", evidenceIds: [], summary: "Source event completed" }; return outcome; } }),
  };
  const eventMessage: ModelMessage = { role: "user", content: JSON.stringify({ event: input.event.payload }) };
  const baseMessages: ModelMessage[] = input.messages.length
    ? startsNewSourceEvent ? [...input.messages, eventMessage] : input.messages
    : [eventMessage];
  try {
    const agent = new ToolLoopAgent({ model: input.model, instructions: instructions(input.event, workspace, checkpoint, input.budgetCents), tools, stopWhen: isStepCount(1), maxRetries: 0 });
    const result = await agent.generate({ messages: baseMessages, abortSignal: input.abortSignal });
    const nextMessages = [...baseMessages, ...result.responseMessages] as ModelMessage[];
    const multipleTools = toolCallCount > 1;
    if (multipleTools) {
      workspace = structuredClone(sourceAppliedWorkspace);
      commerce = checkpoint.commerce;
      candidateDraft = checkpoint.candidateDraft as Draft | null;
      questions.splice(0, questions.length, ...checkpoint.openQuestions);
      privateQuestion = null;
      publish = false;
      eventCompletionRequested = false;
      notices.splice(0, notices.length);
      notifiedWarnings = new Set(checkpoint.notifiedWarnings);
    }
    const latestOutcome: ToolOutcome = multipleTools
      ? { status: "blocked", code: "contract", summary: "Exactly one tool call is allowed per durable step" }
      : observedOutcome();
    const evidenceIds = latestOutcome.status === "completed" || latestOutcome.status === "no_match" ? latestOutcome.evidenceIds : [];
    const eventProcessed = publish || eventCompletionRequested || latestOutcome.status === "waiting_for_input";
    if (eventProcessed && input.event.kind === "resume") {
      const replyToMessageId = typeof input.event.payload.replyToMessageId === "string" ? input.event.payload.replyToMessageId : "";
      const index = questions.findIndex(item => item.id === replyToMessageId && item.recipientId === input.event.actorId);
      if (index >= 0) questions.splice(index, 1);
    }
    const nextFingerprint = fingerprint(workspace, commerce, candidateDraft, questions);
    const noProgressSteps = nextFingerprint === priorFingerprint ? checkpoint.noProgressSteps + 1 : 0;
    const effectiveOutcome: ToolOutcome = !eventProcessed && noProgressSteps >= 2 ? { status: "blocked", code: "no_progress", summary: "Two slices made no durable progress" } : latestOutcome;
    const retry = effectiveOutcome.status === "retry" ? effectiveOutcome : null;
    checkpoint = CheckpointSchema.parse({ ...checkpoint, activeEventId: input.event.id, modelSteps: checkpoint.modelSteps + 1, noProgressSteps, transientAttempts: retry ? { ...checkpoint.transientAttempts, commerce: retry.attempt, model: 0 } : { ...checkpoint.transientAttempts, model: 0 }, nextAttemptAt: retry ? new Date(now().getTime() + retry.retryAfterMs).toISOString() : null, commerce, candidateDraft, openQuestions: questions, notifiedWarnings: [...notifiedWarnings], lastProgressFingerprint: nextFingerprint, lastStep: { finishReason: String(result.finalStep.finishReason), usage: result.finalStep.usage, response: result.finalStep.response, providerMetadata: result.finalStep.providerMetadata, evidenceIds, outcome: effectiveOutcome } });
    const status = publish || eventCompletionRequested ? "completed" : effectiveOutcome.status === "waiting_for_input" ? "waiting_for_input" : effectiveOutcome.status === "blocked" ? "blocked" : "queued";
    return { workspace, checkpoint, messages: nextMessages, status, publish, eventProcessed, activityCode: status === "waiting_for_input" ? "waiting_for_input" : status === "blocked" ? "blocked" : status === "completed" ? "completed" : "working", question: privateQuestion, notices };
  } catch (error) {
    const errorOutcome: ToolOutcome = fail(error); const retry = errorOutcome.status === "retry" ? errorOutcome : null;
    checkpoint = CheckpointSchema.parse({ ...checkpoint, activeEventId: input.event.id, noProgressSteps: checkpoint.noProgressSteps, transientAttempts: retry ? { ...checkpoint.transientAttempts, commerce: retry.attempt } : checkpoint.transientAttempts, nextAttemptAt: retry ? new Date(now().getTime() + retry.retryAfterMs).toISOString() : null, lastStep: { finishReason: "error", usage: {}, response: {}, providerMetadata: {}, evidenceIds: [], outcome: errorOutcome } });
    return { workspace, checkpoint, messages: input.messages, status: errorOutcome.status === "retry" ? "queued" : "blocked", publish: false, eventProcessed: false, activityCode: errorOutcome.status === "retry" ? "working" : "blocked", question: null, notices: [] };
  }
}

const AgentV2CheckpointSchema = CheckpointSchema;
export { AgentV2CheckpointSchema, OutcomeSchema as ToolOutcomeSchema };
