import { z } from "zod";

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const UnitSchema = z.enum(["g", "kg", "ml", "l", "piece", "tbsp", "tsp"]);
/** exclude_term means an explicit literal ingredient preference, never an allergy/diet category.
 * Normalizers MUST preserve allergies and dietary semantics as semantic; absence of a literal
 * ingredient spelling cannot establish allergy safety (synonyms/derivatives/cross-contact). */
export const HardRuleSchema = z.object({ id, kind: z.enum(["exclude_term", "semantic"]), value: z.string().min(1), source: id, evidenceRef: id, ownerId: id.optional() }).strict();
export type HardRule = z.infer<typeof HardRuleSchema>;
export const ProductIdentitySchema = z.object({ productId: id, companyId: id, branchId: id }).strict();
export const EvidenceSchema = z.object({ id, source: z.enum(["recipe_source", "generated_recipe", "product_details"]), sourceRef: id, productIdentity: ProductIdentitySchema.optional(), complete: z.boolean(), ingredients: z.array(z.string().min(1)), composition: z.string(), verified: z.boolean() }).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
const ContextSchema = z.object({ source: id, version: revision, status: z.enum(["success", "error"]), rules: z.array(HardRuleSchema), favorites: z.array(z.string()), evidenceRefs: z.array(id), errorCode: z.string().optional() }).strict();
export type ParticipantContext = z.infer<typeof ContextSchema>;
export type ContextRefresh = Omit<ParticipantContext, "rules" | "favorites" | "evidenceRefs"> & { rules?: HardRule[]; favorites?: string[]; evidenceRefs?: string[] };
export const RequestSchema = z.object({ id, participantId: id, version: revision, text: z.string().min(1).max(2000), kind: z.enum(["dish", "recipe", "product"]), eaterIds: z.array(id).min(1), servings: z.number().positive().max(10000), quantity: z.number().positive().max(1000000).optional(), unit: UnitSchema.optional() }).strict();
export type FoodRequest = z.infer<typeof RequestSchema>;
export const RequestEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), requestId: id, text: z.string().min(1), requestKind: RequestSchema.shape.kind, eaterIds: z.array(id).min(1).optional(), servings: z.number().positive().optional() }),
  z.object({ kind: z.literal("upsert"), requestId: id, text: z.string().min(1), requestKind: RequestSchema.shape.kind, eaterIds: z.array(id).min(1).optional(), servings: z.number().positive().optional() }),
  z.object({ kind: z.literal("remove"), requestId: id }),
  z.object({ kind: z.literal("replace"), requestId: id, text: z.string().min(1), requestKind: RequestSchema.shape.kind }),
  z.object({ kind: z.literal("quantity"), requestId: id, quantity: z.number().positive().max(1000000), unit: UnitSchema }),
  z.object({ kind: z.literal("servings"), requestId: id, servings: z.number().positive().max(10000) }),
  z.object({ kind: z.literal("eaters"), requestId: id, eaterIds: z.array(id).min(1) }),
  z.object({ kind: z.literal("indifferent") }),
  z.object({ kind: z.literal("question"), text: z.string().min(1) }),
]);
export type RequestEdit = z.infer<typeof RequestEditSchema>;
export const ArtifactSchema = z.object({ id, kind: z.enum(["recipe", "requirement", "product", "draft"]), version: revision, valid: z.boolean(), dependsOn: z.array(id), evidenceRefs: z.array(id) }).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export const TaskOutcomeSchema = z.object({ taskId: id, status: z.enum(["completed", "waiting_for_input", "blocked", "failed", "cancelled", "superseded"]), artifactIds: z.array(id), privateReason: z.string().optional(), recipientId: id.optional() }).strict();
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;
export const DraftLineSchema = z.object({ productId: id, name: z.string().min(1), companyId: id, branchId: id, requirementIds: z.array(id), eaterIds: z.array(id), packageCount: z.number().int().positive(), packageQuantity: z.number().positive(), packageUnit: z.enum(["g", "ml", "piece"]), unitPriceCents: revision, lineTotalCents: revision }).strict();
export const DraftWarningSchema = z.object({ code: z.enum(["dietary_unverified"]), requirementId: id.optional(), requirementName: z.string().optional(), recipientId: id, privateReason: z.string().optional() }).strict();
export type DraftWarning = z.infer<typeof DraftWarningSchema>;
export const DraftSchema = z.object({ inputRevision: revision, lines: z.array(DraftLineSchema), totalCents: revision, ready: z.boolean(), blockers: z.array(z.object({ code: z.enum(["empty", "missing", "unknown", "unsafe", "units", "unavailable", "budget"]), requirementId: id.optional(), privateReason: z.string().optional() }).strict()), warnings: z.array(DraftWarningSchema).default([]) }).strict();
export type Draft = z.infer<typeof DraftSchema>;
export const WorkspaceSchema = z.object({ schemaVersion: z.literal(2), partyId: id, inputRevision: revision, draftRevision: revision, participants: z.record(id, z.object({ submission: z.enum(["unsubmitted", "submitted", "indifferent"]), contexts: z.record(id, ContextSchema) }).strict()), requests: z.array(RequestSchema), artifacts: z.array(ArtifactSchema), evidence: z.array(EvidenceSchema), outcomes: z.array(TaskOutcomeSchema), draft: DraftSchema.nullable() }).strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

