import { z } from "zod";
import { readToolData } from "../../silpo/tool-data";
import { discoverPersonalCapabilities, personalMcpAdapter, type PersonalMcpAdapter, type PersonalRole } from "./mcp-tools";
import { PERSONAL_CONTEXT_PROMPT } from "./prompts";
import { DebugParticipantContextSchema, FoodRequestSchema, type DebugFoodIntent, type DebugParticipantContext } from "./schemas";

export const PersonalSignalsSchema = DebugParticipantContextSchema.pick({
  dietaryRestrictions: true, favorites: true, recentProducts: true, purchaseHistoryStatus: true,
}).extend({ foodRequest: FoodRequestSchema });
export type PersonalSignals = z.infer<typeof PersonalSignalsSchema>;
const NormalizedPersonalSchema = DebugParticipantContextSchema.pick({
  dietaryRestrictions: true, favorites: true, summary: true,
});
export type PersonalNormalizer = (request: { system: string; signals: PersonalSignals }) => Promise<unknown>;

const SENSITIVE_KEY = /access.?token|refresh.?token|authorization|cookie|password|secret|ciphertext|api.?key|e-?mail|phone|address|birth|receipt|contact|customer|first.?name|last.?name/i;
const MAX_BYTES = 50_000;
const encoder = new TextEncoder();
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max = 500): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Bound transport decoding first, then traversal. Nothing raw crosses the model boundary. */
function boundedPayload(raw: unknown): unknown {
  const envelope = record(raw);
  if (envelope?.isError === true) throw new Error("Personal capability unavailable");
  let decoded: unknown = raw;
  if (envelope?.structuredContent) decoded = envelope.structuredContent;
  else if (Array.isArray(envelope?.content)) {
    let bytes = 0;
    const content: Array<{ text: string }> = [];
    for (const block of envelope.content.slice(0, 20)) {
      const value = record(block)?.text;
      if (typeof value !== "string" || value.length > MAX_BYTES) continue;
      bytes += encoder.encode(value).byteLength;
      if (bytes > MAX_BYTES) break;
      content.push({ text: value });
    }
    decoded = content.length ? readToolData({ content }) : undefined;
  }
  let visited = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  function trim(value: unknown, depth: number): unknown {
    if (++visited > 500 || depth > 8 || bytes >= MAX_BYTES) return undefined;
    if (typeof value === "string") {
      const bounded = value.slice(0, 500);
      bytes += encoder.encode(bounded).byteLength;
      return bytes <= MAX_BYTES ? bounded : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      bytes += 8;
      return value;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => trim(item, depth + 1));
    const output: Record<string, unknown> = Object.create(null);
    let keys = 0;
    for (const key in value) {
      if (++keys > 100 || visited >= 500 || bytes >= MAX_BYTES) break;
      if (!Object.hasOwn(value, key) || key.length > 100 || SENSITIVE_KEY.test(key)) continue;
      bytes += encoder.encode(key).byteLength;
      output[key] = trim((value as Record<string, unknown>)[key], depth + 1);
    }
    return output;
  }
  return trim(decoded, 0);
}

