import "server-only";
import { z } from "zod";
import { createAdminClient } from "../../supabase/admin";

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const PublicDraftSchema = z.object({
  schemaVersion: z.literal(2),
  partyId: id,
  inputRevision: revision,
  draftRevision: revision,
  ready: z.boolean(),
  lines: z.array(z.object({
    productId: id, name: z.string().min(1), companyId: id, branchId: id,
    packageCount: z.number().int().positive(), packageQuantity: z.number().positive(),
    packageUnit: z.enum(["g", "ml", "piece"]), unitPriceCents: revision,
    lineTotalCents: revision, eaterIds: z.array(id),
  }).strict()),
  totalCents: revision,
  unresolvedCount: revision,
  blockerCodes: z.array(z.enum(["empty", "missing", "unknown", "unsafe", "units", "unavailable", "budget"])),
}).strict();

const StateSchema = z.object({
  workspace: z.object({ inputRevision: revision, draftRevision: revision, sourceRevision: revision, processedSourceRevision: revision }).strict().nullable(),
  draft: PublicDraftSchema.nullable(),
  activity: z.object({ code: z.enum(["queued", "working", "draft_updated", "waiting_for_input", "blocked", "completed", "failed", "cancelled", "superseded", "cart_approved", "cart_applying", "cart_applied", "cart_failed", "cart_unknown"]), createdAt: z.string() }).strict().nullable(),
  operation: z.object({ id, draftRevision: revision, status: z.enum(["approved", "applying", "verified", "failed", "unknown", "cancelled"]), updatedAt: z.string() }).strict().nullable(),
  activeJobs: z.number().int().nonnegative(),
}).strict();
type PresentationState = z.infer<typeof StateSchema>;

export interface AgentV2PresentationRepository {
  isMember(input: { partyId: string; actorId: string }): Promise<boolean>;
  readState(partyId: string): Promise<PresentationState>;
}

export function createAgentV2PresentationRepository(): AgentV2PresentationRepository {
  const admin = createAdminClient();
  return {
    async isMember(input) {
      const { data, error } = await admin.from("party_members").select("party_id").eq("party_id", input.partyId).eq("user_id", input.actorId).maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async readState(partyId) {
      const [workspace, draft, activity, operation, activeJobs] = await Promise.all([
        admin.from("party_agent_workspaces").select("input_revision,draft_revision,source_revision,processed_source_revision").eq("party_id", partyId).maybeSingle(),
        admin.from("party_agent_drafts").select("projection").eq("party_id", partyId).order("draft_revision", { ascending: false }).limit(1).maybeSingle(),
        admin.from("party_agent_activity").select("code,created_at").eq("party_id", partyId).order("id", { ascending: false }).limit(1).maybeSingle(),
        admin.from("party_cart_operations").select("id,draft_revision,status,updated_at").eq("party_id", partyId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        admin.from("party_agent_queue").select("id", { count: "exact", head: true }).eq("party_id", partyId).in("status", ["queued", "running"]),
      ]);
      for (const result of [workspace, draft, activity, operation, activeJobs]) if (result.error) throw result.error;
      return StateSchema.parse({
        workspace: workspace.data ? { inputRevision: workspace.data.input_revision, draftRevision: workspace.data.draft_revision, sourceRevision: workspace.data.source_revision, processedSourceRevision: workspace.data.processed_source_revision } : null,
        draft: draft.data ? draft.data.projection : null,
        activity: activity.data ? { code: activity.data.code, createdAt: activity.data.created_at } : null,
        operation: operation.data ? { id: operation.data.id, draftRevision: operation.data.draft_revision, status: operation.data.status, updatedAt: operation.data.updated_at } : null,
        activeJobs: activeJobs.count ?? 0,
      });
    },
  };
}

export async function loadAgentV2Presentation(input: { partyId: string; actorId: string }, repository: AgentV2PresentationRepository = createAgentV2PresentationRepository()) {
  if (!await repository.isMember(input)) throw new Error("Party membership required");
  const state = StateSchema.parse(await repository.readState(input.partyId));
  const waiting = state.activity?.code === "waiting_for_input";
  const pending = state.activeJobs > 0 || waiting || ["applying", "unknown"].includes(state.operation?.status ?? "");
  const stale = Boolean(state.draft && (!state.workspace
    || state.draft.inputRevision !== state.workspace.inputRevision
    || state.draft.draftRevision !== state.workspace.draftRevision
    || state.workspace.sourceRevision !== state.workspace.processedSourceRevision));
  return {
    draft: state.draft,
    activity: state.activity,
    ready: Boolean(state.draft?.ready && !stale && !pending),
    stale,
    pending,
    appliedRevision: state.operation?.status === "verified" ? state.operation.draftRevision : null,
    operationId: state.operation?.id ?? null,
    operationStatus: state.operation?.status ?? null,
  };
}

export type AgentV2Presentation = Awaited<ReturnType<typeof loadAgentV2Presentation>>;
