import { z } from "zod";

import {
  DebugCartItemSchema,
  DebugFoodIntentSchema,
  DebugParticipantContextSchema,
  DebugPartyMemberSchema,
  DebugPartySchema,
  type DebugCartItem,
  type DebugFoodIntent,
  type DebugParticipantContext,
  type DebugParty,
  type DebugPartyMember,
} from "./schemas";

type UnknownRow = Record<string, unknown>;

const IdSchema = z.string().trim().min(1).max(200);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();
const RunModeSchema = z.enum(["preprocess", "build", "chat"]);
const RunStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
const ToolEventStatusSchema = z.enum(["running", "completed", "failed"]);

const CartMutationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("add"), evidenceId: IdSchema, quantity: z.number().finite().positive() }),
  z.strictObject({ type: z.literal("replace"), evidenceId: IdSchema, itemId: IdSchema, quantity: z.number().finite().positive() }),
  z.strictObject({ type: z.literal("quantity"), itemId: IdSchema, quantity: z.number().finite().positive() }),
  z.strictObject({ type: z.literal("remove"), itemId: IdSchema }),
]);

const CartCommandSchema = z.strictObject({
  partyId: IdSchema,
  actorId: IdSchema,
  expectedRevision: NonNegativeIntegerSchema,
  mutation: CartMutationSchema,
});

const CartCommandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("stale"), currentRevision: NonNegativeIntegerSchema }),
  z.strictObject({ status: z.literal("applied"), currentRevision: NonNegativeIntegerSchema, itemId: IdSchema }),
]);

const StartRunSchema = z.strictObject({
  partyId: IdSchema,
  actorId: IdSchema,
  mode: RunModeSchema,
  participantId: IdSchema.optional(),
  messageId: IdSchema.optional(),
  intentRevision: PositiveIntegerSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
});

