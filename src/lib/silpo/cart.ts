import "server-only";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createAdminClient } from "@/lib/supabase/admin";
import { readToolData, type SilpoTool, withSilpoMcp } from "@/lib/silpo/mcp";
import type { CatalogProduct, MergedIngredient, ProductLine, Unit } from "@/lib/ai/planning/proposal-schemas";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
};

export type CartContext = {
  cartId: string;
  branchId?: string;
  companyId?: string;
  deliveryType?: string;
  timeslotStart?: string;
  timeslotEnd?: string;
  checkoutUrl?: string;
};

export type SilpoProductOption = {
  productId: string;
  companyId: string;
  branchId: string;
  name: string;
  priceCents?: number;
  displayRatio?: string;
  imageUrl?: string;
};

export type SilpoVerifiedProduct = {
  productId: string;
  companyId: string;
  branchId: string;
  name: string;
  unit: string;
  unitPriceCents: number;
  discountCents: number | null;
  imageUrl: string | null;
  available: boolean;
};

export type SilpoCatalogReader = {
  search(query: string): Promise<SilpoVerifiedProduct[]>;
  inspect(productId: string): Promise<SilpoVerifiedProduct[]>;
};

export type HostCatalogAdapter = <T>(hostId: string, operation: (reader: SilpoCatalogReader) => Promise<T>) => Promise<T>;

type ManagedItem = {
  id: string;
  name: string;
  quantity: number | string;
  unit: string;
  unit_price_cents: number;
  silpo_product_id: string | null;
  silpo_company_id: string | null;
  silpo_branch_id: string | null;
};

type ResolvedProduct = {
  productId: string;
  companyId?: string;
  branchId?: string;
  name: string;
  priceCents?: number;
  slug?: string;
  imageUrl?: string;
  displayRatio?: string;
  packageQuantity?: number;
  packageUnit?: Unit;
  evidence?: unknown;
};

type ToolMode = "cart" | "timeslots" | "find" | "add" | "remove" | "product";

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function directValue(record: Record<string, unknown>, names: string[]) {
  const wanted = new Set(names.map(normalized));
  return Object.entries(record).find(([key, value]) => wanted.has(normalized(key)) && value !== null && value !== undefined)?.[1];
}

function deepValue(value: unknown, names: string[]): unknown {
  const wanted = new Set(names.map(normalized));
  const queue: unknown[] = [value];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = objectValue(current);
    if (!record) continue;
    for (const [key, nested] of Object.entries(record)) {
      if (wanted.has(normalized(key)) && nested !== null && nested !== undefined) return nested;
      if (typeof nested === "object" && nested !== null) queue.push(nested);
    }
  }
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildNestedObject(
  schema: JsonSchema | undefined,
  values: { query?: string; quantity?: number; product?: ResolvedProduct },
) {
  const properties = schema?.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [key] of Object.entries(properties)) {
    const name = normalized(key);
    if (["query", "search", "searchtext", "searchterm", "text", "name", "productname"].includes(name) && values.query) result[key] = values.query;
    else if (["quantity", "count", "amount"].includes(name) && values.quantity !== undefined) result[key] = values.quantity;
    else if (["productid", "id"].includes(name) && values.product) result[key] = values.product.productId;
    else if (name === "companyid" && values.product?.companyId) result[key] = values.product.companyId;
    else if (name === "branchid" && values.product?.branchId) result[key] = values.product.branchId;
  }
  return result;
}

