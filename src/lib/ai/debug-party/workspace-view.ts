import { z } from "zod";
import { DebugCartSnapshotSchema } from "./schemas";

const id = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
const runSchema = z.object({
  id, actor_id: id, mode: z.enum(["preprocess", "build", "chat"]),
  status: z.enum(["queued", "running", "completed", "failed"]), created_at: timestamp,
});
const eventSchema = z.object({
  id, run_id: id, tool_name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/),
  status: z.enum(["running", "completed", "failed"]), duration_ms: z.number().int().nonnegative().nullable(),
  created_at: timestamp, metadata: z.unknown().optional(),
});
export const SendStatusSchema = z.enum(["pending", "running", "confirmation_required", "partial", "completed", "failed"]);

export function mapWorkspaceRun(value: unknown) {
  const row = runSchema.parse(value);
  return { id: row.id, actorId: row.actor_id, mode: row.mode, status: row.status, createdAt: row.created_at };
}

export function mapWorkspaceToolEvent(value: unknown) {
  const row = eventSchema.parse(value);
  // Only an explicitly allowed numeric count crosses the server/client boundary.
  const metadata = z.object({
    count: z.number().int().nonnegative().max(1000000).optional(),
    mcpTool: z.string().regex(/^silpo_[a-z0-9_]{1,120}$/).optional(),
    errorCode: z.string().regex(/^[A-Z0-9_-]{1,80}$/).optional(),
  }).safeParse(row.metadata);
  return { id: row.id, runId: row.run_id, toolName: row.tool_name, status: row.status,
    durationMs: row.duration_ms, createdAt: row.created_at, count: metadata.success ? metadata.data.count ?? null : null,
    mcpTool: metadata.success ? metadata.data.mcpTool ?? null : null,
    errorCode: metadata.success ? metadata.data.errorCode ?? null : null };
}

export function mapWorkspaceSnapshot(value: unknown) {
  if (!value) return null;
  const row = z.record(z.string(), z.unknown()).parse(value);
  const items = z.array(z.record(z.string(), z.unknown())).parse(row.items);
  return DebugCartSnapshotSchema.parse({ id: row.id, partyId: row.party_id,
    cartRevision: row.cart_revision, totalCents: row.total_cents, finalizedAt: row.finalized_at,
    items: items.map((item) => ({ id: item.id, snapshotId: item.snapshot_id, productId: item.product_id,
      companyId: item.company_id, branchId: item.branch_id, name: item.name, quantity: item.quantity, unit: item.unit,
      unitPriceCents: item.unit_price_cents, discountCents: item.discount_cents, imageUrl: item.image_url,
      evidenceId: item.evidence_id, observedAt: item.observed_at, createdAt: item.created_at })),
  });
}
