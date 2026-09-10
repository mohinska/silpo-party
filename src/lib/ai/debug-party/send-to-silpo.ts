import "server-only";

import { z } from "zod";

import { DebugCartSnapshotSchema, type DebugCartSnapshot, type DebugCartSnapshotItem } from "./schemas";

const SendInputSchema = z.strictObject({
  code: z.string().regex(/^[A-Z0-9]{8}$/),
  actorId: z.string().trim().min(1).max(200),
  confirmChanges: z.boolean(),
});

const PartySchema = z.object({
  id: z.string().trim().min(1).max(200),
  hostId: z.string().trim().min(1).max(200),
  status: z.enum(["collecting", "ready", "running", "finalized", "sent"]),
}).strict();

const LiveLineSchema = z.strictObject({
  productId: z.string().trim().min(1).max(200),
  companyId: z.string().trim().min(1).max(200),
  branchId: z.string().trim().min(1).max(200),
  available: z.boolean(),
  unitPriceCents: z.number().int().nonnegative(),
});

const CartLineSchema = z.strictObject({
  productId: z.string().trim().min(1).max(200),
  companyId: z.string().trim().min(1).max(200),
  branchId: z.string().trim().min(1).max(200),
  quantity: z.number().finite().positive(),
});

const LineResultSchema = z.strictObject({
  itemId: z.string().trim().min(1).max(200),
  status: z.enum(["applied", "already_applied", "failed", "unavailable"]),
  error: z.string().trim().min(1).max(500).optional(),
});

const StoredRunSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "running", "confirmation_required", "partial", "completed", "failed"]),
  lineResults: z.array(LineResultSchema).max(100),
});

export type SendLineChange = {
  itemId: string;
  available: boolean;
  unitPriceCents: number;
};

export type SendLineResult = z.infer<typeof LineResultSchema>;

export type SendResult =
  | { status: "confirmation_required"; changes: SendLineChange[] }
  | { status: "completed"; lineResults: SendLineResult[]; idempotent: boolean }
  | { status: "partial"; lineResults: SendLineResult[] };

/**
 * Persistence stays behind this narrow port: sender tests can exercise the
 * external-cart behavior without a Supabase session, while the action layer owns
 * the production adapter and its authorization context.
 */
export type FrozenDebugCartSendRepository = {
  loadFrozenSnapshot(input: { code: string; actorId: string }): Promise<unknown>;
  findSendRun(input: { partyId: string; idempotencyKey: string }): Promise<unknown | null>;
  saveSendRun(input: {
    partyId: string;
    snapshotId: string;
    actorId: string;
    idempotencyKey: string;
    status: "confirmation_required" | "partial" | "completed";
    lineResults: SendLineResult[];
    error?: string;
  }): Promise<void>;
  markPartySent(input: { partyId: string; actorId: string }): Promise<void>;
};

export type FrozenDebugCartAdapter = {
  revalidate(hostId: string, lines: readonly DebugCartSnapshotItem[]): Promise<unknown[]>;
  readCart(hostId: string): Promise<unknown[]>;
  applyLines(hostId: string, lines: readonly DebugCartSnapshotItem[]): Promise<unknown[]>;
};

export type SendFrozenDebugCartDependencies = {
  repository: FrozenDebugCartSendRepository;
  cart: FrozenDebugCartAdapter;
};

function key(line: Pick<DebugCartSnapshotItem, "productId" | "companyId" | "branchId">) {
  return `${line.productId}\u0000${line.companyId}\u0000${line.branchId}`;
}

function normalizeSnapshot(value: unknown): DebugCartSnapshot {
  return DebugCartSnapshotSchema.parse(value);
}

function changesFor(snapshot: DebugCartSnapshot, liveLines: readonly z.infer<typeof LiveLineSchema>[]): SendLineChange[] {
  const live = new Map(liveLines.map((line) => [key(line), line]));
  return snapshot.items.flatMap((item) => {
    const current = live.get(key(item));
    if (current && current.available && current.unitPriceCents === item.unitPriceCents) return [];
    return [{ itemId: item.id, available: current?.available ?? false, unitPriceCents: current?.unitPriceCents ?? item.unitPriceCents }];
  });
}

function reconcile(snapshot: DebugCartSnapshot, cartLines: readonly z.infer<typeof CartLineSchema>[]) {
  const quantities = new Map<string, number>();
  for (const line of cartLines) quantities.set(key(line), (quantities.get(key(line)) ?? 0) + line.quantity);
  return snapshot.items.filter((item) => quantities.get(key(item)) === item.quantity);
}

function completedResult(run: z.infer<typeof StoredRunSchema>, idempotent: boolean): SendResult {
  return { status: "completed", lineResults: run.lineResults, idempotent };
}

/**
 * Sends only a validated immutable snapshot. It has no language-model imports or
 * model parameter; every decision comes from the snapshot and Host MCP responses.
 */
