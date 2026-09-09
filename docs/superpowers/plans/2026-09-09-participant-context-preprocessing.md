# Participant Context Preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize each participant's Silpo MCP data into a compact strict context before one provider-isolated group-planning call.

**Architecture:** A deterministic, bounded parser handles supported MCP results first and invokes a semantic normalizer only for ambiguous food fragments. The group planner receives only `GroupPlanningInputSchema` and uses an injected provider model, defaulting to Alibaba Model Studio `qwen3.8-flash`.

**Tech Stack:** TypeScript, Zod 4, Vercel AI SDK 7, `@ai-sdk/openai-compatible`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-participant-context-preprocessing-design.md`

## Global Constraints

- Never send raw MCP responses to either the main planner or production traces.
- Use only Silpo restrictions and favorites for ordinary participant context.
- Preserve missing information explicitly; missing never means unrestricted.
- Default to direct Alibaba Model Studio and `qwen3.8-flash`, behind dependency injection.
- Do not modify frontend or event/room backend behavior.
- Do not add Supabase persistence for request-scoped normalized context.

---

### Task 1: Strict participant and group schemas

**Files:**
- Modify: `src/lib/ai/planning/schemas.ts`
- Modify: `src/lib/ai/planning/schemas.test.ts`

**Interfaces:**
- Produces: `ParticipantFoodSignalsSchema`, `UserFoodContextSchema`, `GroupPlanningInputSchema`, and inferred types.
- Preserves: `EventPlanningInputSchema` as the backend-facing raw event contract and `EventPlanSchema` as the plan output contract.

- [ ] Add failing tests for strict unknown-key rejection, text/item limits, matching participant/context IDs, unique IDs, Host membership, and the ten-person maximum.
- [ ] Run `npm test -- src/lib/ai/planning/schemas.test.ts` and confirm the new exports/tests fail.
- [ ] Add bounded strict signal, evidence, normalized context, and group input schemas with cross-field refinements.
- [ ] Re-run the focused schema tests and confirm they pass.

### Task 2: Deterministic MCP preprocessing

**Files:**
- Create: `src/lib/ai/planning/normalization.ts`
- Create: `src/lib/ai/planning/normalization.test.ts`
- Replace: `src/lib/ai/planning/context.ts`
- Modify: `src/lib/ai/planning/context.test.ts`

**Interfaces:**
- Consumes: `ParticipantFoodSignals`, `UserFoodContext`, and the existing `ParticipantContextLoader` result.
- Produces: `extractParticipantFoodSignals(participantId, rawResult)`, `normalizeParticipantContext(request, adapter?)`, and metadata-only `ParticipantContextTraceEntry`.

- [ ] Add failing tests with representative MCP `content` and `structuredContent` results, sensitive keys, oversized arrays/text, duplicate facts, unsupported tools, deterministic-only data, and ambiguous fragments.
- [ ] Run the two focused test files and confirm failures.
- [ ] Implement allowlisted parsing, bounded JSON decoding, sensitive-field filtering, deterministic extraction/deduplication, and compact evidence.
- [ ] Implement optional `ParticipantNormalizationAdapter`; call it only when ambiguous fragments exist and always re-parse/merge its result with declared constraints.
- [ ] Replace raw-data traces with source/count/status metadata and update context access tests.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Provider-isolated Qwen generation

**Files:**
- Create: `src/lib/ai/planning/provider.ts`
- Create: `src/lib/ai/planning/provider.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `PlanningModelProvider`, `createConfiguredPlanningProvider()`, `participantNormalizerModel()`, and `groupPlannerModel()`.
- Configuration: `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_NORMALIZER_MODEL`, `AI_PLANNER_MODEL`.

- [ ] Add failing tests for missing configuration, unsupported providers, default Qwen model IDs, and injected provider behavior.
- [ ] Run the focused provider tests and confirm failures.
- [ ] Install the AI SDK OpenAI-compatible provider package with npm.
- [ ] Implement a server-only Alibaba-compatible provider factory with structured outputs enabled.
- [ ] Update `.env.example` without inserting real credentials.
- [ ] Re-run provider tests and confirm they pass.

### Task 4: Preprocess before global planning

**Files:**
- Modify: `src/lib/ai/planning/agent.ts`
- Modify: `src/lib/ai/planning/prompt.ts`
- Modify: `src/lib/ai/planning/agent.test.ts`
- Modify: `src/lib/ai/planning/index.ts`

**Interfaces:**
- Consumes: `ParticipantContextLoader`, `ParticipantNormalizationAdapter`, and `PlanningModelProvider`.
- Produces: `planEvent(rawInput, options)` returning `EventPlan` plus metadata-only context trace.

- [ ] Replace tool-loop tests with failing tests proving every participant is normalized first, unavailable results remain explicit, no raw MCP fields reach `generatePlan`, participant normalization is isolated, and concurrency never exceeds three.
- [ ] Run the focused agent tests and confirm failures.
- [ ] Refactor `planEvent` to collect and normalize participant contexts before generation, parse `GroupPlanningInputSchema`, and pass only that value to the main adapter.
- [ ] Remove the main planner's MCP tool and context-collection assertion; retain output parsing and deterministic safety validation.
- [ ] Update prompts and public exports for Qwen-neutral terminology and compact input.
- [ ] Re-run focused agent and safety tests and confirm they pass.

### Task 5: Keep the server debug adapter compatible without frontend changes

**Files:**
- Modify: `src/app/ai-debug/actions.ts`
- Modify: `src/lib/ai/planning/debug.ts`
- Modify: `src/lib/ai/planning/debug.test.ts`

**Interfaces:**
- Consumes: the unchanged `getPersonalSilpoContext(userId)` MCP helper and new metadata-only planning trace.
- Produces: the existing `DebugPlanningState` shape without raw MCP data.

- [ ] Add/update failing debug tests asserting errors and trace data do not contain raw payloads or provider-specific wording.
- [ ] Run the focused debug tests and confirm failures.
- [ ] Adapt only the server action/helper to the new loader and trace contract; do not edit TSX or CSS.
- [ ] Re-run debug tests and confirm they pass.

### Task 6: Documentation and full verification

**Files:**
- Modify: `src/lib/ai/planning/DESIGN.md`
- Modify: `PROJECT.md`

**Interfaces:**
- Documents: approved preprocessing architecture, Qwen provider choice, privacy boundaries, and implementation status.

- [ ] Replace obsolete Gemini/raw-tool architecture statements with the implemented preprocessing flow and provider-neutral contract.
- [ ] Add the approved architecture decision to `PROJECT.md` without changing unrelated product decisions.
- [ ] Run `npm test` and confirm all tests pass.
- [ ] Run `npm run lint` and confirm it passes.
- [ ] Run `npx tsc --noEmit` and confirm it passes.
- [ ] Run `npm run build` and confirm the production build succeeds.
