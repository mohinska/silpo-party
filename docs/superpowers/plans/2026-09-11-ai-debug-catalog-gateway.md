# AI Debug Catalog Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/ai-debug` a run-scoped official Silpo MCP catalog gateway and a local Python OAuth harness that shows the agent's safe tool/search/choice trace.

**Architecture:** A server-only gateway owns one lazy MCP session per supervisor run, cart context, batch product retrieval and response validation. Agent tools receive compact evidence-backed candidates and choose products themselves. A development-only route runs the same gateway against an ephemeral local cart for the Python harness; it never writes party or Silpo carts.

**Tech Stack:** Next.js 16 route handlers, TypeScript strict mode, Zod 4, AI SDK 7, official MCP TypeScript SDK, Python 3 standard library HTTP/OAuth helpers.

**Spec:** `docs/superpowers/specs/2026-09-11-ai-debug-catalog-gateway-design.md`

## Global Constraints

- Apply only to `/ai-debug`; leave `/party` and `Send to Silpo` behavior unchanged.
- Only the backend can use MCP access tokens; never pass them to prompts, persistent storage, UI traces or Python output.
- Use official Silpo MCP Streamable HTTP and OAuth 2.1, never Silposha's private API.
- The gateway returns validated candidates; the agent chooses evidence IDs and the local cart remains the only cart it can mutate.
- Validate every cross-boundary payload with strict Zod schemas; do not introduce `any`.
- Use `npm` and apply tests before production code for every behavior change.

---

### Task 1: Extract a run-scoped MCP catalog session

**Files:**
- Create: `src/lib/ai/debug-party/catalog-gateway.ts`
- Create: `src/lib/ai/debug-party/catalog-gateway.test.ts`
- Modify: `src/lib/silpo/mcp.ts`
- Modify: `src/lib/silpo/cart.ts`

**Interfaces:**
- Consumes: `withSilpoMcp`, `SilpoTool`, `readToolData`, existing cart-context parsing/validation helpers.
- Produces: `DebugCatalogGateway`, with `search(queries: readonly string[])`, `inspect(productId: string)` and `close()`.

- [ ] **Step 1: Write failing session-reuse and batch tests**

```ts
it("opens one MCP session and sends three queries in one batch", async () => {
  const gateway = createDebugCatalogGateway({ openSession });
  await gateway.search(["сир", "сир твердий", "cheese"]);
  await gateway.inspect("product-1");

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(calls).toContainEqual({
    name: "silpo_find_products_batch",
    arguments: expect.objectContaining({ products: ["сир", "сир твердий", "cheese"] }),
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the gateway does not exist**

Run: `npm test -- --run src/lib/ai/debug-party/catalog-gateway.test.ts`

Expected: FAIL with module/export-not-found.

- [ ] **Step 3: Implement the smallest session factory and gateway**

```ts
export type DebugCatalogGateway = {
  search(queries: readonly string[]): Promise<DebugCatalogSearchResult>;
  inspect(productId: string): Promise<readonly SilpoVerifiedProduct[]>;
  close(): Promise<void>;
};

export function createHostDebugCatalogGateway(hostId: string): DebugCatalogGateway {
  // Lazily connect, list tools and resolve cart context exactly once.
  // Build silpo_find_products_batch arguments from its advertised schema.
}
```

Move shared pure parsing helpers out of `src/lib/silpo/cart.ts` without changing
the old exported `/party` behavior. Make `withSilpoMcp` expose an explicit
closeable session factory rather than holding a callback open in the gateway.

- [ ] **Step 4: Run focused gateway and existing catalog tests**

Run: `npm test -- --run src/lib/ai/debug-party/catalog-gateway.test.ts src/lib/ai/debug-party/cart-tools.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated gateway extraction**

```bash
git add src/lib/ai/debug-party/catalog-gateway.ts src/lib/ai/debug-party/catalog-gateway.test.ts src/lib/silpo/mcp.ts src/lib/silpo/cart.ts src/lib/ai/debug-party/cart-tools.test.ts
git commit -m "feat: add run scoped debug catalog gateway"
```

### Task 2: Make batch search and evidence selection explicit agent tools

**Files:**
- Modify: `src/lib/ai/debug-party/cart-tools.ts`
- Modify: `src/lib/ai/debug-party/cart-tools.test.ts`
- Modify: `src/lib/ai/debug-party/supervisor.ts`
- Modify: `src/lib/ai/debug-party/supervisor.test.ts`

**Interfaces:**
- Consumes: `DebugCatalogGateway` from Task 1 and current evidence repository methods.
- Produces: `searchProducts({ queries: string[] })`, grouped compact candidates, and a gateway lifecycle owned by one supervisor run.

