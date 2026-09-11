# AI Debug Catalog Gateway and Live Harness Design

## Goal

Make `/ai-debug` product retrieval fast, observable and deterministic at the
transport boundary while keeping global product choice with the main agent. Add
a local Python harness that authenticates a tester through Silpo OAuth and
executes the same TypeScript gateway and agent code with an inspectable trace.

## Scope

- Apply the new retrieval path only to `/ai-debug`.
- Keep the existing party local-cart, evidence, membership, Host finalization and
  `Send to Silpo` paths unchanged.
- Do not adopt Silposha's private e-commerce API, browser automation or token
  storage. Use only the official Silpo MCP OAuth and Streamable HTTP connection.
- Do not make product selection "first MCP result wins".

## Architecture

```text
Agent tool: searchProducts({ queries: [1..3 short alternatives] })
  -> Debug catalog gateway (one run-scoped MCP session)
  -> one silpo_find_products_batch call
  -> bounded, validated candidate groups + local evidence IDs
  -> agent chooses a verified evidence ID
  -> local cart mutation
```

### 1. Run-scoped catalog gateway

Introduce a server-only `DebugCatalogGateway` and an explicit
`DebugCatalogSession` port. It opens the Host MCP connection lazily on the
first catalog tool call in a supervisor run, discovers advertised tools once,
reads the Host cart/store context once, and closes the connection only when the
run ends. `search(queries)` accepts one to three distinct compact strings and
uses one `silpo_find_products_batch` call. `inspect(productId)` shares the same
session and context.

The production session factory obtains the Host token through the existing
server-only `getAccessToken`; no token crosses an agent boundary. The gateway
is the sole owner of MCP schemas, argument construction, response bounding,
availability/price validation and MCP error normalization.

### 2. Agent tools and product choice

Replace the single-string `searchProducts` input with a strict
`{ queries: string[] }` input containing one to three unique, short product
queries. The model may issue another batch using different words if no group
has a suitable candidate. The gateway returns at most twelve current candidates
per query, each containing only safe catalog fields and a server-generated
evidence ID.

The main agent remains the decision maker. It receives party context, budget,
restrictions, recent purchases, current local cart and the validated candidates.
It may choose any verified candidate, call `inspectProduct` or
`compareAlternatives`, and must use an evidence ID to mutate the local cart.
The gateway may filter invalid/unavailable candidates and annotate prior
purchases/discounts, but never selects a product or silently adds it.

### 3. Safe trace contract

Create a Zod-validated trace event contract shared by the party debug log and
the harness. Trace entries record:

- agent tool name and validated input shape;
- selected MCP method, request query count and elapsed time;
- compact returned candidates (name, product ID, unit, price, promotion,
  availability and evidence ID only);
- agent's selected evidence ID and resulting local-cart mutation;
- stable stage/code for failure.

Raw MCP bodies, authorization headers, OAuth tokens, address/cart profile
fields and model reasoning are never persisted, returned, logged or included in
the trace. Existing historical generic events remain unchanged; new events use
the new structured contract.

### 4. Local Python live harness

Add a developer-only API surface enabled only when `NODE_ENV=development` and
protected by `AI_DEBUG_HARNESS_SECRET`. It accepts a temporary MCP access token
only in request memory and runs an isolated harness workspace: an in-memory
local cart, the real gateway/parser and the configured agent provider. It never
writes party records or a real Silpo cart.

Add `scripts/ai_debug_harness.py` with a `run` command. It dynamically
registers an OAuth client, starts a loopback callback, opens the authorization
URL in the tester's browser, exchanges the code with PKCE, then sends
messages to the localhost harness. The Python process keeps the temporary token
only in memory for its interactive session. It prints a readable JSONL trace
after every message, including tool calls, catalog candidates and selected local
cart entries. It does not print or save the token.

### Error behavior

- An expired/forbidden MCP connection produces `silpo_mcp_session` plus a
  stable safe code.
- A missing Host cart/store/slot names the exact MCP stage that supplied the
  missing context.
- Empty search results are a valid candidate response, not an MCP failure.
- The harness returns structured 4xx errors when disabled, unauthorized or
  malformed; it never falls back to real party data or cart writes.

## Testing

1. Unit tests prove a three-query tool request becomes one batch MCP request,
   validates and bounds candidates, and keeps cross-query results separated.
2. Unit tests prove the gateway never returns raw MCP/token/address fields and
   that the agent must choose a current evidence ID rather than a list position.
3. Supervisor tests cover lazy session reuse across search and inspect, and
   trace events for request, returned candidates, choice and safe failure stage.
4. Route tests reject production mode, missing/incorrect harness secret and
   invalid tokens before a model or MCP call begins.
5. A manual `python scripts/ai_debug_harness.py run` smoke test confirms OAuth,
   a real `silpo_find_products_batch` result, agent choice and an in-memory cart
   without exposing credentials or writing a real Silpo cart.

## Non-goals

- Replacing the old `/party` synchronization path.
- Sending arbitrary MCP tools or raw tool results to the LLM.
- Persisting harness tokens or adding a production remote debug endpoint.
- Deterministic first-result product selection.
