import "server-only";

import { readToolData } from "../../silpo/tool-data";
import type { SilpoVerifiedProduct } from "../../silpo/cart";

type SilpoTool = {
  name: string;
  inputSchema?: Record<string, unknown>;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
};

type CartContext = {
  cartId: string;
  branchId: string;
  companyId?: string;
  deliveryType: string;
  timeslotStart: string;
  timeslotEnd: string;
};

type SearchGroup = { query: string; products: readonly SilpoVerifiedProduct[] };

export type DebugCatalogSearchResult = { groups: readonly SearchGroup[] };

export type DebugCatalogMcpSession = {
  tools: ReadonlyMap<string, SilpoTool>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

export type DebugCatalogGateway = {
  search(queries: readonly string[]): Promise<DebugCatalogSearchResult>;
  inspect(productId: string): Promise<readonly SilpoVerifiedProduct[]>;
  close(): Promise<void>;
};

export function createHostDebugCatalogGateway(hostId: string, beforeCall?: () => void): DebugCatalogGateway {
  return createDebugCatalogGateway({
    async openSession() {
      const { openSilpoMcpSession } = await import("@/lib/silpo/mcp");
      const session = await openSilpoMcpSession(hostId);
      return { tools: session.tools, callTool: (request) => session.client.callTool(request), close: () => session.close() };
    },
    beforeCall,
  });
}

export function createDebugCatalogGateway({ openSession, beforeCall }: { openSession: () => Promise<DebugCatalogMcpSession>; beforeCall?: () => void }): DebugCatalogGateway {
  let session: DebugCatalogMcpSession | undefined;
  let context: CartContext | undefined;
  let opening: Promise<DebugCatalogMcpSession> | undefined;

  async function activeSession() {
    if (session) return session;
    opening ??= openSession().then((value) => {
      session = value;
      return value;
    });
    return opening;
  }

  async function activeContext() {
    if (context) return context;
    const current = await activeSession();
    const active = await call(current, "silpo_get_my_shopping_cart", {}, beforeCall);
    const cartId = stringValue(deepValue(active, ["shoppingCartId", "cartId"]));
    if (!cartId) throw new Error("MCP_READ:silpo_get_my_shopping_cart:MCP_OPERATION_FAILED");
    const details = await call(current, "silpo_get_shopping_cart_by_id", { shoppingCartId: cartId }, beforeCall);
    const branchId = stringValue(deepValue(details, ["branchId"]));
    const companyId = stringValue(deepValue(details, ["companyId"]));
    const deliveryType = stringValue(deepValue(details, ["deliveryType"]));
    const timeslotStart = stringValue(deepValue(details, ["timeslotStart"])) ?? stringValue(deepValue(deepValue(details, ["timeslot"]), ["start"]));
    const timeslotEnd = stringValue(deepValue(details, ["timeslotEnd"])) ?? stringValue(deepValue(deepValue(details, ["timeslot"]), ["end"]));
    if (!branchId || !deliveryType || !timeslotStart || !timeslotEnd) {
      throw new Error("MCP_READ:silpo_get_shopping_cart_by_id:MCP_OPERATION_FAILED");
    }
    const resolved: CartContext = { cartId, branchId, companyId, deliveryType, timeslotStart, timeslotEnd };
    await call(current, "silpo_get_time_slots", { branchId }, beforeCall);
    context = resolved;
    return resolved;
  }

  return {
    async search(queries) {
      const compact = compactQueries(queries);
      const current = await activeSession();
      const currentContext = await activeContext();
      const data = await call(current, "silpo_find_products_batch", {
        branchId: currentContext.branchId,
        deliveryType: currentContext.deliveryType,
        timeslotStart: currentContext.timeslotStart,
        timeslotEnd: currentContext.timeslotEnd,
        products: compact,
      }, beforeCall);
      const groups = queryGroups(data, currentContext);
      return { groups: compact.map((query) => ({ query, products: groups.get(searchKey(query)) ?? [] })) };
    },
    async inspect(productId) {
      const id = productId.trim();
      if (!id || id.length > 200) throw new Error("Invalid product ID.");
      const current = await activeSession();
      const currentContext = await activeContext();
      const detail = [...current.tools.keys()].find((name) => /product.*(?:detail|by_?id)|get_product$/i.test(name));
      if (!detail) throw new Error("MCP_READ:silpo_product_detail:MCP_404");
      const data = await call(current, detail, buildProductArguments(current.tools.get(detail), currentContext, id), beforeCall);
      return products(data, currentContext).filter((entry) => entry.productId === id);
    },
    async close() {
      const current = session ?? (opening ? await opening : undefined);
      session = undefined;
      opening = undefined;
      context = undefined;
      await current?.close();
    },
  };
}

function compactQueries(queries: readonly string[]) {
  const compact = queries.map((query) => query.trim()).filter(Boolean);
  if (compact.length < 1 || compact.length > 3 || compact.some((query) => query.length > 100)) throw new Error("Invalid catalog queries.");
  const keys = new Set(compact.map(searchKey));
  if (keys.size !== compact.length) throw new Error("Catalog queries must be distinct.");
  return compact;
}

async function call(session: DebugCatalogMcpSession, name: string, argumentsValue: Record<string, unknown>, beforeCall?: () => void) {
  if (!session.tools.has(name)) throw new Error(`MCP_READ:${name}:MCP_404`);
  try {
    beforeCall?.();
    const result = await session.callTool({ name, arguments: argumentsValue });
    if (isErrorResult(result)) throw new Error("MCP returned an error result.");
    return bounded(readToolData(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("MCP_READ:")) throw error;
    throw new Error(`MCP_READ:${name}:${errorCode(message)}`);
  }
}

function buildProductArguments(tool: SilpoTool | undefined, context: CartContext, productId: string) {
  const properties = (tool?.inputSchema as JsonSchema | undefined)?.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const normalized = normalize(key);
    if (normalized === "productid" || normalized === "id") result[key] = productId;
    else if (normalized === "branchid") result[key] = context.branchId;
    else if (normalized === "companyid" && context.companyId) result[key] = context.companyId;
    else if (normalized === "deliverytype") result[key] = context.deliveryType;
    else if (normalized === "timeslotstart") result[key] = context.timeslotStart;
    else if (normalized === "timeslotend") result[key] = context.timeslotEnd;
  }
  const required = (tool?.inputSchema as JsonSchema | undefined)?.required ?? [];
  if (required.some((key) => result[key] === undefined)) throw new Error(`MCP_READ:${tool?.name ?? "silpo_product_detail"}:MCP_OPERATION_FAILED`);
  return result;
}

function queryGroups(data: unknown, context: CartContext) {
  const record = object(data);
  const entries = record && direct(record, ["queries"]);
  if (!Array.isArray(entries)) return new Map<string, readonly SilpoVerifiedProduct[]>();
  return new Map(entries.flatMap((entry): Array<[string, readonly SilpoVerifiedProduct[]]> => {
    const group = object(entry);
    const query = group && stringValue(direct(group, ["query", "search", "searchText"]));
    return query ? [[searchKey(query), products(direct(group, ["products", "items", "results"]), context)]] : [];
  }));
}

function products(value: unknown, context: CartContext): readonly SilpoVerifiedProduct[] {
  const found: SilpoVerifiedProduct[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<string>();
  while (queue.length && found.length < 12) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current.slice(0, 100));
      continue;
    }
    const record = object(current);
    if (!record) continue;
    const productId = stringValue(direct(record, ["productId", "id"]));
    const name = stringValue(direct(record, ["name", "title", "productName"]));
    const branchId = stringValue(direct(record, ["branchId"])) ?? context.branchId;
    const companyId = stringValue(direct(record, ["companyId"])) ?? context.companyId;
    const unit = stringValue(direct(record, ["displayRatio", "unit"]));
    const price = numberValue(direct(record, ["priceCents", "priceInCents"])) ?? currencyCents(direct(record, ["currentPrice", "salePrice", "price", "priceValue"]));
    const available = availability(record);
    if (productId && name && branchId && companyId && unit && price !== undefined && available !== undefined && !seen.has(productId)) {
      seen.add(productId);
      const old = numberValue(direct(record, ["oldPriceCents", "regularPriceCents", "originalPriceCents"])) ?? currencyCents(direct(record, ["oldPrice", "regularPrice", "originalPrice"]));
      const discount = old !== undefined && old > price ? old - price : null;
      found.push({ productId, companyId, branchId, name: name.slice(0, 500), unit: unit.slice(0, 500), unitPriceCents: price, discountCents: discount, imageUrl: null, available });
    }
    queue.push(...Object.values(record).filter((entry) => typeof entry === "object" && entry !== null));
  }
  return found;
}

