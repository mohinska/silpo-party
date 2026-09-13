import "server-only";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { DraftProductSchema } from "./draft";

const id = z.string().trim().min(1).max(200);
const cartVersion = z.string().trim().min(1).max(500);
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = { productId: id, companyId: id, branchId: id };
export const CartContextSchema = z.object({ cartId: id, companyId: id, branchId: id, deliveryType: id, timeslotStart: z.iso.datetime({ offset: true }), timeslotEnd: z.iso.datetime({ offset: true }) }).strict();
export const CartLineSchema = z.object({ ...identity, quantity: z.number().int().positive(), unitPriceCents: cents, lineTotalCents: cents }).strict();
export const CartSnapshotSchema = CartContextSchema.extend({ cartVersion, lines: z.array(CartLineSchema).max(500), totalCents: cents, validationErrors: z.array(z.string()).max(100) }).superRefine((cart, ctx) => {
  if (new Set(cart.lines.map(productKey)).size !== cart.lines.length) ctx.addIssue({ code: "custom", message: "Duplicate cart line identity" });
  if (cart.lines.some(l => l.quantity * l.unitPriceCents !== l.lineTotalCents) || cart.lines.reduce((sum, l) => sum + l.lineTotalCents, 0) !== cart.totalCents) ctx.addIssue({ code: "custom", message: "Unsupported cart totals or discounts" });
});
export type CartContext = z.infer<typeof CartContextSchema>;
export type CartSnapshot = z.infer<typeof CartSnapshotSchema>;
export type CartLine = z.infer<typeof CartLineSchema>;
export const CatalogProductSchema = DraftProductSchema.extend({ attributes: z.record(z.string(), z.string()), stockPackages: z.number().int().nonnegative().nullable(), retrievedAt: z.iso.datetime({ offset: true }) });
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;
const WireProductSchema = z.object({ ...identity, name: id, packageQuantity: z.number().positive(), packageUnit: z.enum(["g", "ml", "piece"]), priceCents: cents, available: z.boolean(), stockPackages: z.number().int().nonnegative().nullable(), ingredients: z.array(z.string().min(1)), composition: z.string(), compositionComplete: z.boolean(), attributes: z.record(z.string(), z.string()) }).strict();
export function productKey(p: { productId: string; companyId: string; branchId: string }) { return JSON.stringify([p.productId, p.companyId, p.branchId]); }
export class CommerceError extends Error {
  constructor(readonly code: "contract" | "transient" | "unavailable" | "conflict" | "approval_required" | "unknown_write", message: string, readonly retryAfterMs?: number) { super(message); this.name = "CommerceError"; }
}
type RetryOptions = { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> };
export async function retryRead<T>(read: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    try { return await read(); } catch (error) {
      if (!(error instanceof CommerceError) || error.code !== "transient" || attempt === 2) throw error;
      const ms = error.retryAfterMs ?? 250 * 2 ** attempt;
      // Long server cooldowns yield the worker rather than exceeding a slice.
      if (ms > 5000) throw error;
      if (options.sleep) await options.sleep(ms); else await delay(ms, undefined, { signal: options.signal });
    }
  }
  throw new Error("Read attempts exhausted");
}
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

const empty = z.object({}).strict();
const context = CartContextSchema;
const inputSchemas = {
  silpo_get_my_shopping_cart: empty,
  silpo_get_shopping_cart_by_id: z.object({ shoppingCartId: id }).strict(),
  silpo_get_time_slots: context,
  silpo_find_products_batch: context.extend({ queries: z.array(id).min(1).max(30) }),
  silpo_get_product_details: context.extend({ productId: id }),
  silpo_get_replacements: context.extend({ productId: id }),
  silpo_add_or_update_cart_products: context.extend({ cartVersion, products: z.array(z.object({ ...identity, quantity: z.number().int().positive() }).strict()).min(1).max(30) }),
  silpo_remove_cart_products: context.extend({ cartVersion, products: z.array(z.object(identity).strict()).min(1).max(30) }),
};
const outputSchemas = {
  silpo_get_my_shopping_cart: z.object({ exists: z.boolean(), shoppingCartId: id.optional() }).strict(),
  silpo_get_shopping_cart_by_id: CartSnapshotSchema,
  silpo_get_time_slots: z.object({ slots: z.array(z.object({ start: z.string(), end: z.string(), available: z.boolean() }).strict()) }).strict(),
  silpo_find_products_batch: z.object({ products: z.array(WireProductSchema).max(300) }).strict(),
  silpo_get_product_details: WireProductSchema,
  silpo_get_replacements: z.object({ products: z.array(WireProductSchema).max(300) }).strict(),
  silpo_add_or_update_cart_products: empty,
  silpo_remove_cart_products: empty,
};
type ToolName = keyof typeof inputSchemas;
export type ListedCommerceTool = { name: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };
/** Supported DEVELOPMENT fixture; never an authenticated tools/list capture.
 * Names/context follow public docs, exact schemas must be captured and reviewed before live use. */