function buildArguments(
  tool: SilpoTool,
  mode: ToolMode,
  context: Partial<CartContext>,
  options: { queries?: Array<{ name: string; quantity: number }>; products?: Array<ResolvedProduct & { quantity: number }> } = {},
) {
  const schema = (tool.inputSchema ?? {}) as JsonSchema;
  const properties = schema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    const name = normalized(key);
    if (["shoppingcartid", "cartid"].includes(name) || (name === "id" && mode === "cart")) result[key] = context.cartId;
    else if (name === "branchid" && context.branchId) result[key] = context.branchId;
    else if (name === "companyid" && context.companyId) result[key] = context.companyId;
    else if (name === "deliverytype" && context.deliveryType) result[key] = context.deliveryType;
    else if (name === "timeslotstart" && context.timeslotStart) result[key] = context.timeslotStart;
    else if (name === "timeslotend" && context.timeslotEnd) result[key] = context.timeslotEnd;
    else if (["items", "queries", "searches", "products"].includes(name) && mode === "find") {
      const queries = options.queries ?? [];
      result[key] = property.items?.type === "string"
        ? queries.map((entry) => entry.name)
        : queries.map((entry) => buildNestedObject(property.items, { query: entry.name, quantity: entry.quantity }));
    } else if (["products", "items", "cartproducts"].includes(name) && ["add", "remove"].includes(mode)) {
      const products = options.products ?? [];
      result[key] = property.items?.type === "string"
        ? products.map((entry) => entry.productId)
        : products.map((entry) => buildNestedObject(property.items, { product: entry, quantity: entry.quantity }));
    } else if (["productids", "ids"].includes(name) && mode === "remove") {
      result[key] = (options.products ?? []).map((entry) => entry.productId);
    } else if ((name === "productid" || (name === "id" && mode === "product")) && options.products?.[0]) result[key] = options.products[0].productId;
    else if (["quantity", "count", "amount"].includes(name) && options.products?.[0]) result[key] = options.products[0].quantity;
  }

  const missing = (schema.required ?? []).filter((key) => result[key] === undefined);
  if (missing.length) {
    throw new Error(`Silpo tool ${tool.name} requires unsupported fields: ${missing.join(", ")}.`);
  }
  return result;
}

