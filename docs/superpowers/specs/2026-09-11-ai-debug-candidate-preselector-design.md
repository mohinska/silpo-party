# AI Debug Candidate Preselector Design

## Goal

Make product choice reliable across the catalog by placing a constrained semantic preselector between live Silpo search and the shared-cart supervisor. The preselector removes incompatible candidates; the main agent remains the only agent that selects an evidence ID and edits the local cart.

## Problem

The current live search returns valid products but broad text queries may mix product forms: for example, a request for ordinary milk can return cream, milk for coffee foam, children’s milk, lactose-free milk, condensed milk, and protein milk. The main agent receives a median price and may choose a technically valid but unexpected product. There is no generic batch-search rating or popularity field in the Silpo MCP response, so a fabricated universal quality ranking is unsafe.

## Architecture

```text
participant request + compact party constraints
  -> main agent chooses 1–3 live Silpo search queries
  -> catalog gateway retrieves verified, branch/slot-specific products
  -> candidate preselector normalizes the requested product and labels only
     returned evidence as match / partial / exclude
  -> main agent receives match and partial candidates, history, final prices,
     promotion data and median price; it chooses an evidence ID
  -> local-cart tools validate evidence and mutate the local cart
```

The preselector is a separate LLM call but has no MCP tools and no cart tools. It receives only normalized, bounded data. It cannot introduce a product, price, ID, quantity, nutrition claim, brand rating, or instruction. Its response is parsed with strict Zod schemas and cross-checked against the evidence supplied to it.

### Candidate-preselector contract

Input:

- the active planning request (latest chat message in chat mode; current party intent summary in build mode);
- the search queries selected by the main agent;
- compact participant dietary restrictions/favorites and recent product names, without identifiers beyond safe evidence IDs;
- up to 30 verified candidates per query: evidence ID, product ID, name, unit, final price, availability, discount flag, and source.

Output:

- a compact normalized intent: requested product kind, requested form or attributes, and exclusions;
- one verdict per supplied evidence ID: `match`, `partial`, or `exclude`, with a short Ukrainian reason;
- no candidate IDs other than the supplied IDs; duplicate or missing verdicts invalidate the preselection response.

`match` means the candidate is compatible without an unstated compromise. `partial` means it is usable but differs in an explicit product-form attribute; the main agent can use it only if no preferred match exists or the user has asked for an alternative. `exclude` means it is not the requested product/form or conflicts with a known restriction. The preselector must not exclude a candidate only because it does not recognize a brand.

The preselector must distinguish a product’s primary type before brand or price: milk is not cream; cheese is not a cheese product; sparkling water is not a sweet beverage. It must keep user-requested variants (for example lactose-free, children’s, vegan, protein, coffee, baked, flavored) and exclude those variants only when they were not requested. It treats a direct brand request as a strong requirement.

### Main-agent selection policy

The main agent sees only `match` candidates by default. It sees `partial` candidates separately, with their reason, and may use them only after it has searched again with different terms or explains a necessary compromise in its short reply. If there are no matches, it must run another batch of alternative search terms before asking the user.

Within matches, selection remains LLM-led and evidence-bound:

1. respect restrictions and explicit brand/form requirements;
2. prefer the participant’s or party’s recent equivalent products when suitable;
3. prefer a familiar, normal product at or below the live median price, not automatically the lowest price;
4. use a discount, size and product details as additional evidence;
5. never claim ratings, popularity, objective quality, or a price comparison unless that data is present.

The system must not hardcode a universal approved-brand list. For the current milk example, Galychyna, Molokiia or Yahotynske can be selected by the main agent as reasonable familiar brands when present and within the price threshold; the preselector’s job is only to remove mismatched milk variants.

### Failure and safety behavior

- If the preselector output fails Zod or evidence membership validation, search results fail open as `unclassified`; the main-agent prompt says to run a different query or inspect product details, not to invent a preselection result.
- If no `match` candidates remain, return the excluded/partial counts and a `requiresAlternateSearch` signal. Do not silently substitute an excluded product.
- MCP tokens, raw responses and personal data do not cross into either model, database, UI or debug trace.
- The local-cart evidence freshness, authorization and revision checks remain unchanged and are the final mutation gate.

### Observability

Each `searchProducts` debug trace gets a safe `preselection` section with:

- normalized requested kind/form/exclusions;
- per-verdict counts;
- the selected verdict and short reason per visible candidate;
- `status`: `completed`, `unavailable`, or `invalid`.

No raw LLM response, chain of thought, token, raw MCP response, address or authentication field is logged. The Python harness renders these verdicts beneath each candidate so live testing shows why a product was retained or excluded.

## Boundaries

- `candidate-preselector.ts`: pure schemas, validation and safe model adapter. It has no repository, MCP or cart imports.
- `cart-tools.ts`: calls the preselector after verified search persistence and returns filtered groups plus safe preselection metadata.
- `supervisor.ts` and `harness.ts`: build the compact selection context, pass the model adapter, and set main-agent instructions. They do not implement filtering logic.
- `catalog-trace.ts`, workspace view, debug log and Python harness expose only safe verdict metadata.

## Tests

1. A milk request marks cream, children’s milk, lactose-free milk and coffee-foam milk as excluded while retaining ordinary milk.
2. A request explicitly asking for lactose-free milk retains it and does not exclude it by the generic rule.
3. A malformed response, unknown evidence ID, duplicate ID or missing verdict fails open without hiding verified candidates.
4. `searchProducts` exposes matching products separately from partial/excluded products and preserves existing evidence validation.
5. Supervisor and dev harness pass only compact safe input to the preselector and preserve a short end-user reply.
6. Catalog trace and the Python renderer show safe preselection reasons, never raw model/MCP data.