function bounded(value: unknown, depth = 0, state = { nodes: 0 }): unknown {
  if (depth > 8 || ++state.nodes > 2_000) return null;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => bounded(entry, depth + 1, state));
  const record = object(value);
  return record ? Object.fromEntries(Object.entries(record).slice(0, 60).map(([key, entry]) => [key, bounded(entry, depth + 1, state)])) : value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function direct(record: Record<string, unknown>, names: readonly string[]) {
  const wanted = new Set(names.map(normalize));
  return Object.entries(record).find(([key, value]) => wanted.has(normalize(key)) && value !== null && value !== undefined)?.[1];
}

function deepValue(value: unknown, names: readonly string[]): unknown {
  const wanted = new Set(names.map(normalize));
  const queue: unknown[] = [value];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = object(current);
    if (!record) continue;
    for (const [key, entry] of Object.entries(record)) {
      if (wanted.has(normalize(key)) && entry !== null && entry !== undefined) return entry;
      if (typeof entry === "object" && entry !== null) queue.push(entry);
    }
  }
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function currencyCents(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

function availability(record: Record<string, unknown>) {
  const value = deepValue(record, ["available", "isAvailable", "inStock"]);
  if (typeof value === "boolean") return value;
  const stock = numberValue(deepValue(record, ["stockQuantity", "availableQuantity"]));
  return stock === undefined ? undefined : stock > 0;
}

function searchKey(value: string) {
  return value.toLocaleLowerCase("uk-UA").match(/[\p{L}\p{N}]+/gu)?.join("") ?? value.toLocaleLowerCase("uk-UA");
}

function isErrorResult(value: unknown) {
  return Boolean(value && typeof value === "object" && "isError" in value && value.isError === true);
}

function errorCode(message: string) {
  const match = message.match(/(?:^|\D)(401|403|404|408|409|422|429|500|502|503|504|-32601)(?:\D|$)/);
  return match ? `MCP_${match[1]}` : "MCP_OPERATION_FAILED";
}