async function callTool(
  client: Pick<Client, "callTool">,
  tools: Map<string, SilpoTool>,
  name: string,
  mode: ToolMode,
  context: Partial<CartContext> = {},
  options?: { queries?: Array<{ name: string; quantity: number }>; products?: Array<ResolvedProduct & { quantity: number }> },
) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Silpo MCP tool ${name} is unavailable.`);
  const result = await client.callTool({ name, arguments: buildArguments(tool, mode, context, options) });
  if ((result as { isError?: boolean }).isError) {
    throw new Error(`Silpo MCP ${name}: ${JSON.stringify(readToolData(result))}`);
  }
  return readToolData(result);
}

async function getCartContext(client: Pick<Client, "callTool">, tools: Map<string, SilpoTool>): Promise<CartContext> {
  const active = await callTool(client, tools, "silpo_get_my_shopping_cart", "cart");
  const cartId = stringValue(deepValue(active, ["shoppingCartId", "cartId"]));
  if (!cartId) {
    throw new Error("У Host немає активного кошика «Сільпо». Створіть кошик і виберіть доставку в застосунку або на silpo.ua.");
  }
  const details = await callTool(client, tools, "silpo_get_shopping_cart_by_id", "cart", { cartId });
  const timeslot = deepValue(details, ["timeslot"]);
  const context: CartContext = {
    cartId,
    branchId: stringValue(deepValue(details, ["branchId"])),
    companyId: stringValue(deepValue(details, ["companyId"])),
    deliveryType: stringValue(deepValue(details, ["deliveryType"])),
    timeslotStart: stringValue(deepValue(details, ["timeslotStart"])) ?? stringValue(deepValue(timeslot, ["start"])),
    timeslotEnd: stringValue(deepValue(details, ["timeslotEnd"])) ?? stringValue(deepValue(timeslot, ["end"])),
    checkoutUrl: stringValue(deepValue(details, ["checkoutWebLink", "checkoutUrl", "checkoutMobileLink"])),
  };
  if (!context.branchId) throw new Error("У кошику Host не вибрано магазин або спосіб доставки.");
  if (!context.deliveryType || !context.timeslotStart || !context.timeslotEnd) {
    throw new Error("У кошику Host не вибрано дійсний слот доставки або самовивозу.");
  }
  if (!tools.has("silpo_get_time_slots")) {
    throw new Error("Silpo MCP не підтримує обов’язкову перевірку слота доставки.");
  }
  // This MCP tool is the authoritative slot validator. `callTool` propagates a
  // validation error and prevents every later search or cart-mutation step.
  await callTool(client, tools, "silpo_get_time_slots", "timeslots", context);
  return context;
}

function productCandidates(value: unknown, context: CartContext): ResolvedProduct[] {
  const candidates: ResolvedProduct[] = [];
  const queue: unknown[] = [value];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = objectValue(current);
    if (!record) continue;
    // Product search results currently use `id`; cart payloads may use `productId`.
    // Read these fields only from the product object itself so a wrapper ID is not
    // accidentally paired with a nested product name.
    const productId = stringValue(directValue(record, ["productId", "id"]));
    const title = stringValue(directValue(record, ["name", "title", "productName"]));
    if (productId && title) {
      const explicitCents = numberValue(directValue(record, ["priceCents", "priceInCents"]));
      const currencyPrice = numberValue(directValue(record, ["currentPrice", "salePrice", "price", "priceValue"]));
      const packaging = packageData(record);
      candidates.push({
        productId,
        companyId: stringValue(directValue(record, ["companyId"])) ?? context.companyId,
        branchId: stringValue(directValue(record, ["branchId"])) ?? context.branchId,
        name: title,
        priceCents: explicitCents === undefined ? currencyPrice === undefined ? undefined : Math.round(currencyPrice * 100) : Math.round(explicitCents),
        slug: stringValue(directValue(record, ["slug"])),
        imageUrl: stringValue(directValue(record, ["imageUrl", "image", "photoUrl"])),
        displayRatio: stringValue(directValue(record, ["displayRatio", "unit"])),
        packageQuantity: packaging?.quantity,
        packageUnit: packaging?.unit,
        evidence: record,
      });
    }
    queue.push(...Object.values(record).filter((nested) => typeof nested === "object" && nested !== null));
  }
  return [...new Map(candidates.map((candidate) => [candidate.productId, candidate])).values()];
}

function searchKey(value: string) {
  return value.toLocaleLowerCase("uk-UA").match(/[\p{L}\p{N}]+/gu)?.join("") ?? value.toLocaleLowerCase("uk-UA");
}

function queryGroups(value: unknown, context: CartContext) {
  const record = objectValue(value);
  const groups = record ? directValue(record, ["queries"]) : undefined;
  if (!Array.isArray(groups)) return new Map<string, ResolvedProduct[]>();
  return new Map(groups.flatMap((entry): Array<[string, ResolvedProduct[]]> => {
    const group = objectValue(entry);
    const query = group && stringValue(directValue(group, ["query", "search", "searchText"]));
    return query ? [[searchKey(query), productCandidates(directValue(group, ["products", "items", "results"]), context)]] : [];
  }));
}

/** Returns MCP-ranked, store-specific products for a user to explicitly choose. */
export async function findSilpoProducts(hostId: string, query: string): Promise<SilpoProductOption[]> {
  return withSilpoMcp(hostId, async (client, tools) => {
    const context = await getCartContext(client, tools);
    const data = await callTool(client, tools, "silpo_find_products_batch", "find", context, {
      queries: [{ name: query, quantity: 1 }],
    });
    const candidates = queryGroups(data, context).get(searchKey(query)) ?? productCandidates(data, context);
    return candidates
      // Search results must explicitly confirm stock in the Host's selected
      // Silpo branch; unknown or unavailable products are not selectable.
      .filter((candidate) => candidate.companyId && candidate.branchId && availabilityFromProduct(candidate.evidence) === true)
      .slice(0, 12)
      .map((candidate) => ({
        productId: candidate.productId,
        companyId: candidate.companyId!,
        branchId: candidate.branchId!,
        name: candidate.name,
        priceCents: candidate.priceCents,
        displayRatio: candidate.displayRatio,
        imageUrl: candidate.imageUrl,
      }));
  });
}

/** Bound untrusted MCP trees before reusing the legacy product/context parsers. */
function boundedCatalogData(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 8 || ++budget.nodes > 2000) return null;
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundedCatalogData(entry, depth + 1, budget));
  const record = objectValue(value);
  if (record) return Object.fromEntries(Object.entries(record).slice(0, 60).map(([key, entry]) => [key, boundedCatalogData(entry, depth + 1, budget)]));
  return value;
}

function verifiedCatalogProducts(data: unknown, context: CartContext): SilpoVerifiedProduct[] {
  return productCandidates(boundedCatalogData(data), context).slice(0, 12).flatMap((entry) => {
    const record = objectValue(entry.evidence);
    const available = record ? availabilityFromProduct(record) : undefined;
    const unit = entry.displayRatio ?? entry.packageUnit;
    if (!record || !entry.companyId || !entry.branchId || !unit || available === undefined ||
      entry.priceCents === undefined || !Number.isSafeInteger(entry.priceCents) || entry.priceCents < 0 ||
      entry.companyId !== context.companyId || entry.branchId !== context.branchId) return [];
    const explicitDiscount = numberValue(directValue(record, ["discountCents"]));
    const oldCents = numberValue(directValue(record, ["oldPriceCents", "regularPriceCents", "originalPriceCents"]));
    const oldPrice = numberValue(directValue(record, ["oldPrice", "regularPrice", "originalPrice"]));
    const previous = oldCents ?? (oldPrice === undefined ? undefined : Math.round(oldPrice * 100));
    const discount = explicitDiscount ?? (previous !== undefined && previous > entry.priceCents ? previous - entry.priceCents : null);
    const imageUrl = entry.imageUrl && URL.canParse(entry.imageUrl) ? entry.imageUrl : null;
    if ([entry.productId, entry.companyId, entry.branchId].some((id) => id.length > 200)) return [];
    return [{ productId: entry.productId, companyId: entry.companyId, branchId: entry.branchId,
      name: entry.name.slice(0, 500), unit: unit.slice(0, 500), unitPriceCents: entry.priceCents,
      discountCents: discount !== null && Number.isSafeInteger(discount) && discount > 0 ? discount : null,
      imageUrl, available }];
  });
}

/** Host-scoped read operations only; legacy cart write exports remain separate. */
export const withSilpoCatalogReader: HostCatalogAdapter = async (hostId, operation) => withSilpoMcp(hostId, async (client, advertised) => {
  const tools = new Map([...advertised].slice(0, 200).filter(([, tool]) => {
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) return false;
    if (/(?:^|_)(add|remove|delete|update|set|create|checkout|submit|cancel|write)(?:_|$)/i.test(tool.name)) return false;
    if (!/(?:^|_)(get|find|search|list|read|fetch)(?:_|$)/i.test(tool.name) && tool.annotations?.readOnlyHint !== true) return false;
    const schema = tool.inputSchema;
    if (!schema || schema.type !== "object") return false;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string"))) return false;
    if (schema.properties !== undefined && !objectValue(schema.properties)) return false;
    return !["allOf", "anyOf", "oneOf", "$ref", "not", "if"].some((key) => key in schema);
  }));
  // Keep oversized responses and upstream error bodies outside both agent output and logs.
  const readClient = {
    callTool: async (...args: Parameters<Client["callTool"]>) => {
      try {
        const result = await client.callTool(...args);
        if (result.isError) throw new Error("MCP read failed");
        const envelope = objectValue(result);
        const text = envelope?.content;
        if (Array.isArray(text) && text.some((entry) => typeof entry.text === "string" && entry.text.length > 100_000)) throw new Error("MCP response too large");
        return { structuredContent: boundedCatalogData(readToolData(result)) };
      } catch {
        throw new Error("Silpo catalog read failed.");
      }
    },
  } as Pick<Client, "callTool">;
  const context = await getCartContext(readClient, tools);
  if (!context.companyId) throw new Error("Host store company is unavailable.");
  let reads = 0;
  const read = async (name: string, mode: "find" | "product", options: Parameters<typeof callTool>[5]) => {
    if (++reads > 8) throw new Error("Silpo catalog read budget exhausted.");
    return callTool(readClient, tools, name, mode, context, options);
  };
  return operation({
    async search(query) {
      if (!query.trim() || query.length > 200) throw new Error("Invalid catalog query.");
      const data = await read("silpo_find_products_batch", "find", { queries: [{ name: query, quantity: 1 }] });
      return verifiedCatalogProducts(data, context);
    },
    async inspect(productId) {
      if (!productId.trim() || productId.length > 200) throw new Error("Invalid product ID.");
      const detail = [...tools.keys()].find((name) => /product.*(?:detail|by_?id)|get_product$/i.test(name));
      if (!detail) throw new Error("Silpo product detail capability is unavailable.");
      const options = { products: [{ productId, name: "", companyId: context.companyId, branchId: context.branchId, quantity: 1 }] };
      const data = await read(detail, "product", options);
      const products = productCandidates(data, context).filter((entry) => entry.productId === productId);
      // Price/promotion reads may enrich the same identified product; they cannot supply a different ID.
      for (const name of [...tools.keys()].filter((name) => name !== detail && /product.*(?:price|promotion|availability)/i.test(name)).slice(0, 3)) {
        const update = productCandidates(await read(name, "product", options), context).find((entry) => entry.productId === productId);
        if (update) for (const entry of products) entry.evidence = { ...objectValue(entry.evidence), ...objectValue(update.evidence) };
      }
      return verifiedCatalogProducts(products.map((entry) => entry.evidence), context);
    },
  });
});

function cartUnitPrice(cart: unknown, productId: string, quantity: number) {
  const queue: unknown[] = [cart];
  while (queue.length) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = objectValue(current);
    if (!record) continue;
    const directProductId = Object.entries(record).find(([key]) => normalized(key) === "productid")?.[1];
    if (String(directProductId ?? "") === productId) {
      const unit = numberValue(deepValue(record, ["unitPrice", "currentPrice", "salePrice", "priceValue"]));
      if (unit !== undefined) return Math.round(unit > 10_000 ? unit : unit * 100);
      const total = numberValue(deepValue(record, ["totalPrice", "lineTotal", "sum"]));
      if (total !== undefined && quantity > 0) {
        const unitTotal = total / quantity;
        return Math.round(unitTotal > 10_000 ? unitTotal : unitTotal * 100);
      }
    }
    queue.push(...Object.values(record).filter((nested) => typeof nested === "object" && nested !== null));
  }
  return undefined;
}

async function resolveProducts(client: Client, tools: Map<string, SilpoTool>, context: CartContext, items: ManagedItem[]) {
  const products = new Map<string, ResolvedProduct>();
  const errors = new Map<string, string>();
  if (!items.length) return { products, errors };
  const queries = items.map((item) => ({ name: item.name, quantity: Number(item.quantity) }));
  const data = await callTool(client, tools, "silpo_find_products_batch", "find", context, {
    queries,
  });
  const grouped = queryGroups(data, context);
  items.forEach((item, index) => {
    const query = queries[index].name;
    // A batch result must identify which products belong to which query. Do not
    // fall back to another query's products and risk adding the wrong item.
    const candidates = grouped.get(searchKey(query)) ?? (items.length === 1 ? productCandidates(data, context) : []);
    // Silpo MCP owns search relevance. Its first result is used unchanged rather
    // than re-ranking it locally with title heuristics.
    const product = candidates[0];
    if (!product) {
      errors.set(item.id, `«Сільпо» не знайшло товар за запитом «${item.name}». Спробуйте точнішу назву з каталогу.`);
    } else if (!product.companyId) {
      errors.set(item.id, `Для товару «${product.name}» MCP не повернув companyId.`);
    } else {
      products.set(item.id, product);
    }
  });
  return { products, errors };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1000) : "Невідома помилка синхронізації «Сільпо».";
}

function packageData(value: unknown): { quantity: number; unit: Unit } | undefined {
  const rawQuantity = numberValue(deepValue(value, ["packageQuantity", "netWeight", "weight", "volume"]));
  const rawUnit = stringValue(deepValue(value, ["packageUnit", "weightUnit", "unitOfMeasure", "unit"]));
  const ratio = stringValue(deepValue(value, ["displayRatio", "packageSize"]));
  const ratioMatch = ratio?.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|г|g|мл|ml|л|l|шт|pcs?)/iu);
  const quantity = rawQuantity ?? (ratioMatch ? Number(ratioMatch[1].replace(",", ".")) : undefined);
  const token = (rawUnit ?? ratioMatch?.[2] ?? "").toLocaleLowerCase("uk-UA").replace(/[.\s]/g, "");
  if (!quantity || !token) return undefined;
  if (["kg", "kilogram", "kilograms", "кг"].includes(token)) return { quantity: quantity * 1000, unit: "g" };
  if (["g", "gram", "grams", "г"].includes(token)) return { quantity, unit: "g" };
  if (["l", "liter", "liters", "л"].includes(token)) return { quantity: quantity * 1000, unit: "ml" };
  if (["ml", "milliliter", "milliliters", "мл"].includes(token)) return { quantity, unit: "ml" };
  if (["piece", "pieces", "pcs", "pc", "шт"].includes(token)) return { quantity, unit: "piece" };
  return undefined;
}

function availabilityFromProduct(value: unknown) {
  const explicit = deepValue(value, ["available", "isAvailable", "inStock"]);
  if (typeof explicit === "boolean") return explicit;
  const stock = numberValue(deepValue(value, ["stockQuantity", "availableQuantity"]));
  return stock === undefined ? undefined : stock > 0;
}

function safetyFromProduct(value: unknown, requirement: MergedIngredient) {
  if (requirement.variant === "standard" && !requirement.readyMeal) return "safe" as const;
  const serialized = JSON.stringify(value).toLocaleLowerCase("uk-UA");
  const wanted = requirement.variant.toLocaleLowerCase("uk-UA");
  return wanted !== "standard" && serialized.includes(wanted) ? "safe" as const : "uncertain" as const;
}

/** Read-only catalog resolution in the Host's active cart/store context. */
export async function resolveSilpoProposalProducts(hostId: string, requirements: MergedIngredient[]) {
  return withSilpoMcp(hostId, async (client, tools) => {
    const context = await getCartContext(client, tools);
    const queries = requirements.map((item) => ({ name: `${item.name}${item.variant === "standard" ? "" : ` ${item.variant}`}`, quantity: item.quantity }));
    const data = await callTool(client, tools, "silpo_find_products_batch", "find", context, { queries });
    const grouped = queryGroups(data, context);
    const all = productCandidates(data, context);
    const detailTool = [...tools.keys()].find((name) => /silpo.*product.*(detail|by.?id)/i.test(name));
    const entries: Array<readonly [string, CatalogProduct[]]> = [];
    for (const [index, requirement] of requirements.entries()) {
      const candidates = (grouped.get(searchKey(queries[index].name)) ?? all)
        .slice(0, 8);
      const sanitized: CatalogProduct[] = [];
      for (const candidate of candidates) {
        let evidence = candidate.evidence;
        let safety = safetyFromProduct(evidence, requirement);
        if (safety === "uncertain" && detailTool) {
          evidence = await callTool(client, tools, detailTool, "product", context, { products: [{ ...candidate, quantity: 1 }] });
          safety = safetyFromProduct(evidence, requirement);
        }
        const available = availabilityFromProduct(evidence);
        const packaging = packageData(evidence) ?? (candidate.packageQuantity && candidate.packageUnit ? { quantity: candidate.packageQuantity, unit: candidate.packageUnit } : undefined);
        const readyMeal = /готов.{0,12}(страв|їж)|кулінар/iu.test(JSON.stringify(evidence));
        if (!candidate.companyId || !candidate.branchId || candidate.priceCents === undefined || !packaging || available === undefined) continue;
        sanitized.push({ productId: candidate.productId, companyId: candidate.companyId, branchId: candidate.branchId, name: candidate.name, packageQuantity: packaging.quantity, packageUnit: packaging.unit, priceCents: candidate.priceCents, available, dietarySafety: safety, readyMeal, productUrl: candidate.slug ? `https://silpo.ua/product/${candidate.slug}` : undefined, imageUrl: candidate.imageUrl });
      }
      entries.push([requirement.key, sanitized] as const);
    }
    return new Map(entries);
  });
}

