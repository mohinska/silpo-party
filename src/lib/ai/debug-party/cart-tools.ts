import type { ToolSet } from "ai";
import { z } from "zod";
import type { HostCatalogAdapter, SilpoVerifiedProduct } from "../../silpo/cart";
import type { DebugCatalogGateway } from "./catalog-gateway";
import { preselectCandidates, type CandidatePreselection, type CandidatePreselector } from "./candidate-preselector";
import type { CartMutation, DebugPartyRepository, DebugPartyWorkspace } from "./repository";
import { DebugProductEvidenceSchema, type DebugProductEvidence } from "./schemas";

const Id = z.string().trim().min(1).max(200);
const Revision = z.number().int().nonnegative();
const Quantity = z.number().finite().positive().max(1000);
const Empty = z.strictObject({});
const MAX_CANDIDATES_PER_QUERY = 30;
const Search = z.strictObject({ queries: z.array(z.string().trim().min(1).max(100)).min(1).max(3).refine((queries) =>
  new Set(queries.map((query) => query.toLocaleLowerCase("uk-UA"))).size === queries.length, "Search queries must be distinct.") });
const Inspect = z.strictObject({ productId: Id });
const Compare = z.strictObject({ evidenceIds: z.array(Id).min(1).max(MAX_CANDIDATES_PER_QUERY) });
const Add = z.strictObject({ evidenceId: Id, quantity: Quantity, expectedRevision: Revision });
const Replace = Add.extend({ itemId: Id });
const SetQuantity = z.strictObject({ itemId: Id, quantity: Quantity, expectedRevision: Revision });
const Remove = z.strictObject({ itemId: Id, expectedRevision: Revision });
const Complete = z.strictObject({ reply: z.string().trim().min(1).max(500) });
const FRESH_MS = 15 * 60 * 1000;

export type LocalCartToolsContext = {
  partyId: string;
  code: string;
  actorId: string;
  hostId: string;
  runId: string;
  repository: Pick<DebugPartyRepository, "loadWorkspace" | "applyCartCommand" | "saveEvidence" | "findEvidence">;
  catalogGateway?: Pick<DebugCatalogGateway, "search" | "inspect">;
  catalogAdapter?: HostCatalogAdapter;
  candidatePreselector?: CandidatePreselector;
  selectionContext?: {
    request: string;
    constraints: {
      dietaryRestrictions: string[];
      favorites: string[];
      recentProductNames: string[];
    };
  };
  now?: () => Date;
};

/** Suitability is evaluated by the caller; an unavailable product is never ranked. */
export function rankCandidates<T extends DebugProductEvidence & { suitable: boolean }>(candidates: readonly T[]): T[] {
  const priority = (entry: T) => entry.source === "recent_purchase" ? (entry.discountCents && entry.discountCents > 0 ? 0 : 1) : 2;
  return candidates.filter((entry) => entry.suitable && entry.available).sort((a, b) => {
    const sourceDifference = priority(a) - priority(b);
    return sourceDifference || (priority(a) === 2 ? a.unitPriceCents - b.unitPriceCents : 0);
  });
}

function compactProduct(entry: DebugProductEvidence) {
  return {
    evidenceId: entry.id, productId: entry.productId, companyId: entry.companyId, branchId: entry.branchId,
    name: entry.name, unit: entry.unit, unitPriceCents: entry.unitPriceCents,
    discountCents: entry.discountCents, discounted: (entry.discountCents ?? 0) > 0,
    available: entry.available, source: entry.source, observedAt: entry.observedAt,
  };
}

function compactPreselection(preselection: CandidatePreselection, evidence: DebugProductEvidence) {
  const verdict = preselection.verdicts.find((entry) => entry.evidenceId === evidence.id);
  return verdict ?? { evidenceId: evidence.id, verdict: "unclassified" as const, reason: "Попередній відбір недоступний." };
}

function compactCart(workspace: DebugPartyWorkspace) {
  return {
    revision: workspace.party.cartRevision,
    budgetCents: workspace.party.budgetCents,
    totalCents: workspace.cartItems.reduce((total, item) => total + Math.round(item.unitPriceCents * item.quantity), 0),
    items: workspace.cartItems.slice(0, 100).map((item) => ({
      id: item.id, productId: item.productId, evidenceId: item.evidenceId, name: item.name,
      quantity: item.quantity, unit: item.unit, unitPriceCents: item.unitPriceCents,
      discountCents: item.discountCents, discounted: (item.discountCents ?? 0) > 0,
    })),
  };
}