const ToolEventSchema = z.strictObject({
  partyId: IdSchema,
  actorId: IdSchema,
  runId: IdSchema,
  toolName: z.string().trim().min(1).max(200),
  status: ToolEventStatusSchema,
  durationMs: NonNegativeIntegerSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const ReplaceContextSchema = z.strictObject({
  partyId: IdSchema,
  actorId: IdSchema,
  participantId: IdSchema,
  context: DebugParticipantContextSchema,
});

const CompleteRunSchema = z.strictObject({
  partyId: IdSchema,
  actorId: IdSchema,
  runId: IdSchema,
  status: z.enum(["completed", "failed"]),
  error: z.string().trim().max(500).optional(),
});

const DebugAgentRunSchema = z.strictObject({
  id: IdSchema,
  partyId: IdSchema,
  actorId: IdSchema,
  mode: RunModeSchema,
  status: RunStatusSchema,
  messageId: IdSchema.nullable(),
  intentRevision: PositiveIntegerSchema.nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
  maxSteps: z.number().int().min(1).max(100).nullable(),
  error: z.string().trim().max(500).nullable(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type CartMutation = z.infer<typeof CartMutationSchema>;
export type ApplyCartCommandInput = z.infer<typeof CartCommandSchema>;
export type ApplyCartCommandResult = z.infer<typeof CartCommandResultSchema>;
export type StartRunInput = z.infer<typeof StartRunSchema>;
export type AppendToolEventInput = z.infer<typeof ToolEventSchema>;
export type ReplaceContextInput = z.infer<typeof ReplaceContextSchema>;
export type CompleteRunInput = z.infer<typeof CompleteRunSchema>;
export type DebugAgentRun = z.infer<typeof DebugAgentRunSchema>;

export type DebugPartyWorkspace = {
  party: DebugParty;
  member: DebugPartyMember;
  members: DebugPartyMember[];
  intents: DebugFoodIntent[];
  contexts: DebugParticipantContext[];
  cartItems: DebugCartItem[];
};

export type DebugPartyWorkspaceRow = {
  party: unknown;
  members: unknown[];
  intents: unknown[];
  contexts: unknown[];
  cartItems: unknown[];
};

type RunInsert = {
  partyId: string;
  actorId: string;
  mode: StartRunInput["mode"];
  messageId?: string;
  intentRevision?: number;
  model?: string;
  maxSteps?: number;
};

/**
 * The repository depends on this small persistence port so orchestration tests do
 * not need a Supabase session. The Supabase adapter is intentionally kept below
 * the authorization boundary; all methods on this port are server-only writes.
 */
export interface DebugPartyPersistencePort {
  findWorkspace(code: string, actorId: string): Promise<DebugPartyWorkspaceRow | null>;
  findMembership(partyId: string, participantId: string): Promise<unknown | null>;
  insertRun(input: RunInsert): Promise<unknown>;
  insertToolEvent(input: AppendToolEventInput): Promise<unknown>;
  upsertContext(input: ReplaceContextInput): Promise<unknown>;
  advanceCartRevision(input: ApplyCartCommandInput): Promise<unknown>;
  updateRun(input: CompleteRunInput): Promise<unknown>;
}

function object(value: unknown, label: string): UnknownRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} має бути об'єктом бази даних.`);
  }
  return value as UnknownRow;
}

function mapParty(value: unknown): DebugParty {
  const row = object(value, "Debug party");
  return DebugPartySchema.parse({
    id: row.id,
    code: row.code,
    hostId: row.host_id,
    budgetCents: row.budget_cents,
    status: row.status,
    cartRevision: row.cart_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMember(value: unknown): DebugPartyMember {
  const row = object(value, "Debug party member");
  return DebugPartyMemberSchema.parse({
    partyId: row.party_id,
    participantId: row.participant_id,
    role: row.role,
    contextStatus: row.context_status,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  });
}

function mapIntent(value: unknown): DebugFoodIntent {
  const row = object(value, "Debug food intent");
  return DebugFoodIntentSchema.parse({
    id: row.id,
    partyId: row.party_id,
    participantId: row.participant_id,
    request: row.request,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapContext(value: unknown): DebugParticipantContext {
  const row = object(value, "Debug participant context");
  return DebugParticipantContextSchema.parse({
    id: row.id,
    partyId: row.party_id,
    participantId: row.participant_id,
    intentRevision: row.intent_revision,
    contextStatus: row.context_status,
    purchaseHistoryStatus: row.purchase_history_status,
    dietaryRestrictions: row.dietary_restrictions,
    favorites: row.favorites,
    recentProducts: row.recent_products,
    summary: row.summary,
    collectedAt: row.collected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapCartItem(value: unknown): DebugCartItem {
  const row = object(value, "Debug cart item");
  return DebugCartItemSchema.parse({
    id: row.id,
    partyId: row.party_id,
    productId: row.product_id,
    companyId: row.company_id,
    branchId: row.branch_id,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    unitPriceCents: row.unit_price_cents,
    discountCents: row.discount_cents,
    imageUrl: row.image_url,
    evidenceId: row.evidence_id,
    observedAt: row.observed_at,
    introducedRevision: row.introduced_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapRun(value: unknown): DebugAgentRun {
  const row = object(value, "Debug agent run");
  return DebugAgentRunSchema.parse({
    id: row.id,
    partyId: row.party_id,
    actorId: row.actor_id,
    mode: row.mode,
    status: row.status,
    messageId: row.message_id,
    intentRevision: row.intent_revision,
    model: row.model,
    maxSteps: row.max_steps,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rpcMutation(mutation: CartMutation): Record<string, unknown> {
  switch (mutation.type) {
    case "add":
      return { type: mutation.type, evidenceId: mutation.evidenceId, quantity: mutation.quantity };
    case "replace":
      return { type: mutation.type, evidenceId: mutation.evidenceId, itemId: mutation.itemId, quantity: mutation.quantity };
    case "quantity":
      return { type: mutation.type, itemId: mutation.itemId, quantity: mutation.quantity };
    case "remove":
      return { type: mutation.type, itemId: mutation.itemId };
  }
}

export class DebugPartyRepository {
  constructor(private readonly persistence: DebugPartyPersistencePort) {}

  async loadWorkspace(code: string, actorId: string): Promise<DebugPartyWorkspace> {
    const workspace = await this.persistence.findWorkspace(code, actorId);
    if (!workspace) throw new Error("Ви не є учасником цієї вечірки.");

    const party = mapParty(workspace.party);
    const members = workspace.members.map(mapMember);
    const member = members.find((candidate) => candidate.participantId === actorId);
    if (!member) throw new Error("Ви не є учасником цієї вечірки.");

    return {
      party,
      member,
      members,
      intents: workspace.intents.map(mapIntent),
      contexts: workspace.contexts.map(mapContext),
      cartItems: workspace.cartItems.map(mapCartItem),
    };
  }

  async startRun(input: StartRunInput): Promise<DebugAgentRun> {
    const parsed = StartRunSchema.parse(input);
    const member = await this.requireMembership(parsed.partyId, parsed.actorId);
    if (parsed.mode === "build" && member.role !== "host") {
      throw new Error("Лише Host може запускати збір кошика.");
    }
    if (parsed.mode === "preprocess" && parsed.participantId !== parsed.actorId) {
      throw new Error("Учасник може запускати лише власний контекст.");
    }
    return mapRun(await this.persistence.insertRun(parsed));
  }

  async appendToolEvent(input: AppendToolEventInput): Promise<void> {
    const parsed = ToolEventSchema.parse(input);
    await this.requireMembership(parsed.partyId, parsed.actorId);
    await this.persistence.insertToolEvent(parsed);
  }

  async replaceContext(input: ReplaceContextInput): Promise<DebugParticipantContext> {
    const parsed = ReplaceContextSchema.parse(input);
    await this.requireMembership(parsed.partyId, parsed.actorId);
    if (parsed.context.partyId !== parsed.partyId || parsed.context.participantId !== parsed.participantId) {
      throw new Error("Контекст не відповідає учаснику вечірки.");
    }
    return mapContext(await this.persistence.upsertContext(parsed));
  }

  async applyCartCommand(input: ApplyCartCommandInput): Promise<ApplyCartCommandResult> {
    const parsed = CartCommandSchema.parse(input);
    await this.requireMembership(parsed.partyId, parsed.actorId);
    const result = CartCommandResultSchema.parse(await this.persistence.advanceCartRevision(parsed));
    if (result.status === "applied" && result.currentRevision !== parsed.expectedRevision + 1) {
      throw new Error("Атомарне оновлення кошика повернуло некоректну ревізію.");
    }
    return result;
  }

  async completeRun(input: CompleteRunInput): Promise<void> {
    const parsed = CompleteRunSchema.parse(input);
    await this.requireMembership(parsed.partyId, parsed.actorId);
    await this.persistence.updateRun(parsed);
  }

  private async requireMembership(partyId: string, actorId: string): Promise<DebugPartyMember> {
    const membership = await this.persistence.findMembership(partyId, actorId);
    if (!membership) throw new Error("Ви не є учасником цієї вечірки.");
    const member = mapMember(membership);
    if (member.partyId !== partyId || member.participantId !== actorId) {
      throw new Error("Некоректне членство вечірки.");
    }
    return member;
  }
}

/** Creates the production port. Dynamic imports keep the testable domain adapter free of client-side imports. */
export async function createDebugPartyRepository(): Promise<DebugPartyRepository> {
  const [{ createClient }, { createAdminClient }] = await Promise.all([
    import("@/lib/supabase/server"),
    import("@/lib/supabase/admin"),
  ]);
  const authenticated = await createClient();
  const admin = createAdminClient();

  return new DebugPartyRepository({
    async findWorkspace(code, actorId) {
      const { data: party, error: partyError } = await authenticated
        .from("debug_parties")
        .select("id, code, host_id, budget_cents, status, cart_revision, cart_stale, created_at, updated_at")
        .eq("code", code)
        .maybeSingle();
      if (partyError) throw partyError;
      if (!party) return null;

      const partyId = String(party.id);
      const [membersResult, intentsResult, contextsResult, cartItemsResult] = await Promise.all([
        authenticated.from("debug_party_members").select("party_id, participant_id, role, context_status, joined_at, updated_at").eq("party_id", partyId),
        authenticated.from("debug_food_intents").select("id, party_id, participant_id, request, revision, created_at, updated_at").eq("party_id", partyId),
        authenticated.from("debug_participant_contexts").select("id, party_id, participant_id, intent_revision, context_status, purchase_history_status, dietary_restrictions, favorites, recent_products, summary, collected_at, created_at, updated_at").eq("party_id", partyId),
        authenticated.from("debug_cart_items").select("id, party_id, product_id, company_id, branch_id, name, quantity, unit, unit_price_cents, discount_cents, image_url, evidence_id, observed_at, introduced_revision, created_at, updated_at").eq("party_id", partyId),
      ]);
      for (const result of [membersResult, intentsResult, contextsResult, cartItemsResult]) {
        if (result.error) throw result.error;
      }
      const members = membersResult.data ?? [];
      if (!members.some((member) => member.participant_id === actorId)) return null;
      return { party, members, intents: intentsResult.data ?? [], contexts: contextsResult.data ?? [], cartItems: cartItemsResult.data ?? [] };
    },

    async findMembership(partyId, participantId) {
      const { data, error } = await authenticated
        .from("debug_party_members")
        .select("party_id, participant_id, role, context_status, joined_at, updated_at")
        .eq("party_id", partyId)
        .eq("participant_id", participantId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async insertRun(input) {
      const { data, error } = await admin.from("debug_agent_runs").insert({
        party_id: input.partyId,
        actor_id: input.actorId,
        mode: input.mode,
        status: "running",
        message_id: input.messageId ?? null,
        intent_revision: input.intentRevision ?? null,
        model: input.model ?? null,
        max_steps: input.maxSteps ?? null,
        started_at: new Date().toISOString(),
      }).select("id, party_id, actor_id, mode, status, message_id, intent_revision, model, max_steps, error, started_at, finished_at, created_at, updated_at").single();
      if (error) throw error;
      return data;
    },

    async insertToolEvent(input) {
      const { error } = await admin.from("debug_tool_events").insert({
        party_id: input.partyId,
        run_id: input.runId,
        tool_name: input.toolName,
        status: input.status,
        duration_ms: input.durationMs ?? null,
        metadata: input.metadata,
      });
      if (error) throw error;
    },

    async upsertContext(input) {
      const context = input.context;
      const { data, error } = await admin.from("debug_participant_contexts").upsert({
        id: context.id,
        party_id: context.partyId,
        participant_id: context.participantId,
        intent_revision: context.intentRevision,
        context_status: context.contextStatus,
        purchase_history_status: context.purchaseHistoryStatus,
        dietary_restrictions: context.dietaryRestrictions,
        favorites: context.favorites,
        recent_products: context.recentProducts,
        summary: context.summary,
        collected_at: context.collectedAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: "party_id,participant_id" }).select("id, party_id, participant_id, intent_revision, context_status, purchase_history_status, dietary_restrictions, favorites, recent_products, summary, collected_at, created_at, updated_at").single();
      if (error) throw error;
      return data;
    },

    async advanceCartRevision(input) {
      const { data, error } = await admin.rpc("advance_debug_cart_revision", {
        target_party_id: input.partyId,
        actor_id: input.actorId,
        expected_revision: input.expectedRevision,
        mutation: rpcMutation(input.mutation),
      });
      if (error) throw error;
      return data;
    },

    async updateRun(input) {
      const { error } = await admin.from("debug_agent_runs").update({
        status: input.status,
        error: input.error ?? null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", input.runId).eq("party_id", input.partyId);
      if (error) throw error;
    },
  });
}

async function productionRepository(): Promise<DebugPartyRepository> {
  return createDebugPartyRepository();
}

export async function loadWorkspace(code: string, actorId: string) {
  return (await productionRepository()).loadWorkspace(code, actorId);
}

export async function startRun(input: StartRunInput) {
  return (await productionRepository()).startRun(input);
}

export async function appendToolEvent(input: AppendToolEventInput) {
  return (await productionRepository()).appendToolEvent(input);
}

export async function replaceContext(input: ReplaceContextInput) {
  return (await productionRepository()).replaceContext(input);
}

export async function applyCartCommand(input: ApplyCartCommandInput) {
  return (await productionRepository()).applyCartCommand(input);
}

export async function completeRun(input: CompleteRunInput) {
  return (await productionRepository()).completeRun(input);
}