type StoredCartLine = { silpo_product_id?: string | null; silpo_company_id?: string | null; silpo_branch_id?: string | null; quantity?: number | string; name?: string };

export async function writeSilpoProposalLines(hostId: string, lines: ProductLine[], manualLines: StoredCartLine[] = [], previousAiLines: StoredCartLine[] = []) {
  return withSilpoMcp(hostId, async (client, tools) => {
    const context = await getCartContext(client, tools);
    if (lines.length) await callTool(client, tools, "silpo_add_or_update_cart_products", "add", context, {
      products: lines.map((line) => ({ productId: line.productId, companyId: line.companyId, branchId: line.branchId, name: line.name, quantity: line.packageCount + manualLines.filter((item) => item.silpo_product_id === line.productId && (item.silpo_company_id ?? line.companyId) === line.companyId && (item.silpo_branch_id ?? line.branchId) === line.branchId).reduce((sum, item) => sum + Number(item.quantity ?? 0), 0) })),
    });
    const desired = new Set(lines.map((line) => `${line.productId}|${line.companyId}|${line.branchId}`));
    const stale = new Map<string, ResolvedProduct & { quantity: number }>();
    for (const old of previousAiLines) {
      if (!old.silpo_product_id) continue;
      const companyId = old.silpo_company_id ?? context.companyId;
      const branchId = old.silpo_branch_id ?? context.branchId;
      const key = `${old.silpo_product_id}|${companyId ?? ""}|${branchId ?? ""}`;
      if (desired.has(key)) continue;
      const manualQuantity = manualLines.filter((item) => item.silpo_product_id === old.silpo_product_id && (item.silpo_company_id ?? companyId) === companyId && (item.silpo_branch_id ?? branchId) === branchId).reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
      stale.set(key, { productId: old.silpo_product_id, companyId, branchId, name: old.name ?? old.silpo_product_id, quantity: manualQuantity });
    }
    const retained = [...stale.values()].filter(({ quantity }) => quantity > 0);
    const removed = [...stale.values()].filter(({ quantity }) => quantity === 0);
    if (retained.length) await callTool(client, tools, "silpo_add_or_update_cart_products", "add", context, { products: retained });
    if (removed.length) await callTool(client, tools, "silpo_remove_cart_products", "remove", context, { products: removed });
    return context;
  });
}