export const supportedContractFixture = {
  provenance: "synthetic-development-fixture-NOT-live-verified",
  version: "commerce-v2-fixture-1",
  tools: Object.entries(inputSchemas).map(([name, schema]) => ({ name, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>, outputSchema: z.toJSONSchema(outputSchemas[name as ToolName]) as Record<string, unknown> })),
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === "object") return JSON.stringify(Object.entries(value).filter(([key]) => !["description", "title", "$schema"].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return JSON.stringify(value);
}
type Call = (input: { name: string; arguments: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number }) => Promise<unknown>;
function resultData(input: unknown): unknown {
  const result = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() }).parse(input);
  if (result.isError) throw new CommerceError("unavailable", "MCP tool returned an error");
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.content?.length === 1 && result.content[0].type === "text" && result.content[0].text) {
    try { return JSON.parse(result.content[0].text); } catch { /* Explicit envelope only. */ }
  }
  throw new CommerceError("contract", "Unsupported MCP result envelope");
}
export function createMcpCommerceAdapter(tools: ListedCommerceTool[], call: Call, options: { now?: () => string; signal?: AbortSignal } = {}) {
  for (const supported of supportedContractFixture.tools) {
    const actual = tools.find(t => t.name === supported.name);
    if (!actual || canonical(actual.inputSchema) !== canonical(supported.inputSchema) || canonical(actual.outputSchema) !== canonical(supported.outputSchema)) throw new CommerceError("contract", `Unsupported MCP contract: ${supported.name}`);
  }
  const now = options.now ?? (() => new Date().toISOString());
  async function invoke<N extends ToolName>(name: N, args: unknown, write = false): Promise<z.infer<(typeof outputSchemas)[N]>> {
    const parsed = inputSchemas[name].parse(args);
    const run = async () => {
      options.signal?.throwIfAborted();
      try { return outputSchemas[name].parse(resultData(await call({ name, arguments: parsed }, { signal: options.signal, timeout: 10_000 }))) as z.output<(typeof outputSchemas)[N]>; }
      catch (error) {
        if (write) throw new CommerceError("unknown_write", "Remote write result requires reconciliation");
        if (error instanceof CommerceError || error instanceof z.ZodError) throw error;
        const failure = error as { status?: number; code?: string; headers?: Headers };
        if ([429, 502, 503, 504].includes(failure.status ?? 0) || ["ETIMEDOUT", "ECONNRESET"].includes(failure.code ?? "")) throw new CommerceError("transient", "Temporary commerce read failure", retryAfterMilliseconds(failure.headers?.get("retry-after") ?? null));
        throw new CommerceError("unavailable", "Commerce read unavailable");
      }
    };
    return write ? run() : retryRead(run, options);
  }
  const ctx = (cart: CartContext) => CartContextSchema.parse(Object.fromEntries(Object.keys(CartContextSchema.shape).map(key => [key, cart[key as keyof CartContext]])));
  function product(input: unknown, cart: CartContext, expectedId?: string): CatalogProduct {
    const p = WireProductSchema.parse(input);
    if (p.companyId !== cart.companyId || p.branchId !== cart.branchId || (expectedId && p.productId !== expectedId)) throw new CommerceError("contract", "Product evidence identity mismatch");
    return CatalogProductSchema.parse({ id: p.productId, name: p.name, companyId: p.companyId, branchId: p.branchId, packageQuantity: p.packageQuantity, packageUnit: p.packageUnit, priceCents: p.priceCents, available: p.available, attributes: p.attributes, stockPackages: p.stockPackages, retrievedAt: now(), evidence: { id: `product:${p.productId}:${p.companyId}:${p.branchId}`, source: "product_details", sourceRef: p.productId, productIdentity: { productId: p.productId, companyId: p.companyId, branchId: p.branchId }, ingredients: p.ingredients, composition: p.composition, complete: p.compositionComplete, verified: p.compositionComplete } });
  }
  return {
    async cart(): Promise<CartSnapshot> {
      const active = await invoke("silpo_get_my_shopping_cart", {});
      if (!active.exists || !active.shoppingCartId) throw new CommerceError("unavailable", "Host must prepare an active Silpo cart");
      const cart = await invoke("silpo_get_shopping_cart_by_id", { shoppingCartId: active.shoppingCartId });
      if (cart.cartId !== active.shoppingCartId) throw new CommerceError("contract", "Active cart identity mismatch");
      const slots = await invoke("silpo_get_time_slots", ctx(cart));
      if (!slots.slots.some(s => s.available && s.start === cart.timeslotStart && s.end === cart.timeslotEnd) || Date.parse(cart.timeslotEnd) <= Date.parse(now())) throw new CommerceError("unavailable", "Selected cart slot is unavailable");
      return cart;
    },
    async search(cart: CartContext, queries: string[]) {
      if (!queries.length || queries.length > 30) throw new CommerceError("contract", "Search requires 1 to 30 queries");
      const data = await invoke("silpo_find_products_batch", { ...ctx(cart), queries });
      // Search is discovery only: composition provenance requires a detail read.
      return data.products.map(p => ({ productId: p.productId, companyId: p.companyId, branchId: p.branchId, name: p.name }));
    },
    async details(cart: CartContext, productId: string) { return product(await invoke("silpo_get_product_details", { ...ctx(cart), productId }), cart, productId); },
    async substitutions(cart: CartContext, productId: string) {
      const data = await invoke("silpo_get_replacements", { ...ctx(cart), productId });
      return data.products.map(p => ({ productId: p.productId, companyId: p.companyId, branchId: p.branchId, name: p.name }));
    },
    async setQuantities(cart: CartSnapshot, lines: CartLine[]) { await invoke("silpo_add_or_update_cart_products", { ...ctx(cart), cartVersion: cart.cartVersion, products: lines.map(l => ({ productId: l.productId, companyId: l.companyId, branchId: l.branchId, quantity: l.quantity })) }, true); },
    async remove(cart: CartSnapshot, lines: CartLine[]) { await invoke("silpo_remove_cart_products", { ...ctx(cart), cartVersion: cart.cartVersion, products: lines.map(l => ({ productId: l.productId, companyId: l.companyId, branchId: l.branchId })) }, true); },
  };
}
export type CommerceAdapter = ReturnType<typeof createMcpCommerceAdapter>;
export type CommerceReadAdapter = Pick<CommerceAdapter, "cart" | "search" | "details" | "substitutions">;