export async function sendFrozenDebugCart(
  input: unknown,
  dependencies: SendFrozenDebugCartDependencies,
): Promise<SendResult> {
  const request = SendInputSchema.parse(input);
  const loaded = z.strictObject({ party: PartySchema, snapshot: z.unknown().nullable() }).parse(
    await dependencies.repository.loadFrozenSnapshot({ code: request.code, actorId: request.actorId }),
  );
  const party = loaded.party;
  if (party.hostId !== request.actorId) throw new Error("Лише Організатор може надіслати кошик до «Сільпо».");
  if (party.status !== "finalized" && party.status !== "sent") throw new Error("Кошик ще не фіналізовано.");
  if (!loaded.snapshot) throw new Error("Фінальний знімок кошика відсутній.");
  const frozen = normalizeSnapshot(loaded.snapshot);
  if (frozen.partyId !== party.id) throw new Error("Фінальний знімок не відповідає вечірці.");

  const idempotencyKey = frozen.id;
  const prior = await dependencies.repository.findSendRun({ partyId: party.id, idempotencyKey });
  if (prior) {
    const run = StoredRunSchema.parse(prior);
    if (run.status === "completed") return completedResult(run, true);
  } else if (party.status === "sent") {
    throw new Error("Надісланий кошик не має завершеного запису синхронізації.");
  }

  const liveLines = z.array(LiveLineSchema).max(100).parse(await dependencies.cart.revalidate(party.hostId, frozen.items));
  const changes = changesFor(frozen, liveLines);
  if (changes.length && !request.confirmChanges) {
    await dependencies.repository.saveSendRun({ partyId: party.id, snapshotId: frozen.id, actorId: request.actorId,
      idempotencyKey, status: "confirmation_required", lineResults: [] });
    return { status: "confirmation_required", changes };
  }

  const currentCart = z.array(CartLineSchema).max(500).parse(await dependencies.cart.readCart(party.hostId));
  const existing = reconcile(frozen, currentCart);
  const existingIds = new Set(existing.map((item) => item.id));
  const live = new Map(liveLines.map((line) => [key(line), line]));
  const unavailable = frozen.items.filter((item) => live.get(key(item))?.available !== true);
  const pending = frozen.items.filter((item) => !existingIds.has(item.id) && !unavailable.some((failed) => failed.id === item.id));
  const saved: SendLineResult[] = [
    ...existing.map((item) => ({ itemId: item.id, status: "already_applied" as const })),
    ...unavailable.map((item) => ({ itemId: item.id, status: "unavailable" as const, error: "Товар зараз недоступний у «Сільпо»." })),
  ];

  if (pending.length) {
    try {
      const rawResults = await dependencies.cart.applyLines(party.hostId, pending);
      const results = z.array(LineResultSchema).max(100).parse(rawResults);
      const byItem = new Map(results.map((result) => [result.itemId, result]));
      for (const item of pending) saved.push(byItem.get(item.id) ?? { itemId: item.id, status: "failed", error: "«Сільпо» не підтвердило запис товару в кошик." });
    } catch {
      for (const item of pending) saved.push({ itemId: item.id, status: "failed", error: "Не вдалося оновити кошик «Сільпо»." });
    }
  }

  const status = saved.every((result) => result.status === "applied" || result.status === "already_applied") ? "completed" : "partial";
  await dependencies.repository.saveSendRun({ partyId: party.id, snapshotId: frozen.id, actorId: request.actorId,
    idempotencyKey, status, lineResults: saved, error: status === "partial" ? "Не всі товари синхронізовано з «Сільпо»." : undefined });
  if (status === "completed") await dependencies.repository.markPartySent({ partyId: party.id, actorId: request.actorId });
  return status === "completed" ? { status, lineResults: saved, idempotent: false } : { status, lineResults: saved };
}

/** Production Host-MCP adapter using the existing scoped catalog/cart helpers. */
export function createSilpoFrozenCartAdapter(): FrozenDebugCartAdapter {
  return {
    async revalidate(hostId, lines) {
      const { withSilpoCatalogReader } = await import("../../silpo/cart");
      return withSilpoCatalogReader(hostId, async (reader) => {
        const checks = await Promise.all(lines.map(async (line) => {
          const product = (await reader.inspect(line.productId)).find((candidate) =>
            candidate.productId === line.productId && candidate.companyId === line.companyId && candidate.branchId === line.branchId,
          );
          return product ? { productId: product.productId, companyId: product.companyId, branchId: product.branchId,
            available: product.available, unitPriceCents: product.unitPriceCents }
            : { productId: line.productId, companyId: line.companyId, branchId: line.branchId, available: false, unitPriceCents: line.unitPriceCents };
        }));
        return checks;
      });
    },
    async readCart(hostId) {
      const { readSilpoCartSnapshot } = await import("../../silpo/cart");
      return (await readSilpoCartSnapshot(hostId)).lines;
    },
    async applyLines(hostId, lines) {
      const { writeSilpoProposalLines } = await import("../../silpo/cart");
      const results: SendLineResult[] = [];
      for (const line of lines) {
        if (!Number.isSafeInteger(line.quantity)) {
          results.push({ itemId: line.id, status: "failed", error: "Кількість товару має бути цілим числом упаковок." });
          continue;
        }
        try {
          await writeSilpoProposalLines(hostId, [{ requirementKeys: [line.id], productId: line.productId,
            companyId: line.companyId, branchId: line.branchId, name: line.name, packageCount: line.quantity,
            packageQuantity: 1, packageUnit: "piece", unitPriceCents: line.unitPriceCents,
            lineTotalCents: Math.round(line.quantity * line.unitPriceCents) }]);
          results.push({ itemId: line.id, status: "applied" });
        } catch {
          results.push({ itemId: line.id, status: "failed", error: "Не вдалося оновити кошик «Сільпо»." });
        }
      }
      return results;
    },
  };
}