export async function readSilpoCartSnapshot(hostId: string) {
  return withSilpoMcp(hostId, async (client, tools) => {
    const context = await getCartContext(client, tools);
    const cart = await callTool(client, tools, "silpo_get_shopping_cart_by_id", "cart", context);
    const lines: Array<{ productId: string; companyId: string; branchId: string; quantity: number }> = [];
    const queue: unknown[] = [cart];
    while (queue.length) {
      const current = queue.shift();
      if (Array.isArray(current)) { queue.push(...current); continue; }
      const record = objectValue(current);
      if (!record) continue;
      const productId = stringValue(directValue(record, ["productId"]));
      const quantity = numberValue(directValue(record, ["quantity", "count", "amount"]));
      if (productId && quantity !== undefined) lines.push({ productId, companyId: stringValue(directValue(record, ["companyId"])) ?? context.companyId ?? "", branchId: stringValue(directValue(record, ["branchId"])) ?? context.branchId ?? "", quantity });
      queue.push(...Object.values(record).filter((value) => value && typeof value === "object"));
    }
    return { context, lines };
  });
}

export async function syncPartyBasketToSilpo(partyId: string, hostId: string) {
  const admin = createAdminClient();
  await admin.from("parties").update({ silpo_sync_status: "pending", silpo_sync_error: null }).eq("id", partyId);
  const { data, error } = await admin
    .from("basket_items")
    .select("id, name, quantity, unit, unit_price_cents, silpo_product_id, silpo_company_id, silpo_branch_id")
    .eq("party_id", partyId)
    .order("created_at");
  if (error) throw error;
  const items = (data ?? []) as ManagedItem[];

  try {
    const result = await withSilpoMcp(hostId, async (client, tools) => {
      const context = await getCartContext(client, tools);
      const resolution = await resolveProducts(client, tools, context, items.filter((item) => !item.silpo_product_id));
      const resolved = items.flatMap((item) => {
        if (item.silpo_product_id) {
          return [{
            ...item,
            product: {
              productId: item.silpo_product_id,
              companyId: item.silpo_company_id ?? context.companyId,
              branchId: item.silpo_branch_id ?? context.branchId,
              name: item.name,
            } satisfies ResolvedProduct,
          }];
        }
        const product = resolution.products.get(item.id);
        return product ? [{ ...item, product }] : [];
      });

      const grouped = new Map<string, ResolvedProduct & { quantity: number }>();
      for (const item of resolved) {
        const key = `${item.product.productId}:${item.product.companyId ?? ""}:${item.product.branchId ?? ""}`;
        const existing = grouped.get(key);
        grouped.set(key, { ...item.product, quantity: (existing?.quantity ?? 0) + Number(item.quantity) });
      }
      if (grouped.size) {
        await callTool(client, tools, "silpo_add_or_update_cart_products", "add", context, { products: [...grouped.values()] });
      }
      const cart = await callTool(client, tools, "silpo_get_shopping_cart_by_id", "cart", context);
      const checkoutUrl = stringValue(deepValue(cart, ["checkoutWebLink", "checkoutUrl", "checkoutMobileLink"])) ?? context.checkoutUrl;
      const withCartPrices = resolved.map((item) => ({
        ...item,
        product: {
          ...item.product,
          priceCents: cartUnitPrice(cart, item.product.productId, Number(item.quantity)) ?? item.product.priceCents,
        },
      }));
      return { context, resolved: withCartPrices, checkoutUrl, errors: resolution.errors };
    });

    await Promise.all([
      ...result.resolved.map((item) => admin.from("basket_items").update({
      name: item.product.name,
      unit: item.product.displayRatio ?? item.unit,
      unit_price_cents: item.product.priceCents ?? item.unit_price_cents,
      silpo_product_id: item.product.productId,
      silpo_company_id: item.product.companyId ?? null,
      silpo_branch_id: item.product.branchId ?? result.context.branchId ?? null,
      silpo_product_slug: item.product.slug ?? null,
      silpo_image_url: item.product.imageUrl ?? null,
      silpo_sync_status: "synced",
      silpo_sync_error: null,
      updated_at: new Date().toISOString(),
      }).eq("id", item.id)),
      ...[...result.errors].map(([id, message]) => admin.from("basket_items").update({
        silpo_sync_status: "error",
        silpo_sync_error: message,
        updated_at: new Date().toISOString(),
      }).eq("id", id)),
    ]);
    const failedMessage = result.errors.size ? [...result.errors.values()].join(" ").slice(0, 1000) : null;
    await admin.from("parties").update({
      silpo_cart_id: result.context.cartId,
      silpo_checkout_url: result.checkoutUrl ?? null,
      silpo_sync_status: result.errors.size ? "error" : "synced",
      silpo_sync_error: failedMessage,
      silpo_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", partyId);
    return result.errors.size
      ? { ok: false as const, error: failedMessage ?? "Не всі товари знайдено." }
      : { ok: true as const };
  } catch (error) {
    const message = errorMessage(error);
    await Promise.all([
      admin.from("parties").update({ silpo_sync_status: "error", silpo_sync_error: message }).eq("id", partyId),
      admin.from("basket_items").update({ silpo_sync_status: "error", silpo_sync_error: message }).eq("party_id", partyId),
    ]);
    return { ok: false as const, error: message };
  }
}

export async function removePartyItemFromSilpo(partyId: string, hostId: string, item: ManagedItem) {
  if (!item.silpo_product_id) return { ok: true as const };
  try {
    await withSilpoMcp(hostId, async (client, tools) => {
      const context = await getCartContext(client, tools);
      const admin = createAdminClient();
      const { data } = await admin
        .from("basket_items")
        .select("quantity")
        .eq("party_id", partyId)
        .eq("silpo_product_id", item.silpo_product_id)
        .neq("id", item.id);
      const remaining = (data ?? []).reduce((sum, entry) => sum + Number(entry.quantity), 0);
      const product = {
        productId: item.silpo_product_id!,
        companyId: item.silpo_company_id ?? context.companyId,
        branchId: item.silpo_branch_id ?? context.branchId,
        name: item.name,
        quantity: remaining,
      };
      if (remaining > 0) await callTool(client, tools, "silpo_add_or_update_cart_products", "add", context, { products: [product] });
      else await callTool(client, tools, "silpo_remove_cart_products", "remove", context, { products: [{ ...product, quantity: Number(item.quantity) }] });
    });
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error) };
  }
}