- [ ] **Step 1: Write a failing test for one batch request and non-first selection**

```ts
it("persists candidates from one batch without selecting the first result", async () => {
  const result = await tools.searchProducts.execute({ queries: ["шоколад", "Lacmi кокос"] });
  const selected = result.groups[1].products[1];
  await tools.addProduct.execute({ evidenceId: selected.evidenceId, quantity: 1, expectedRevision: 2 });

  expect(gateway.search).toHaveBeenCalledWith(["шоколад", "Lacmi кокос"]);
  expect(cartItems[0].productId).toBe("lacmi-coconut");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails on the former single `query` contract**

Run: `npm test -- --run src/lib/ai/debug-party/cart-tools.test.ts`

Expected: FAIL because `queries` is not accepted or groups are absent.

- [ ] **Step 3: Implement strict batch input and grouped compact output**

Use a Zod schema equivalent to:

```ts
const Search = z.strictObject({
  queries: z.array(z.string().trim().min(1).max(100)).min(1).max(3)
    .refine((items) => new Set(items.map((item) => item.toLocaleLowerCase("uk-UA"))).size === items.length),
});
```

Store every returned candidate as current run evidence. Keep `addProduct` and
`replaceProduct` evidence-ID-only. Create one gateway before `ToolLoopAgent`
generation and close it in the supervisor `finally` block.

- [ ] **Step 4: Update the system instruction and tests**

Require the model to form one to three synonyms per search, inspect/compare if
needed and never interpret listing order as a purchase decision. Update all
mock model calls to `{ queries: ["..."] }`.

- [ ] **Step 5: Run related tests and commit**

Run: `npm test -- --run src/lib/ai/debug-party/cart-tools.test.ts src/lib/ai/debug-party/supervisor.test.ts`

Expected: PASS.

```bash
git add src/lib/ai/debug-party/cart-tools.ts src/lib/ai/debug-party/cart-tools.test.ts src/lib/ai/debug-party/supervisor.ts src/lib/ai/debug-party/supervisor.test.ts
git commit -m "feat: batch ai debug catalog search"
```

### Task 3: Persist and display a safe catalog trace

**Files:**
- Create: `src/lib/ai/debug-party/catalog-trace.ts`
- Create: `src/lib/ai/debug-party/catalog-trace.test.ts`
- Modify: `src/lib/ai/debug-party/schemas.ts`
- Modify: `src/lib/ai/debug-party/workspace-view.ts`
- Modify: `src/app/ai-debug/party/[code]/debug-log.tsx`
- Modify: `src/app/ai-debug/party/page.module.css`

**Interfaces:**
- Consumes: gateway request/result summaries and existing `debug_tool_events.metadata` persistence.
- Produces: Zod-validated trace metadata exposed to the party debug log.

- [ ] **Step 1: Write failing redaction tests**

```ts
it("keeps compact candidates but strips tokens, addresses and raw MCP bodies", () => {
  const event = catalogTrace.searchReturned({
    token: "secret", address: { street: "private" }, raw: { nested: true },
    candidates: [{ productId: "1", name: "Вода", unitPriceCents: 2900 }],
  });

  expect(event).toMatchObject({ type: "catalog.response", candidates: [{ productId: "1", name: "Вода" }] });
  expect(JSON.stringify(event)).not.toMatch(/secret|private|nested/);
});
```

- [ ] **Step 2: Run the trace test and confirm it fails because no trace contract exists**

Run: `npm test -- --run src/lib/ai/debug-party/catalog-trace.test.ts`

Expected: FAIL with module/export-not-found.

- [ ] **Step 3: Implement strict safe trace schemas**

Allow only tool name, MCP method, stable code, duration, query strings, and
bounded candidate public catalog fields. Map the new metadata in
`workspace-view.ts`; render a concise expandable search request → candidates →
selected evidence sequence in the debug log. Preserve generic historical event
rendering.

- [ ] **Step 4: Run trace, workspace and supervisor tests**

Run: `npm test -- --run src/lib/ai/debug-party/catalog-trace.test.ts src/lib/ai/debug-party/repository.test.ts src/lib/ai/debug-party/supervisor.test.ts`

Expected: PASS with no token/raw-payload leakage.

- [ ] **Step 5: Commit safe observability**

```bash
git add src/lib/ai/debug-party/catalog-trace.ts src/lib/ai/debug-party/catalog-trace.test.ts src/lib/ai/debug-party/schemas.ts src/lib/ai/debug-party/workspace-view.ts src/app/ai-debug/party/[code]/debug-log.tsx src/app/ai-debug/party/page.module.css
git commit -m "feat: trace debug catalog decisions"
```

### Task 4: Build the development-only ephemeral harness API

**Files:**
- Create: `src/lib/ai/debug-party/harness.ts`
- Create: `src/lib/ai/debug-party/harness.test.ts`
- Create: `src/app/api/ai-debug/harness/route.ts`
- Create: `src/app/api/ai-debug/harness/route.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 1 gateway session factory, Task 2 tool definitions, Task 3 trace contract and `createDebugPartyModel`.
- Produces: `POST /api/ai-debug/harness`, protected ephemeral agent executions.