export function createWorkspace(partyId: string, participantIds: string[]): Workspace {
  return WorkspaceSchema.parse({ schemaVersion: 2, partyId, inputRevision: 0, draftRevision: 0, participants: Object.fromEntries(participantIds.map(id => [id, { submission: "unsubmitted", contexts: {} }])), requests: [], artifacts: [], evidence: [], outcomes: [], draft: null });
}

export function invalidateArtifacts(artifacts: Artifact[], changedIds: string[]): Artifact[] {
  const invalid = new Set(changedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of artifacts) if (!invalid.has(artifact.id) && artifact.dependsOn.some(id => invalid.has(id))) { invalid.add(artifact.id); changed = true; }
  }
  return artifacts.map(artifact => invalid.has(artifact.id) ? { ...artifact, valid: false } : artifact);
}

/** Recipe retrieval depends on source; scaled quantities on scaling; eater safety
 * on eaters + context:<participantId>. Artifacts may depend on other artifact IDs. */
export function requestDependencyKeys(requestId: string) {
  return { source: `request:${requestId}:source`, scaling: `request:${requestId}:scaling`, eaters: `request:${requestId}:eaters` };
}

export function applyRequestEdit(workspace: Workspace, actorId: string, input: RequestEdit): Workspace {
  const edit = RequestEditSchema.parse(input);
  if (!workspace.participants[actorId]) throw new Error("Party membership required");
  if (edit.kind === "question") return workspace;
  if (edit.kind === "indifferent") {
    const owned = workspace.requests.filter(request => request.participantId === actorId);
    if (!owned.length && workspace.participants[actorId].submission === "indifferent") return workspace;
    const changedRoots = owned.flatMap(request => {
      const roots = requestDependencyKeys(request.id);
      return [roots.source, roots.scaling, roots.eaters, `request:${request.id}`];
    });
    return WorkspaceSchema.parse({
      ...workspace,
      inputRevision: workspace.inputRevision + 1,
      participants: { ...workspace.participants, [actorId]: { ...workspace.participants[actorId], submission: "indifferent" } },
      requests: workspace.requests.filter(request => request.participantId !== actorId),
      artifacts: invalidateArtifacts(workspace.artifacts, changedRoots),
    });
  }
  const current = workspace.requests.find(r => r.id === edit.requestId);
  if (edit.kind === "add" ? Boolean(current) : edit.kind === "upsert" ? Boolean(current && current.participantId !== actorId) : !current || current.participantId !== actorId) throw new Error("Request unavailable");
  let replacement: FoodRequest | undefined;
  if (edit.kind === "add" || (edit.kind === "upsert" && !current)) replacement = RequestSchema.parse({ id: edit.requestId, participantId: actorId, version: 1, text: edit.text, kind: edit.requestKind, eaterIds: [...new Set(edit.eaterIds ?? [actorId])].sort(), servings: edit.servings ?? (edit.eaterIds?.length ?? 1) });
  else if (current && edit.kind !== "remove") {
    replacement = { ...current };
    if (edit.kind === "replace") { replacement.text = edit.text; replacement.kind = edit.requestKind; }
    if (edit.kind === "upsert") {
      replacement.text = edit.text;
      replacement.kind = edit.requestKind;
      if (edit.eaterIds) replacement.eaterIds = [...new Set(edit.eaterIds)].sort();
      if (edit.servings) replacement.servings = edit.servings;
    }
    if (edit.kind === "quantity") { replacement.quantity = edit.quantity; replacement.unit = edit.unit; }
    if (edit.kind === "servings") replacement.servings = edit.servings;
    if (edit.kind === "eaters") replacement.eaterIds = [...new Set(edit.eaterIds)].sort();
    if (JSON.stringify(replacement) === JSON.stringify(current)) return workspace;
    replacement.version++;
  }
  if (replacement?.eaterIds.some(id => !workspace.participants[id])) throw new Error("Unknown eater");
  const roots = requestDependencyKeys(edit.requestId);
  const changedRoots = edit.kind === "servings" || edit.kind === "quantity" ? [roots.scaling]
    : edit.kind === "eaters" ? [roots.eaters]
    : [roots.source, roots.scaling, roots.eaters, `request:${edit.requestId}`];
  return WorkspaceSchema.parse({ ...workspace, inputRevision: workspace.inputRevision + 1, participants: { ...workspace.participants, [actorId]: { ...workspace.participants[actorId], submission: "submitted" } }, requests: replacement ? [...workspace.requests.filter(r => r.id !== edit.requestId), replacement] : workspace.requests.filter(r => r.id !== edit.requestId), artifacts: invalidateArtifacts(workspace.artifacts, changedRoots) });
}