export function createLocalCartTools(context: LocalCartToolsContext) {
  const { repository, partyId, actorId, hostId, runId, code } = context;
  const now = context.now ?? (() => new Date());
  const catalogAdapter: HostCatalogAdapter = context.catalogAdapter ?? (async (userId, operation) => {
    const { withSilpoCatalogReader } = await import("../../silpo/cart");
    return withSilpoCatalogReader(userId, operation);
  });
  const catalogGateway: Pick<DebugCatalogGateway, "search" | "inspect"> = context.catalogGateway ?? {
    async search(queries) {
      return { groups: await Promise.all(queries.map(async (query) => ({ query, products: await catalogAdapter(hostId, (reader) => reader.search(query)) }))) };
    },
    inspect(productId) {
      return catalogAdapter(hostId, (reader) => reader.inspect(productId));
    },
  };
  let catalogCalls = 0;

  async function workspace() {
    const state = await repository.loadWorkspace(code, actorId);
    if (state.party.id !== partyId) throw new Error("Party does not match tool context.");
    if (state.party.hostId !== hostId) throw new Error("Host does not match party.");
    return state;
  }

  async function verified(evidenceId: string) {
    const entry = await repository.findEvidence({ partyId, actorId, evidenceId });
    const age = entry ? now().getTime() - Date.parse(entry.observedAt) : Infinity;
    if (!entry || entry.runId !== runId || !entry.available || age < 0 || age > FRESH_MS) {
      throw new Error("A current verified product evidence ID is required.");
    }
    return entry;
  }

  async function persistProducts(state: DebugPartyWorkspace, products: readonly SilpoVerifiedProduct[], source: "catalog_search" | "product_detail") {
    const previous = new Set(state.contexts.filter((entry) => entry.contextStatus === "ready").flatMap((entry) => entry.recentProducts.map((product) => product.productId)));
    const observedAt = now().toISOString();
    const saved: DebugProductEvidence[] = [];
    for (const product of products.slice(0, MAX_CANDIDATES_PER_QUERY)) {
      const evidence = DebugProductEvidenceSchema.parse({
        ...productFields(product), id: crypto.randomUUID(), partyId, runId,
        source: previous.has(product.productId) ? "recent_purchase" : source,
        observedAt, createdAt: observedAt,
      });
      saved.push(await repository.saveEvidence({ partyId, actorId, evidence }));
    }
    const ranked = rankCandidates(saved.map((entry) => ({ ...entry, suitable: true })));
    const unavailable = saved.filter((entry) => !entry.available);
    return [...ranked, ...unavailable];
  }

  async function discoverSearch(queries: z.infer<typeof Search>["queries"]) {
    const state = await workspace();
    if (!["ready", "running"].includes(state.party.status)) throw new Error("Party is not ready for catalog planning.");
    if (catalogCalls >= 20) throw new Error("Catalog call budget exhausted.");
    catalogCalls += 1;
    const result = await catalogGateway.search(queries);
    const savedGroups: Array<{ query: string; products: DebugProductEvidence[] }> = [];
    for (const group of result.groups) {
      const saved = await persistProducts(state, group.products, "catalog_search");
      savedGroups.push({ query: group.query, products: saved });
    }
    const allSaved = savedGroups.flatMap((group) => group.products);
    const preselection = allSaved.length
      ? await preselectCandidates({
        request: context.selectionContext?.request ?? `Товари за запитом: ${queries.join(", ")}`,
        queries,
        constraints: context.selectionContext?.constraints ?? { dietaryRestrictions: [], favorites: [], recentProductNames: [] },
        candidates: allSaved.map((entry) => ({
          evidenceId: entry.id, productId: entry.productId, name: entry.name, unit: entry.unit,
          unitPriceCents: entry.unitPriceCents, discountCents: entry.discountCents, available: entry.available, source: entry.source,
        })),
      }, context.candidatePreselector)
      : { status: "unavailable" as const, normalizedIntent: null, verdicts: [] };
    const evidenceByProduct = new Map<string, DebugProductEvidence>();
    const groups = savedGroups.map((group) => {
      const matches = group.products.filter((entry) => compactPreselection(preselection, entry).verdict === "match");
      const partials = group.products.filter((entry) => compactPreselection(preselection, entry).verdict === "partial");
      const visible = preselection.status === "completed" ? matches : group.products;
      const medianSource = matches.length ? matches : visible.length ? visible : partials;
      for (const entry of visible) evidenceByProduct.set(entry.productId, entry);
      return {
        query: group.query,
        priceContext: priceContext(medianSource),
        products: visible.map(compactProduct),
        partials: preselection.status === "completed" ? partials.map(compactProduct) : [],
        excludedCount: preselection.status === "completed" ? group.products.filter((entry) => compactPreselection(preselection, entry).verdict === "exclude").length : 0,
        requiresAlternateSearch: preselection.status === "completed" && matches.length === 0,
        preselection: {
          status: preselection.status,
          normalizedIntent: preselection.normalizedIntent,
          verdicts: group.products.map((entry) => compactPreselection(preselection, entry)),
        },
      };
    });
    return {
      revision: state.party.cartRevision,
      groups,
      products: [...evidenceByProduct.values()].map(compactProduct),
      traceCandidates: allSaved.map((entry) => ({ ...compactProduct(entry), preselection: compactPreselection(preselection, entry) })),
      preselection: { status: preselection.status, normalizedIntent: preselection.normalizedIntent },
    };
  }

  async function discoverInspect(productId: string) {
    const state = await workspace();
    if (!["ready", "running"].includes(state.party.status)) throw new Error("Party is not ready for catalog planning.");
    if (catalogCalls >= 20) throw new Error("Catalog call budget exhausted.");
    catalogCalls += 1;
    const saved = await persistProducts(state, (await catalogGateway.inspect(productId)).filter((product) => product.productId === productId), "product_detail");
    return { revision: state.party.cartRevision, products: saved.map(compactProduct) };
  }

  async function mutate(expectedRevision: number, mutation: CartMutation) {
    const state = await workspace();
    if (!["ready", "running"].includes(state.party.status)) throw new Error("Party cart cannot be edited in this state.");
    if (state.party.cartRevision !== expectedRevision) return { status: "stale" as const, ...compactCart(state) };
    if ("evidenceId" in mutation) await verified(mutation.evidenceId);
    if ("itemId" in mutation && !state.cartItems.some((item) => item.id === mutation.itemId)) throw new Error("A current cart item ID is required.");
    const result = await repository.applyCartCommand({ partyId, actorId, expectedRevision, mutation });
    return { status: result.status, ...compactCart(await workspace()) };
  }

  return {
    inspectCart: { description: "Inspect the current local cart and revision.", inputSchema: Empty,
      execute: async (input: z.infer<typeof Empty>) => { Empty.parse(input); return compactCart(await workspace()); } },
    searchProducts: { description: "Search one to three alternative live Host store product queries in one batch; persist bounded verified evidence. Choose a returned evidence ID yourself.", inputSchema: Search,
      execute: async (input: z.infer<typeof Search>) => discoverSearch(Search.parse(input).queries) },
    inspectProduct: { description: "Inspect a known product ID with live price, promotion and availability from the Host store.", inputSchema: Inspect,
      execute: async (input: z.infer<typeof Inspect>) => discoverInspect(Inspect.parse(input).productId) },
    compareAlternatives: { description: "Compare at most 30 suitable evidence IDs. Results prefer discounted recent purchases, then other recent purchases; equally suitable catalog results are sorted by final payable unitPriceCents ascending. You still choose the evidence ID.", inputSchema: Compare,
      execute: async (input: z.infer<typeof Compare>) => {
        const { evidenceIds } = Compare.parse(input);
        const state = await workspace();
        const entries = await Promise.all([...new Set(evidenceIds)].map(verified));
        return { revision: state.party.cartRevision, products: rankCandidates(entries.map((entry) => ({ ...entry, suitable: true }))).map(compactProduct) };
      } },
    addProduct: { description: "Add a current verified product to the local cart.", inputSchema: Add,
      execute: async (input: z.infer<typeof Add>) => { const { expectedRevision, ...args } = Add.parse(input); return mutate(expectedRevision, { type: "add", ...args }); } },
    replaceProduct: { description: "Replace a current local cart item with a verified product.", inputSchema: Replace,
      execute: async (input: z.infer<typeof Replace>) => { const { expectedRevision, ...args } = Replace.parse(input); return mutate(expectedRevision, { type: "replace", ...args }); } },
    setQuantity: { description: "Set a positive quantity on a current local cart item.", inputSchema: SetQuantity,
      execute: async (input: z.infer<typeof SetQuantity>) => { const { expectedRevision, ...args } = SetQuantity.parse(input); return mutate(expectedRevision, { type: "quantity", ...args }); } },
    removeProduct: { description: "Remove a current item from the local cart.", inputSchema: Remove,
      execute: async (input: z.infer<typeof Remove>) => { const { expectedRevision, ...args } = Remove.parse(input); return mutate(expectedRevision, { type: "remove", ...args }); } },
    complete: { description: "Finish this agent turn with a short Ukrainian reply and current cart state. Does not finalize or send the cart.", inputSchema: Complete,
      execute: async (input: z.infer<typeof Complete>) => { const { reply } = Complete.parse(input); return { completed: true, reply, ...compactCart(await workspace()) }; } },
  } satisfies ToolSet;
}

function priceContext(entries: readonly DebugProductEvidence[]) {
  const prices = entries.filter((entry) => entry.available).map((entry) => entry.unitPriceCents).sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  return {
    candidateCount: prices.length,
    medianUnitPriceCents: prices.length === 0 ? null : prices.length % 2 === 1 ? prices[middle] : Math.round((prices[middle - 1] + prices[middle]) / 2),
  };
}

function productFields(product: SilpoVerifiedProduct) {
  return {
    productId: product.productId, companyId: product.companyId, branchId: product.branchId,
    name: product.name, unit: product.unit, unitPriceCents: product.unitPriceCents,
    discountCents: product.discountCents, imageUrl: product.imageUrl, available: product.available,
  };
}