- [ ] **Step 1: Write failing route-access tests**

```ts
it.each([
  [{ NODE_ENV: "production", AI_DEBUG_HARNESS_SECRET: "x" }, 404],
  [{ NODE_ENV: "development", AI_DEBUG_HARNESS_SECRET: "x" }, 401],
])("refuses disabled or unauthorized harness calls", async (environment, status) => {
  const response = await postHarness({ environment, authorization: undefined });
  expect(response.status).toBe(status);
  expect(runHarness).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the route tests and confirm failure**

Run: `npm test -- --run src/app/api/ai-debug/harness/route.test.ts`

Expected: FAIL with route/module-not-found.

- [ ] **Step 3: Implement the in-memory harness**

Validate a strict body `{ message, mcpAccessToken }`; authenticate a
constant-time comparison of the `Bearer` developer secret; return 404 outside
development. Build a temporary MCP session from the supplied token, run the
same gateway and model, maintain cart/evidence in memory, and return only
validated reply/cart/trace JSON. Never import the production repository,
`send-to-silpo`, or a party code.

- [ ] **Step 4: Add developer variables and run focused tests**

Document only variable names:

```dotenv
AI_DEBUG_HARNESS_SECRET=replace_with_local_random_secret
AI_DEBUG_HARNESS_URL=http://localhost:3000/api/ai-debug/harness
```

Run: `npm test -- --run src/lib/ai/debug-party/harness.test.ts src/app/api/ai-debug/harness/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the local harness API**

```bash
git add src/lib/ai/debug-party/harness.ts src/lib/ai/debug-party/harness.test.ts src/app/api/ai-debug/harness/route.ts src/app/api/ai-debug/harness/route.test.ts .env.example
git commit -m "feat: add local ai debug harness api"
```

### Task 5: Add Python OAuth CLI and execute the live smoke test

**Files:**
- Create: `scripts/ai_debug_harness.py`
- Create: `scripts/ai_debug_harness.test.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: `AI_DEBUG_HARNESS_URL`, `AI_DEBUG_HARNESS_SECRET` and the official Silpo OAuth/MCP endpoints.
- Produces: `python scripts/ai_debug_harness.py run`, interactive OAuth plus JSONL agent trace.

- [ ] **Step 1: Write failing Python tests for PKCE and trace redaction**

```python
def test_authorization_url_has_pkce_and_loopback_redirect() -> None:
    url, verifier = authorization_url(port=8765)
    assert url.startswith("https://mcp.silpo.ua/authorize?")
    assert "code_challenge=" in url
    assert verifier

def test_trace_writer_never_prints_access_token(capsys) -> None:
    print_trace({"access_token": "secret", "trace": []})
    assert "secret" not in capsys.readouterr().out
```

- [ ] **Step 2: Run Python tests and confirm failure**

Run: `python -m unittest scripts/ai_debug_harness.test.py`

Expected: FAIL because the CLI module is absent.

- [ ] **Step 3: Implement interactive `run` command with memory-only token**

Use Dynamic Client Registration, authorization-code PKCE and a loopback
`http.server` callback. Open the browser with `webbrowser.open`; exchange the
code; keep the token in the process only; repeatedly read a message, POST it to
the local harness, and render reply, cart and JSONL trace. Use `urllib.request`
and standard-library JSON so no Python dependency is added. Explicitly refuse a
non-localhost harness URL.

- [ ] **Step 4: Document and run all relevant verification**

Add README instructions for the local secret, `npm run dev`, the OAuth browser
login and `python scripts/ai_debug_harness.py run`. Then run:

```bash
npm run lint
npx tsc --noEmit
npm test
python -m unittest scripts/ai_debug_harness.test.py
```

Expected: all commands exit 0.

- [ ] **Step 5: Perform an approved live smoke test and commit**

Run `python scripts/ai_debug_harness.py run`, complete the OAuth login, submit
one concrete request such as `додай Lacmi з кокосом`, and confirm output has a
safe batch search trace, validated candidates, an evidence-ID selection and an
in-memory cart only. Then:

```bash
git add scripts/ai_debug_harness.py scripts/ai_debug_harness.test.py README.md
git commit -m "feat: add ai debug oauth harness"
```