type Fact = PersonalSignals["dietaryRestrictions"][number];
function mergeFacts(first: Fact[], second: Fact[]): Fact[] {
  const seen = new Set<string>();
  return [...first, ...second].filter(({ label }) => {
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
}

function extractFood(payload: unknown, role: PersonalRole, signals: PersonalSignals) {
  let serial = 0;
  function walk(value: unknown, kind?: "dietaryRestrictions" | "favorites") {
    if (Array.isArray(value)) { value.forEach((item) => walk(item, kind)); return; }
    const obj = record(value);
    if (kind) {
      const label = text(obj ? obj.label ?? obj.name ?? obj.title ?? obj.productName : value);
      if (label) signals[kind] = mergeFacts(signals[kind], [{ label, evidenceId: `silpo-${role}:${++serial}` }]);
    }
    if (!obj) return;
    for (const [key, nested] of Object.entries(obj)) {
      const next = /allerg|restrict|forbidden|diet|алерг|обмеж/i.test(key) ? "dietaryRestrictions"
        : /favorite|favourite|preference|улюб/i.test(key) ? "favorites" : kind;
      // Scalar food labels are accepted only in recognized fields/containers.
      if (typeof nested === "object" || next !== kind) walk(nested, next);
    }
  }
  walk(payload, role === "restrictions" ? "dietaryRestrictions" : role === "favorites" ? "favorites" : undefined);
}

function extractOrders(payload: unknown): PersonalSignals["recentProducts"] | undefined {
  const root = record(payload);
  const container = root?.orders ?? root?.purchases ?? root?.items ?? root?.data ?? payload;
  if (!Array.isArray(container)) return undefined;
  const dated = container.map((value, index) => {
    const item = record(value);
    const date = item?.createdAt ?? item?.created_at ?? item?.orderedAt ?? item?.purchaseDate ?? item?.date;
    const timestamp = typeof date === "string" ? Date.parse(date) : NaN;
    return { item, index, timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity };
  }).sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).slice(0, 5);
  const products: PersonalSignals["recentProducts"] = [];
  for (const { item, index } of dated) {
    const items = item?.products ?? item?.items ?? item?.lines ?? (item ? [item] : []);
    if (!Array.isArray(items)) continue;
    for (const line of items) {
      const outer = record(line);
      const product = record(outer?.product) ?? outer;
      const productId = text(product?.productId ?? product?.product_id ?? product?.id, 200);
      const name = text(product?.name ?? product?.productName ?? product?.title);
      if (!productId || !name || products.some((p) => p.productId === productId)) continue;
      products.push({ productId, name, evidenceId: `silpo-purchase:${index + 1}:${products.length + 1}` });
      if (products.length === 5) return products;
    }
  }
  return products;
}

export async function collectPersonalContext({ userId, foodRequest, callBudget, mcpAdapter = personalMcpAdapter, normalizer }: {
  userId: string;
  foodRequest: Pick<DebugFoodIntent, "partyId" | "participantId" | "revision" | "request">;
  callBudget: number;
  mcpAdapter?: PersonalMcpAdapter;
  normalizer?: PersonalNormalizer;
}): Promise<DebugParticipantContext> {
  if (foodRequest.participantId !== userId) throw new Error("Food intent participant must match session participant");
  const identity = DebugParticipantContextSchema.pick({ partyId: true, participantId: true, intentRevision: true }).parse({
    partyId: foodRequest.partyId, participantId: userId, intentRevision: foodRequest.revision,
  });
  const budget = z.number().int().min(0).max(20).parse(callBudget);
  let signals = PersonalSignalsSchema.parse({ foodRequest: foodRequest.request, dietaryRestrictions: [], favorites: [], recentProducts: [], purchaseHistoryStatus: "unavailable" });
  await mcpAdapter(userId, async (session) => {
    const capabilities = discoverPersonalCapabilities(session.tools);
    let calls = 0;
    for (const role of ["profile", "restrictions", "favorites", "orders"] as const) {
      const tool = capabilities.get(role);
      if (!tool || calls >= budget) continue;
      calls += 1;
      try {
        const payload = boundedPayload(await session.callTool({ name: tool.name, arguments: {} }));
        if (role === "orders") {
          const products = extractOrders(payload);
          if (products) {
            signals.recentProducts = products;
            signals.purchaseHistoryStatus = "available";
          }
        } else extractFood(payload, role, signals);
      } catch {
        // Raw upstream errors may contain credentials or contacts; never retain them.
      }
    }
  });
  signals = PersonalSignalsSchema.parse(signals);
  let normalized: z.infer<typeof NormalizedPersonalSchema> | undefined;
  if (normalizer) {
    try {
      // Parse a fresh copy so an adapter cannot mutate the deterministic facts.
      const output = await normalizer({ system: PERSONAL_CONTEXT_PROMPT, signals: PersonalSignalsSchema.parse(signals) });
      const result = NormalizedPersonalSchema.safeParse(output);
      if (result.success) normalized = result.data;
    } catch { /* Deterministic context remains usable when normalization fails. */ }
  }
  const now = new Date().toISOString();
  return DebugParticipantContextSchema.parse({
    ...identity, id: crypto.randomUUID(), contextStatus: "ready",
    purchaseHistoryStatus: signals.purchaseHistoryStatus,
    dietaryRestrictions: mergeFacts(signals.dietaryRestrictions, normalized?.dietaryRestrictions ?? []),
    favorites: mergeFacts(signals.favorites, normalized?.favorites ?? []),
    recentProducts: signals.recentProducts,
    summary: normalized?.summary ?? `Харчовий запит: ${signals.foodRequest}`.slice(0, 500),
    collectedAt: now, createdAt: now, updatedAt: now,
  });
}
