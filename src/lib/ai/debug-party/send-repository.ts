import { z } from "zod";
import { DebugCartSnapshotSchema, DebugPartySchema } from "./schemas";
import type { FrozenDebugCartSendRepository } from "./send-to-silpo";

type Result = { data: unknown; error: unknown };
type Query = PromiseLike<Result> & {
  eq(column: string, value: unknown): Query;
  maybeSingle(): PromiseLike<Result>;
};
type Table = {
  select(columns: string): Query;
  upsert(value: Record<string, unknown>, options?: { onConflict: string }): PromiseLike<Result>;
  update(value: Record<string, unknown>): Query;
};
type Client = { from(table: string): Table };
const row = z.record(z.string(), z.unknown());
async function read(query: PromiseLike<Result>) {
  const result = await query;
  if (result.error) throw new Error("Не вдалося зберегти або прочитати стан синхронізації.");
  return result.data;
}

export function createFrozenDebugCartSendRepositoryFromClients({ authenticated, admin, requireActor }: {
  authenticated: Client; admin: Client; requireActor: (actorId: string) => Promise<void>;
}): FrozenDebugCartSendRepository {
  async function authorize(partyId: string, actorId: string) {
    await requireActor(actorId);
    const party = row.parse(await read(authenticated.from("debug_parties").select("id, host_id, status").eq("id", partyId).maybeSingle()));
    if (party.host_id !== actorId || !["finalized", "sent"].includes(String(party.status))) throw new Error("Потрібен фінальний кошик Host.");
    return party;
  }
  return {
    async loadFrozenSnapshot({ code, actorId }) {
      await requireActor(actorId);
      const party = row.parse(await read(authenticated.from("debug_parties").select("id, host_id, status").eq("code", DebugPartySchema.shape.code.parse(code)).maybeSingle()));
      const member = await read(authenticated.from("debug_party_members").select("participant_id, role").eq("party_id", party.id).eq("participant_id", actorId).maybeSingle());
      if (!member) throw new Error("Ви не є учасником цієї вечірки.");
      const frozen = await read(authenticated.from("debug_cart_snapshots").select("id, party_id, cart_revision, total_cents, finalized_at").eq("party_id", party.id).maybeSingle());
      const mappedParty = { id: party.id, hostId: party.host_id, status: party.status };
      if (!frozen) return { party: mappedParty, snapshot: null };
      const snapshot = row.parse(frozen);
      const items = z.array(row).parse(await read(authenticated.from("debug_cart_snapshot_items").select("id, snapshot_id, product_id, company_id, branch_id, name, quantity, unit, unit_price_cents, discount_cents, image_url, evidence_id, observed_at, created_at").eq("snapshot_id", snapshot.id)));
      return { party: mappedParty, snapshot: DebugCartSnapshotSchema.parse({
        id: snapshot.id, partyId: snapshot.party_id, cartRevision: snapshot.cart_revision, totalCents: snapshot.total_cents, finalizedAt: snapshot.finalized_at,
        items: items.map((item) => ({ id: item.id, snapshotId: item.snapshot_id, productId: item.product_id, companyId: item.company_id,
          branchId: item.branch_id, name: item.name, quantity: item.quantity, unit: item.unit, unitPriceCents: item.unit_price_cents,
          discountCents: item.discount_cents, imageUrl: item.image_url, evidenceId: item.evidence_id, observedAt: item.observed_at, createdAt: item.created_at })),
      }) };
    },
    async findSendRun({ partyId, idempotencyKey }) {
      const value = await read(authenticated.from("debug_send_runs").select("id, status, line_results").eq("party_id", partyId).eq("idempotency_key", idempotencyKey).maybeSingle());
      if (!value) return null;
      const run = row.parse(value);
      return { id: run.id, status: run.status, lineResults: run.line_results };
    },
    async saveSendRun(input) {
      await authorize(input.partyId, input.actorId);
      await read(admin.from("debug_send_runs").upsert({ party_id: input.partyId, snapshot_id: input.snapshotId, actor_id: input.actorId,
        idempotency_key: input.idempotencyKey, status: input.status, line_results: input.lineResults, error: input.error ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "party_id,idempotency_key" }));
    },
    async markPartySent({ partyId, actorId }) {
      await authorize(partyId, actorId);
      await read(admin.from("debug_parties").update({ status: "sent", updated_at: new Date().toISOString() })
        .eq("id", partyId).eq("host_id", actorId).eq("status", "finalized"));
    },
  };
}

export async function createFrozenDebugCartSendRepository() {
  const [{ createClient }, { createAdminClient }] = await Promise.all([import("@/lib/supabase/server"), import("@/lib/supabase/admin")]);
  const authenticated = await createClient();
  // Narrow the ungenerated Supabase client at the transport edge; every returned row is parsed above.
  return createFrozenDebugCartSendRepositoryFromClients({ authenticated: authenticated as unknown as Client, admin: createAdminClient() as unknown as Client,
    requireActor: async (actorId) => {
      const { data, error } = await authenticated.auth.getUser();
      if (error || data.user?.id !== actorId) throw new Error("Session actor mismatch.");
    },
  });
}
