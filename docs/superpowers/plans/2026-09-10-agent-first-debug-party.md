# Agent-First Debug Party Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-user `/ai-debug` trace with a persistent multi-user debug party whose DeepSeek supervisor preprocesses participants through their own Silpo MCP sessions, builds and revises a verified local cart, freezes it, and deterministically sends it to the Host's Silpo cart.

**Architecture:** Keep the existing `/party` and `src/lib/ai/planning` behavior intact. Add isolated `debug_*` Supabase tables, a strict `src/lib/ai/debug-party` domain/orchestration layer, and `/ai-debug/party/[code]` UI. DeepSeek runs a bounded `ToolLoopAgent`; all MCP and local-cart operations remain server-owned, Zod-validated, revisioned, and auditable.

**Tech Stack:** Next.js 16.3.4 App Router, React 19.2.8, TypeScript 5 strict mode, Zod 4.5.4, AI SDK 7.0.93, `@ai-sdk/openai-compatible`, MCP SDK 1.30.0, Supabase Auth/Postgres/RLS, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-first-debug-party-design.md`

## Global Constraints

- UI copy is Ukrainian and mobile-first.
- Use real authenticated users and each user's real Silpo MCP connection.
- Budget is optional; when supplied, it is a hard total-party limit.
- Raw MCP responses, credentials, prompts, and reasoning content never reach the main supervisor, browser, database log, or user-visible chat.
- Products, IDs, availability, discounts, and prices must be supported by Silpo MCP evidence.
- Planning and chat may mutate only the local debug cart; only deterministic Host-only Send to Silpo may write the real Silpo cart.
- All new external inputs start as `unknown` and cross strict Zod boundaries; no `any`.
- Every server mutation re-checks auth, membership, party state, and role.
- Agent runs have explicit step, MCP-call, result-size, and wall-clock limits.
- Preserve user changes and the existing `/party` implementation.

---

## File Map

- `supabase/migrations/202609100002_agent_first_debug_party.sql`: isolated debug-party schema, indexes, RLS, grants, atomic join/finalize/revision functions.
- `src/lib/ai/debug-party/schemas.ts`: all persisted, tool-input, MCP-evidence, agent-call, and view-model Zod contracts.
- `src/lib/ai/debug-party/repository.ts`: authenticated server-side reads/writes and optimistic cart revisions.
- `src/lib/ai/debug-party/personal-agent.ts`: participant-scoped MCP collection and compact context normalization.
- `src/lib/ai/debug-party/mcp-tools.ts`: dynamic Silpo MCP discovery, safe read-only exposure, bounded output, and evidence capture.
- `src/lib/ai/debug-party/cart-tools.ts`: typed local-cart tool executors and product-evidence enforcement.
- `src/lib/ai/debug-party/provider.ts`: DeepSeek language-model factory for tool loops without changing the JSON-only planning provider.
- `src/lib/ai/debug-party/supervisor.ts`: one orchestration entry point for preprocessing, initial basket build, and chat revisions.
- `src/lib/ai/debug-party/prompts.ts`: supervisor/personal-agent instructions and compact prompt builders.
- `src/lib/ai/debug-party/send-to-silpo.ts`: deterministic frozen-snapshot validation and Host MCP sync.
- `src/lib/ai/debug-party/*.test.ts`: focused domain/orchestration tests with injected model/MCP/repository adapters.
- `src/app/ai-debug/actions.ts`: create/join/budget/intent/preprocess/build/chat/finalize/send server actions.
- `src/app/ai-debug/page.tsx`: debug landing with create and join.
- `src/app/ai-debug/join/[code]/page.tsx`: authenticated stable-link join.
- `src/app/ai-debug/party/[code]/page.tsx`: server-rendered workspace/final view.
- `src/app/ai-debug/party/[code]/workspace-client.tsx`: pending states, polling refresh, chat composer, cart and debug drawer.
- `src/app/ai-debug/page.module.css`: responsive visual system for all debug-party surfaces.
- `.env.example`: agent step/time/call limits.
- `PROJECT.md`: implementation status and operational notes after verification.

---

### Task 1: Strict debug-party contracts

**Files:**
- Create: `src/lib/ai/debug-party/schemas.ts`
- Test: `src/lib/ai/debug-party/schemas.test.ts`

**Interfaces:**
- Produces: `DebugPartySchema`, `DebugParticipantContextSchema`, `DebugProductEvidenceSchema`, `DebugCartItemSchema`, `DebugCartSnapshotSchema`, `SupervisorRequestSchema`, and inferred types.
- Consumes: Zod only.

- [ ] **Step 1: Write failing contract tests**

Cover an absent optional budget, reject a negative budget, reject a cart line without evidence, cap recent products at five, enforce a short intent, and reject unknown keys:

```ts
expect(DebugPartySchema.parse({ ...party, budgetCents: null }).budgetCents).toBeNull();
expect(() => DebugPartySchema.parse({ ...party, budgetCents: -1 })).toThrow();
expect(() => DebugCartItemSchema.parse({ ...line, evidenceId: undefined })).toThrow();
expect(() => DebugParticipantContextSchema.parse({ ...context, recentProducts: six })).toThrow();
expect(() => FoodRequestSchema.parse("x".repeat(501))).toThrow();
expect(() => DebugPartySchema.parse({ ...party, injected: true })).toThrow();
```

- [ ] **Step 2: Run the test and confirm red**

Run: `npm test -- src/lib/ai/debug-party/schemas.test.ts`

Expected: FAIL because `schemas.ts` does not exist.

- [ ] **Step 3: Implement strict bounded schemas**

Use `z.strictObject`, opaque non-empty IDs, integer cents, ISO timestamps, bounded arrays/text, and discriminated unions:

```ts
export const SupervisorRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("preprocess"), partyId: Id, participantId: Id, intentRevision: z.number().int().positive() }),
  z.strictObject({ mode: z.literal("build"), partyId: Id, actorId: Id }),
  z.strictObject({ mode: z.literal("chat"), partyId: Id, actorId: Id, messageId: Id }),
]);
```

Represent `contextStatus` as `pending | running | ready | failed`, party status as `collecting | ready | running | finalized | sent`, and evidence source as `recent_purchase | catalog_search | product_detail`.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/lib/ai/debug-party/schemas.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit contracts**

```bash
git add src/lib/ai/debug-party/schemas.ts src/lib/ai/debug-party/schemas.test.ts
git commit -m "feat: add debug party contracts"
```

### Task 2: Isolated Supabase schema and authorization

**Files:**
- Create: `supabase/migrations/202609100002_agent_first_debug_party.sql`
- Test: `src/lib/ai/debug-party/database-contract.test.ts`

**Interfaces:**
- Produces: `create_debug_party`, `join_debug_party`, `finalize_debug_party`, `advance_debug_cart_revision`; `debug_parties`, `debug_party_members`, `debug_food_intents`, `debug_participant_contexts`, `debug_chat_messages`, `debug_agent_runs`, `debug_tool_events`, `debug_product_evidence`, `debug_cart_items`, `debug_cart_snapshots`, `debug_cart_snapshot_items`, `debug_send_runs`.
- Consumes: `auth.users`, `auth.uid()` and existing Supabase Auth.

- [ ] **Step 1: Write a migration contract test**

Read the SQL as text and assert every public table enables RLS, `authenticated` grants are explicit, foreign keys have matching indexes, privileged functions revoke `PUBLIC`, and no object is created in `realtime`:

```ts
expect(sql).toContain("alter table public.debug_parties enable row level security");
expect(sql).toContain("revoke all on function public.create_debug_party");
expect(sql).not.toMatch(/create\s+(table|function).*realtime\./i);
```

- [ ] **Step 2: Run the contract test and confirm red**

Run: `npm test -- src/lib/ai/debug-party/database-contract.test.ts`

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Add tables, checks, indexes, RLS, and explicit grants**

Use UUID primary keys, `timestamptz`, integer cents, JSONB only for already-validated compact context/evidence metadata, `on delete cascade` inside a party, and `on delete restrict` for user attribution. Add checks for lifecycle enums and positive quantity. Grant member-readable tables `select` to `authenticated`; revoke direct writes to agent/cart/evidence/snapshot/run tables.

Create `public.is_debug_party_member(uuid)` as a non-exposed authorization helper following the established project pattern. `create_debug_party` and `join_debug_party` must check `auth.uid()`, normalize the eight-character code, lock the party row during joins, enforce ten members, and return the code. Revoke default execute and grant only to `authenticated`.

`finalize_debug_party` must lock the party, require Host ownership, require non-empty current cart, reject stale participant contexts, copy cart lines and recomputed totals into immutable snapshot rows, set `status='finalized'`, and return the snapshot UUID in one transaction.

- [ ] **Step 4: Verify SQL contracts and local migration when available**

Run: `npm test -- src/lib/ai/debug-party/database-contract.test.ts`

Run if Supabase CLI/local DB is configured: `npx supabase migration list --local`

Expected: tests PASS; migration list contains `202609100002`.

- [ ] **Step 5: Commit schema**

```bash
git add supabase/migrations/202609100002_agent_first_debug_party.sql src/lib/ai/debug-party/database-contract.test.ts
git commit -m "feat: persist agent debug parties"
```

### Task 3: Repository and optimistic local-cart revisions

**Files:**
- Create: `src/lib/ai/debug-party/repository.ts`
- Test: `src/lib/ai/debug-party/repository.test.ts`

**Interfaces:**
- Produces: `DebugPartyRepository`, `loadWorkspace(code, actorId)`, `startRun(input)`, `appendToolEvent(input)`, `replaceContext(input)`, `applyCartCommand(input)`, `completeRun(input)`.
- Consumes: schemas from Task 1 and Supabase server/admin clients.

- [ ] **Step 1: Write failing adapter tests**

Inject a fake persistence port. Test non-members are rejected, Host checks do not use metadata, expected revision mismatches return `{ status: "stale", currentRevision }`, and successful writes increment once.

```ts
await expect(repository.loadWorkspace("ABCDEFGH", outsiderId)).rejects.toThrow("учасник");
expect(await repository.applyCartCommand({ ...command, expectedRevision: 3 })).toEqual({ status: "stale", currentRevision: 4 });
```

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/lib/ai/debug-party/repository.test.ts`

Expected: FAIL because repository interfaces are absent.

- [ ] **Step 3: Implement repository boundaries**

Parse every database row through Task 1 schemas. Keep service-role writes in server-only functions. Use the authenticated client for member reads and RPCs, and the admin client only after the application service has checked actor membership/role. Implement cart mutations through the atomic revision RPC, returning a typed stale result rather than silently overwriting.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- src/lib/ai/debug-party/repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit repository**

```bash
git add src/lib/ai/debug-party/repository.ts src/lib/ai/debug-party/repository.test.ts
git commit -m "feat: add debug party repository"
```

### Task 4: Participant MCP collection and compact personal subagent

**Files:**
- Create: `src/lib/ai/debug-party/mcp-tools.ts`
- Create: `src/lib/ai/debug-party/personal-agent.ts`
- Create: `src/lib/ai/debug-party/prompts.ts`
- Test: `src/lib/ai/debug-party/personal-agent.test.ts`
- Modify: `src/lib/silpo/mcp.ts`

**Interfaces:**
- Produces: `collectPersonalContext({ userId, foodRequest, callBudget, mcpAdapter, normalizer }): Promise<DebugParticipantContext>` and `withDiscoveredSilpoTools(userId, operation)`.
- Consumes: existing `withSilpoMcp`, `readToolData`, Task 1 schemas, injected normalizer.

- [ ] **Step 1: Write failing participant-agent tests**

Use fake advertised tools and raw responses containing tokens/contact data. Assert the adapter calls available profile/restriction/favorite/order tools, truncates orders to the newest five, removes sensitive/contact fields, records missing order capability as unavailable, and returns only `DebugParticipantContextSchema`.

```ts
expect(context.recentProducts).toHaveLength(5);
expect(JSON.stringify(context)).not.toMatch(/access_token|phone|address|raw receipt/i);
expect(noOrders.purchaseHistoryStatus).toBe("unavailable");
```

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/lib/ai/debug-party/personal-agent.test.ts`

Expected: FAIL because the collector is absent.

- [ ] **Step 3: Implement dynamic capability mapping and bounded extraction**

Extend `src/lib/silpo/mcp.ts` with a server-only discovery callback that exposes the existing MCP client and actual advertised schemas without leaking the access token. Map advertised names/descriptions into allowlisted semantic roles: profile, restrictions, favorites, orders/purchases. Never synthesize a missing name. Call only read-only tools and enforce `callBudget`.

The deterministic extractor must cap visited nodes, response bytes, strings, and arrays before the normalizer sees them. Pass the normalizer a compact `PersonalSignalsSchema`, not raw MCP output. Merge deterministic allergies/restrictions back after normalization so model output cannot remove them.

- [ ] **Step 4: Run personal-agent and existing planning tests**

Run: `npm test -- src/lib/ai/debug-party/personal-agent.test.ts src/lib/ai/planning/context.test.ts src/lib/ai/planning/normalization.test.ts`

Expected: PASS with no regression.

- [ ] **Step 5: Commit personal preprocessing**

```bash
git add src/lib/silpo/mcp.ts src/lib/ai/debug-party/mcp-tools.ts src/lib/ai/debug-party/personal-agent.ts src/lib/ai/debug-party/prompts.ts src/lib/ai/debug-party/personal-agent.test.ts
git commit -m "feat: preprocess debug participants with silpo mcp"
```

### Task 5: Verified Silpo evidence and local-cart tools

**Files:**
- Create: `src/lib/ai/debug-party/cart-tools.ts`
- Test: `src/lib/ai/debug-party/cart-tools.test.ts`
- Modify: `src/lib/silpo/cart.ts`

**Interfaces:**
- Produces: `createLocalCartTools(context): ToolSet`; commands `inspectCart`, `searchProducts`, `inspectProduct`, `compareAlternatives`, `addProduct`, `replaceProduct`, `setQuantity`, `removeProduct`, `complete`.
- Consumes: Host-scoped read-only MCP adapter, repository, cart/evidence Zod schemas.

- [ ] **Step 1: Write failing tool tests**

Test search persists bounded evidence, add/replace reject unknown product IDs, live discounted prior purchases rank ahead of other previous products, catalog results rank only after suitable previous products, and stale writes return current cart state.

```ts
await expect(tools.addProduct.execute({ evidenceId: "invented", quantity: 1, expectedRevision: 2 })).rejects.toThrow("verified");
expect(rankCandidates([catalog, prior, discountedPrior])[0].id).toBe(discountedPrior.id);
```

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/lib/ai/debug-party/cart-tools.test.ts`

Expected: FAIL because tools do not exist.

- [ ] **Step 3: Implement evidence-backed tools**

Refactor only reusable read operations from `src/lib/silpo/cart.ts`; preserve existing exports. Convert relevant Host MCP catalog/product/price/promotion capabilities into bounded application tools. Persist evidence with observation time and run ID. Require `evidenceId`, `quantity`, and `expectedRevision` for add/replace. Quantity/remove commands require a current cart-item ID and expected revision.

Do not expose Silpo add/remove-cart MCP tools to this registry. Return compact tool results with IDs, labels, prices, discount flags, availability, and revision—never raw payloads.

- [ ] **Step 4: Run cart tool and legacy cart tests**

Run: `npm test -- src/lib/ai/debug-party/cart-tools.test.ts src/lib/ai/planning/meal-proposal.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit tools**

```bash
git add src/lib/ai/debug-party/cart-tools.ts src/lib/ai/debug-party/cart-tools.test.ts src/lib/silpo/cart.ts
git commit -m "feat: add verified local cart tools"
```

### Task 6: DeepSeek tool-loop provider and unified supervisor

**Files:**
- Create: `src/lib/ai/debug-party/provider.ts`
- Create: `src/lib/ai/debug-party/supervisor.ts`
- Test: `src/lib/ai/debug-party/provider.test.ts`
- Test: `src/lib/ai/debug-party/supervisor.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `createDebugPartyModel(environment)`, `runDebugPartySupervisor(request, dependencies): Promise<SupervisorResult>`.
- Consumes: `ToolLoopAgent`, `isStepCount`, personal agent, cart tools, repository, Task 1 schemas.

- [ ] **Step 1: Write failing provider and supervisor tests**

Assert DeepSeek config is required, existing model defaults remain unchanged, preprocess mode must dispatch the personal agent, build mode refuses stale/missing contexts, chat mode exposes the same cart tools, short final responses are enforced, and step/tool/time limits stop cleanly.

```ts
expect(result.reply.length).toBeLessThanOrEqual(240);
expect(fakePersonalAgent).toHaveBeenCalledWith(expect.objectContaining({ participantId }));
expect(fakeAgent.activeTools).not.toContain("writeSilpoCart");
```

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/lib/ai/debug-party/provider.test.ts src/lib/ai/debug-party/supervisor.test.ts`

Expected: FAIL because provider/supervisor are absent.

- [ ] **Step 3: Implement the bounded ToolLoopAgent**

Create a DeepSeek OpenAI-compatible language model without the JSON-only `response_format` transform used by the old planner. Build `ToolLoopAgent` with stable tool ordering, `stopWhen: isStepCount(limit)`, an `AbortSignal.timeout`, typed runtime context, and callbacks that persist sanitized run/tool events.

`runDebugPartySupervisor` parses the request, loads authorized state, chooses active tools by mode, and invokes:

```ts
agent.generate({
  prompt: buildSupervisorPrompt(compactState),
  timeout: { totalMs: limits.totalMs, stepMs: limits.stepMs },
});
```

Preprocess mode makes `prepareParticipantContext` mandatory. Build/chat modes receive compact ready contexts and Host-scoped read-only Silpo/cart tools. The system prompt requires tool evidence before every add/replace and requires `complete` with a short Ukrainian reply. Never persist or emit reasoning content.

Add exact env defaults: `AI_DEBUG_MAX_STEPS=20`, `AI_DEBUG_MAX_MCP_CALLS=40`, `AI_DEBUG_TOTAL_TIMEOUT_MS=90000`, `AI_DEBUG_TOOL_TIMEOUT_MS=15000`.

- [ ] **Step 4: Run supervisor and legacy provider tests**

Run: `npm test -- src/lib/ai/debug-party/provider.test.ts src/lib/ai/debug-party/supervisor.test.ts src/lib/ai/planning/provider.test.ts src/lib/ai/planning/agent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit supervisor**

```bash
git add src/lib/ai/debug-party/provider.ts src/lib/ai/debug-party/supervisor.ts src/lib/ai/debug-party/provider.test.ts src/lib/ai/debug-party/supervisor.test.ts .env.example
git commit -m "feat: orchestrate debug parties with deepseek"
```

### Task 7: Deterministic frozen-snapshot Send to Silpo

**Files:**
- Create: `src/lib/ai/debug-party/send-to-silpo.ts`
- Test: `src/lib/ai/debug-party/send-to-silpo.test.ts`

**Interfaces:**
- Produces: `sendFrozenDebugCart({ code, actorId, confirmChanges }, dependencies): Promise<SendResult>`.
- Consumes: frozen snapshot schemas, repository, Host MCP cart adapter.

- [ ] **Step 1: Write failing deterministic-send tests**

Test non-Host rejection, non-finalized rejection, immutable snapshot input, availability/price revalidation, material-change confirmation, idempotent retry, and partial external failure reconciliation. Assert no model provider dependency exists.

```ts
await expect(send({ actorId: memberId })).rejects.toThrow("Організатор");
expect(await send({ actorId: hostId, confirmChanges: false })).toMatchObject({ status: "confirmation_required" });
```

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/lib/ai/debug-party/send-to-silpo.test.ts`

Expected: FAIL because sender is absent.

- [ ] **Step 3: Implement deterministic synchronization**

Load and parse the frozen snapshot, validate Host/state/idempotency, inspect current Host cart and current product details, calculate price/availability differences, and require explicit confirmation for changed lines. Reuse low-level Silpo cart mutation helpers without invoking DeepSeek. Record per-line results and reconcile the real cart before retrying an incomplete send.

- [ ] **Step 4: Run deterministic-send tests**

Run: `npm test -- src/lib/ai/debug-party/send-to-silpo.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit sender**

```bash
git add src/lib/ai/debug-party/send-to-silpo.ts src/lib/ai/debug-party/send-to-silpo.test.ts
git commit -m "feat: send frozen debug carts to silpo"
```

### Task 8: Authenticated server actions and stable join routes

**Files:**
- Replace: `src/app/ai-debug/actions.ts`
- Modify: `src/app/ai-debug/page.tsx`
- Create: `src/app/ai-debug/join/[code]/page.tsx`
- Create: `src/app/ai-debug/party/[code]/page.tsx`
- Test: `src/app/ai-debug/actions.test.ts`

**Interfaces:**
- Produces server actions: `createDebugParty`, `joinDebugParty`, `saveDebugBudget`, `submitFoodRequest`, `preprocessParticipant`, `buildDebugBasket`, `sendDebugMessage`, `finalizeDebugParty`, `sendDebugCartToSilpo`.
- Consumes repository, supervisor, deterministic sender, `requireUser`, Next.js `redirect`/`revalidatePath`.

- [ ] **Step 1: Write failing action tests**

Inject service functions. Test eight-character code normalization, optional empty budget, Host-only build/finalize/send, one short combined food request, Continue invoking preprocess, and redirect paths preserving the invite code.

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/app/ai-debug/actions.test.ts`

Expected: FAIL against the old single-user debug action.

- [ ] **Step 3: Implement thin authenticated actions and server pages**

Every action starts with `requireUser()`, parses `FormData` through Zod, then calls one application service. Keep model/MCP/domain logic out of action files. Landing renders create/join forms; join page calls capacity-safe join for authenticated users; party page loads an RLS-protected workspace and chooses intake/workspace/final rendering.

Use async Next.js 16 route params:

```ts
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // authorized load
}
```

- [ ] **Step 4: Run action tests and lint changed routes**

Run: `npm test -- src/app/ai-debug/actions.test.ts`

Run: `npx eslint src/app/ai-debug src/lib/ai/debug-party`

Expected: PASS.

- [ ] **Step 5: Commit routes/actions**

```bash
git add src/app/ai-debug/actions.ts src/app/ai-debug/page.tsx src/app/ai-debug/join src/app/ai-debug/party src/app/ai-debug/actions.test.ts
git commit -m "feat: add multi-user ai debug party routes"
```

### Task 9: Mobile-first shared workspace and debug UX

**Files:**
- Create: `src/app/ai-debug/party/[code]/workspace-client.tsx`
- Replace: `src/app/ai-debug/debug-form.tsx`
- Modify: `src/app/ai-debug/page.module.css`
- Create: `src/lib/ai/debug-party/ui-state.ts`
- Test: `src/lib/ai/debug-party/ui-state.test.ts`

**Interfaces:**
- Produces: intake, preprocessing, shared chat/cart, debug drawer, and final snapshot UI states.
- Consumes: server actions from Task 8 and validated workspace view model.

- [ ] **Step 1: Extend pure UI-state tests**

Add state cases for pending/running/failed/ready context, queued/running chat turn, stale cart, finalized snapshot, confirmation-required send, and sent. Assert action labels and disabled states, not CSS snapshots.

- [ ] **Step 2: Run and confirm red**

Run: `npm test -- src/lib/ai/debug-party/ui-state.test.ts`

Expected: FAIL for unimplemented states.

- [ ] **Step 3: Build the responsive UI**

Use the existing visual language but clearly label the surface `AI Debug Party`. Provide copyable code/link, example-intent chips, one text field, MCP connection status, explicit preprocessing stages, member readiness row, compact chat, prominent cart, sticky Host actions, and a collapsible filtered debug drawer.

Use `useActionState` for expected errors/pending labels. Poll with `router.refresh()` every three seconds while the page is visible and a party/run is active; stop after final/sent and refresh on visibility regain. Render the user's chat message immediately, but render cart rows only from confirmed server state.

Never render raw tool output or reasoning. Debug entries show timestamp, participant/run, tool name, status, duration, counts, and safe error text.

- [ ] **Step 4: Run UI state tests and lint**

Run: `npm test -- src/lib/ai/debug-party/ui-state.test.ts`

Run: `npx eslint src/app/ai-debug src/lib/ai/debug-party/ui-state.ts`

Expected: PASS.

- [ ] **Step 5: Commit UI**

```bash
git add src/app/ai-debug src/lib/ai/debug-party/ui-state.ts src/lib/ai/debug-party/ui-state.test.ts
git commit -m "feat: build agent first debug party ui"
```

### Task 10: End-to-end safety regression and documentation

**Files:**
- Create: `src/lib/ai/debug-party/flow.test.ts`
- Modify: `PROJECT.md`
- Modify: `README.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces verified implementation notes and setup sequence.

- [ ] **Step 1: Add an injected end-to-end flow test**

Simulate Host creation, member join, both personal MCP preprocessors, optional-budget build, evidence-backed add, participant command `знайди дешевший сир`, revision update, Host finalization, and deterministic send. Assert raw MCP secrets never appear in supervisor input, stored events, UI messages, or serialized workspace.

- [ ] **Step 2: Run the end-to-end test**

Run: `npm test -- src/lib/ai/debug-party/flow.test.ts`

Expected: PASS after Tasks 1–9.

- [ ] **Step 3: Update operational documentation**

Document the migration order, required DeepSeek variables, participant Silpo connection requirement, agent limits, non-expiring debug links, polling behavior, local-cart separation, and deterministic Host send. Mark the agent-first debug flow implemented in `PROJECT.md` only after all verification passes.

- [ ] **Step 4: Run complete verification**

Run in order:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all commands exit 0. If the Supabase local environment is available, also apply the migration and test Host/member/non-member RLS plus concurrent join/finalize transactions.

- [ ] **Step 5: Review diff and commit**

Run: `git diff --check`

Run: `git status --short`

Confirm only intended files are changed, then:

```bash
git add PROJECT.md README.md src/lib/ai/debug-party/flow.test.ts
git commit -m "docs: verify agent first debug party"
```
