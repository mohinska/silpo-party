# AI Debug Candidate Preselector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter semantically incompatible verified Silpo candidates before the shared-cart agent chooses an evidence ID, without exposing raw MCP data or making cart mutations outside the existing local-cart tools.

**Architecture:** `candidate-preselector.ts` owns strict normalized input/verdict contracts and safe fallback validation. `cart-tools.ts` invokes it after evidence persistence and exposes matches/partials to the main agent. Supervisor/harness build compact input and expose verdicts via the existing safe catalog trace.

**Tech Stack:** TypeScript strict mode, Zod, Vercel AI SDK, Vitest, existing local Python harness.

**Spec:** `docs/superpowers/specs/2026-09-11-ai-debug-candidate-preselector-design.md`

## Global Constraints

- Host Silpo MCP sessions and all real-cart writes remain server-side; no token, raw MCP response, address or auth field can reach LLMs, persistence, UI, trace or Python output.
- The preselector receives only compact verified evidence and has no MCP/cart tools; it can label supplied evidence only and cannot add products, quantities, prices or brand ratings.
- Use strict Zod parsing; do not introduce `any`.
- Fail open for unavailable/malformed preselection; never silently discard verified candidates.
- Preserve local-cart evidence freshness, membership and cart-revision validation.
- Work in the existing user-selected branch/workspace; do not create a worktree.

---

### Task 1: Create the bounded candidate-preselector domain contract

**Files:**
- Create: `src/lib/ai/debug-party/candidate-preselector.ts`
- Create: `src/lib/ai/debug-party/candidate-preselector.test.ts`
- Modify: `src/lib/ai/debug-party/prompts.ts`

**Interfaces:**
- Consumes compact candidate fields `{ evidenceId, productId, name, unit, unitPriceCents, discountCents, available, source }`, a bounded request summary and search queries.
- Produces `CandidatePreselection`, `CandidatePreselector`, `preselectCandidates()` and `CANDIDATE_PRESELECTOR_PROMPT`.
- Is consumed by `createLocalCartTools()` in Task 2 and model adapters in Task 3.

- [ ] **Step 1: Write the failing domain tests**

```ts
it("keeps ordinary milk while excluding incompatible milk forms", async () => {
  const result = await preselectCandidates(input, async () => ({
    normalizedIntent: { productKind: "молоко", requestedAttributes: [], exclusions: ["вершки", "дитяче"] },
    verdicts: [
      { evidenceId: "ordinary", verdict: "match", reason: "Звичайне питне молоко." },
      { evidenceId: "cream", verdict: "exclude", reason: "Це вершки." },
    ],
  }));
  expect(result.status).toBe("completed");
  expect(result.verdicts.find((entry) => entry.evidenceId === "ordinary")?.verdict).toBe("match");
});

it.each(["unknown", "duplicate", "missing"])("fails open for %s verdict coverage", async (caseName) => {
  const result = await preselectCandidates(input, invalidPreselector(caseName));
  expect(result.status).toBe("invalid");
  expect(result.verdicts.every((entry) => entry.verdict === "unclassified")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/ai/debug-party/candidate-preselector.test.ts`

Expected: FAIL because the module/exports do not exist.

- [ ] **Step 3: Implement the strict domain module**

```ts
export const CandidateVerdictSchema = z.enum(["match", "partial", "exclude", "unclassified"]);
export type CandidatePreselector = (input: CandidatePreselectorInput) => Promise<unknown>;

export async function preselectCandidates(input: CandidatePreselectorInput, select?: CandidatePreselector) {
  if (!select) return fallback(input, "unavailable");
  try {
    return verifyCoverage(input.candidates, CandidatePreselectionOutputSchema.parse(await select(CandidatePreselectorInputSchema.parse(input))));
  } catch {
    return fallback(input, "invalid");
  }
}
```

Use `z.strictObject`, bounded strings/arrays and exactly one verdict for every supplied evidence ID. `verifyCoverage` rejects unknown, duplicate and missing IDs and makes every candidate `unclassified` on failure. Add generic primary-type/form rules to the prompt; explicit variants and brands override generic exclusions, and quality/popularity claims are forbidden.

- [ ] **Step 4: Run the domain test to verify it passes**

Run: `npm test -- src/lib/ai/debug-party/candidate-preselector.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain contract**

Run: `git add src/lib/ai/debug-party/candidate-preselector.ts src/lib/ai/debug-party/candidate-preselector.test.ts src/lib/ai/debug-party/prompts.ts && git commit -m "feat: add ai debug candidate preselector"`

### Task 2: Apply preselection inside verified local catalog search

**Files:**
- Modify: `src/lib/ai/debug-party/cart-tools.ts`
- Modify: `src/lib/ai/debug-party/cart-tools.test.ts`
- Modify: `src/lib/ai/debug-party/catalog-trace.ts`
- Modify: `src/lib/ai/debug-party/catalog-trace.test.ts`

**Interfaces:**
- Consumes Task 1 through optional `candidatePreselector` and compact `selectionContext` in `LocalCartToolsContext`.
- Produces `searchProducts` group fields `products`, `partials`, `excludedCount`, `requiresAlternateSearch`, `priceContext` and safe `preselection` metadata.
- Is consumed by supervisor and harness tracing in Task 3.

- [ ] **Step 1: Write failing tool tests**

```ts
it("does not offer excluded milk forms to the cart agent", async () => {
  const fixture = setup([ordinaryMilk, cream, coffeeMilk], {
    candidatePreselector: async () => completedPreselection({ ordinary: "match", cream: "exclude", coffee: "exclude" }),
  });
  const result = await fixture.tools.searchProducts.execute({ queries: ["молоко"] });
  expect(result.groups[0].products.map((entry) => entry.productId)).toEqual(["ordinary"]);
  expect(result.groups[0]).toMatchObject({ excludedCount: 2, requiresAlternateSearch: false });
});