export function refreshContext(workspace: Workspace, participantId: string, refresh: ContextRefresh): Workspace {
  const participant = workspace.participants[participantId];
  if (!participant) throw new Error("Unknown participant");
  const previous = participant.contexts[refresh.source];
  if (previous && refresh.version <= previous.version) throw new Error("Stale context version");
  if (refresh.status === "success" && (!refresh.rules || !refresh.favorites || !refresh.evidenceRefs)) throw new Error("Successful context must declare empty or populated values");
  const context = ContextSchema.parse({ ...refresh, rules: refresh.status === "error" ? previous?.rules ?? [] : refresh.rules, favorites: refresh.status === "error" ? previous?.favorites ?? [] : refresh.favorites, evidenceRefs: refresh.status === "error" ? previous?.evidenceRefs ?? [] : refresh.evidenceRefs });
  const meaningful = JSON.stringify(previous?.rules ?? []) !== JSON.stringify(context.rules);
  return WorkspaceSchema.parse({ ...workspace, inputRevision: workspace.inputRevision + (meaningful ? 1 : 0), participants: { ...workspace.participants, [participantId]: { ...participant, contexts: { ...participant.contexts, [refresh.source]: context } } }, artifacts: meaningful ? invalidateArtifacts(workspace.artifacts, [`context:${participantId}`]) : workspace.artifacts });
}

export function effectiveRules(workspace: Workspace, eaterIds: string[]): HardRule[] {
  const rules = eaterIds.flatMap(id => {
    if (!workspace.participants[id]) throw new Error("Unknown eater");
    return Object.values(workspace.participants[id].contexts).flatMap(context => context.rules);
  });
  return [...new Map(rules.map(rule => [`${rule.kind}:${rule.value}:${rule.source}:${rule.id}`, rule])).values()];
}
