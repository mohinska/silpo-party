# Gemini Event Planning Agent Implementation Plan (Superseded)

> Superseded on 2026-09-09 by
> `docs/superpowers/plans/2026-09-09-participant-context-preprocessing.md`.
> This file is retained only as implementation history for the original Gemini
> foundation.

> **For agentic workers:** Execute inline with strict red-green TDD. Do not
> modify party-management, auth, database, or Supabase query code.

**Goal:** Build an isolated Gemini planning agent with participant-scoped Silpo
context tools, fail-closed allergy validation, and a temporary authenticated
debug page.

**Architecture:** The backend-facing module validates an in-memory event,
exposes an injected participant-context loader as an AI SDK tool, runs one
multi-step Gemini planning call, parses Zod structured output, and applies a
deterministic safety audit. The temporary page adapts the current authenticated
user and existing Silpo MCP helper to that contract without persisting data.

**Tech Stack:** TypeScript, Zod, AI SDK 7, `@ai-sdk/google`, Vitest, Next.js 16
App Router.

**Spec:** `src/lib/ai/planning/DESIGN.md`

## Global Constraints

- Work only in `src/lib/ai/planning`, except dependency/env metadata and the
  explicitly approved temporary `src/app/ai-debug` route.
- Do not change auth, party management, database schema, Supabase queries, or
  existing Silpo integration code.
- Do not add cart writes, persistence, package optimization, ingredient merging,
  or ingredient arithmetic.
- Treat missing personal context as unknown, never as no restrictions.
- Reject any returned eater assignment without a safe check for every allergy
  and hard restriction.
- Use `GEMINI_API_KEY` and default `GEMINI_MODEL` to `gemini-3.8-flash`.

---

### Task 1: Test harness and typed schemas

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/ai/planning/schemas.test.ts`
- Create: `src/lib/ai/planning/schemas.ts`

**Interfaces:**

- Produces `EventPlanningInputSchema`, `EventPlanSchema`, and their inferred
  TypeScript types.

- [ ] Install direct runtime dependencies `@ai-sdk/google` and `zod`, plus the
  Vitest development dependency and a focused `test` script.
- [ ] Write schema tests that accept a complete event and reject duplicate
  participant IDs, unknown hosts, malformed recipe URLs, and invalid servings.
- [ ] Run the focused test and confirm it fails because schemas do not exist.
- [ ] Implement schemas and cross-field refinements.
- [ ] Run the focused test and confirm it passes.

### Task 2: Deterministic safety audit

**Files:**

- Create: `src/lib/ai/planning/safety.test.ts`
- Create: `src/lib/ai/planning/safety.ts`
- Create: `src/lib/ai/planning/errors.ts`

**Interfaces:**

- Produces `assertEventPlanSafety(input: EventPlanningInput, plan: EventPlan)`.
- Produces `PlanningSafetyError` with machine-readable issues.

- [ ] Write tests proving safe plans pass and missing, uncertain, conflicting,
  duplicated, or foreign participant checks fail.
- [ ] Run the focused test and confirm the missing implementation failure.
- [ ] Implement reference, serving, and full hard-constraint coverage checks.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Participant-scoped tool and global prompt

**Files:**

- Create: `src/lib/ai/planning/context.ts`
- Create: `src/lib/ai/planning/context.test.ts`
- Create: `src/lib/ai/planning/prompt.ts`
- Create: `src/lib/ai/planning/prompt.test.ts`

**Interfaces:**

- Produces `ParticipantContextLoader`, `ParticipantContextResult`,
  `createParticipantContextTool`, and `buildPlanningPrompt`.

- [ ] Write tests proving the tool allows only current-event participant IDs,
  returns explicit unavailable states, records a redacted trace, and never
  interprets missing data as unrestricted.
- [ ] Write a behavioral prompt test through the prompt builder's public output
  covering one global plan, context collection, hard constraints, and excluded
  future optimization work.
- [ ] Run the focused tests and confirm expected missing-module failures.
- [ ] Implement the loader contract, scoped tool, trace, and English prompt.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Gemini orchestration and public API

**Files:**

- Create: `src/lib/ai/planning/agent.test.ts`
- Create: `src/lib/ai/planning/agent.ts`
- Create: `src/lib/ai/planning/index.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces `planEvent(input, options): Promise<PlanningResult>`.
- `options` accepts a participant loader and an injectable generation function;
  production defaults use the Google provider.

- [ ] Write tests showing invalid input prevents model execution, structured
  output is safety-audited, trace is returned, and unsafe output throws.
- [ ] Run the focused test and confirm the missing implementation failure.
- [ ] Configure `createGoogleGenerativeAI` with `GEMINI_API_KEY`, use
  `GEMINI_MODEL ?? "gemini-3.8-flash"`, attach the scoped tool, bound the tool
  loop, and request `Output.object({ schema: EventPlanSchema })`.
- [ ] Export the clean module contract and document server-only env variables.
- [ ] Run all planning tests and confirm they pass.

### Task 5: Temporary authenticated debug harness

**Files:**

- Create: `src/lib/ai/planning/debug.ts`
- Create: `src/lib/ai/planning/debug.test.ts`
- Create: `src/app/ai-debug/actions.ts`
- Create: `src/app/ai-debug/debug-form.tsx`
- Create: `src/app/ai-debug/page.tsx`
- Create: `src/app/ai-debug/page.module.css`

**Interfaces:**

- Produces a temporary `/ai-debug` route using existing `requireUser` and
  `getPersonalSilpoContext` without modifying either module.

- [ ] Write tests proving recursive redaction removes token/secret-like fields
  from debug payloads while preserving ordinary Silpo context.
- [ ] Run the focused test and confirm the missing implementation failure.
- [ ] Implement redaction and a server action that re-checks authentication,
  allows only the current user's synthetic participant ID, runs `planEvent`, and
  returns serializable debug state.
- [ ] Build the small responsive debug form showing MCP payload, trace, plan,
  conflicts, and actionable errors; do not add global styles.
- [ ] Run planning tests and ESLint.

### Task 6: Final verification

**Files:** No new files.

- [ ] Run `npm test` and read the complete result.
- [ ] Run `npm run lint` and read the complete result.
- [ ] Run `npm run build` and read the complete result.
- [ ] Run `git diff --check` and review the scoped diff plus worktree status.
- [ ] Report any live-test prerequisites without claiming an unrun Gemini/MCP
  integration test.