it("keeps all verified candidates unclassified when preselection fails", async () => {
  const fixture = setup([ordinaryMilk, cream], { candidatePreselector: async () => ({ verdicts: [] }) });
  const result = await fixture.tools.searchProducts.execute({ queries: ["молоко"] });
  expect(result.groups[0].products).toHaveLength(2);
  expect(result.groups[0].preselection.status).toBe("invalid");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/ai/debug-party/cart-tools.test.ts`

Expected: FAIL because `LocalCartToolsContext` lacks preselection dependencies and the output has no filtered group fields.

- [ ] **Step 3: Implement filtering and safe trace encoding**

Persist all evidence before filtering. Invoke `preselectCandidates` with saved compact evidence. On completed preselection, expose `match` entries as `products` and `partial` entries separately; persist but hide `exclude` entries. On unavailable/invalid preselection, expose all candidates with unclassified verdicts. Calculate the median from matches when available, otherwise visible candidates. Set `requiresAlternateSearch` only when completed preselection has zero matches. Extend `CatalogTraceSchema` to parse and strip only normalized intent, verdict/status and short reason fields.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm test -- src/lib/ai/debug-party/cart-tools.test.ts src/lib/ai/debug-party/catalog-trace.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit local-search integration**

Run: `git add src/lib/ai/debug-party/cart-tools.ts src/lib/ai/debug-party/cart-tools.test.ts src/lib/ai/debug-party/catalog-trace.ts src/lib/ai/debug-party/catalog-trace.test.ts && git commit -m "feat: filter ai debug catalog candidates"`

### Task 3: Wire model adapter, supervisor, debug UI and local harness

**Files:**
- Modify: `src/lib/ai/debug-party/provider.ts`
- Modify: `src/lib/ai/debug-party/supervisor.ts`
- Modify: `src/lib/ai/debug-party/supervisor.test.ts`
- Modify: `src/lib/ai/debug-party/harness.ts`
- Modify: `src/lib/ai/debug-party/harness.test.ts`
- Modify: `src/app/ai-debug/party/[code]/debug-log.tsx`
- Modify: `scripts/ai_debug_harness.py`
- Modify: `scripts/ai_debug_harness_test.py`

**Interfaces:**
- Consumes Task 1 `CandidatePreselector` and Task 2 safe search/trace result.
- Produces a JSON-object model adapter, compact planning context, match/partial main-agent rules and visible safe verdicts.
- Is used by production party runs and development-only harness runs.

- [ ] **Step 1: Write failing integration tests**

```ts
it("passes compact planning context to the candidate preselector", async () => {
  const preselector = vi.fn(async () => completedPreselection({ water: "match" }));
  await runDebugPartySupervisor(build, { ...dependencies, candidatePreselector: preselector });
  expect(preselector).toHaveBeenCalledWith(expect.objectContaining({
    request: expect.any(String), candidates: [expect.objectContaining({ evidenceId: expect.any(String) })],
  }));
  expect(JSON.stringify(preselector.mock.calls)).not.toMatch(/access_token|authorization|raw/i);
});

it("returns safe preselection verdicts from the ephemeral harness", async () => {
  const result = await runDebugHarness(input, { candidatePreselector, model, createGateway });
  expect(result.trace[0].trace?.preselection).toMatchObject({ status: "completed" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/ai/debug-party/supervisor.test.ts src/lib/ai/debug-party/harness.test.ts`

Expected: FAIL because model adapters and dependencies do not expose `candidatePreselector`.

- [ ] **Step 3: Implement model adapter and consumers**

Use the existing OpenAI-compatible provider’s JSON-object mode through a bounded `CandidatePreselector` adapter; do not add a provider or database schema. Add injectable `candidatePreselector?` dependencies to supervisor/harness. Construct `selectionContext` from the active message/intents and only dietary restrictions, favorites and recent-product names. Update main-agent instructions: when `requiresAlternateSearch` is true search again; never choose a partial while a match exists; explain a partial compromise briefly. Extend debug log and Python renderer with preselection status, normalized intent and per-candidate verdict/reason.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/lib/ai/debug-party/supervisor.test.ts src/lib/ai/debug-party/harness.test.ts && python3 -m unittest scripts/ai_debug_harness_test.py`

Expected: PASS.

- [ ] **Step 5: Run full verification and inspect diff**

Run: `npm run lint && npm test && python3 -m unittest scripts/ai_debug_harness_test.py && git diff --check`

Expected: all commands exit 0; no raw MCP/token field appears in tests/output.

- [ ] **Step 6: Commit production/developer-experience wiring**

Run: `git add src/lib/ai/debug-party/provider.ts src/lib/ai/debug-party/supervisor.ts src/lib/ai/debug-party/supervisor.test.ts src/lib/ai/debug-party/harness.ts src/lib/ai/debug-party/harness.test.ts src/app/ai-debug/party/'[code]'/debug-log.tsx scripts/ai_debug_harness.py scripts/ai_debug_harness_test.py && git commit -m "feat: preselect ai debug product candidates"`
