# Participant Context Preprocessing Design

## Goal

Prevent raw or oversized Silpo MCP responses from entering the group-planning
model. Normalize each participant independently into a compact, validated food
context, then plan from only those contexts, event intents, and the Host budget.

## Scope

This change is limited to the AI planning module, its server-side provider
configuration, tests, and documentation. It does not modify frontend surfaces,
event/room behavior, OAuth, or database persistence. Supabase changes are
allowed if a concrete security, freshness, or caching requirement appears, but
none are needed for the request-scoped MVP pipeline.

## Provider choice

Production uses Alibaba Cloud Model Studio directly through its OpenAI-compatible
international DashScope endpoint. The default model for both semantic
normalization and group planning is `qwen3.8-flash`.

Provider construction lives in one server-only module. Planning and
normalization depend on injected AI SDK language models or generation adapters,
not Alibaba-, Google-, or OpenAI-specific SDK calls. Environment configuration:

- `AI_PROVIDER=alibaba`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_NORMALIZER_MODEL=qwen3.8-flash`
- `AI_PLANNER_MODEL=qwen3.8-flash`

## Data flow

For every event participant:

1. The backend loads that participant's Silpo data through their own MCP session.
2. The collector accepts only relevant tools and treats the external result as
   `unknown` at the transport edge.
3. Deterministic preprocessing parses JSON content, removes sensitive and
   irrelevant fields, extracts known food signals, deduplicates them, and
   enforces item and text limits.
4. If bounded fragments remain semantically ambiguous, the participant
   normalizer model converts those fragments into the strict context schema.
5. Deterministic and model-derived facts are merged and parsed as one
   `UserFoodContext`.

After every participant has a normalized result, the planner receives one
`GroupPlanningInput` containing event metadata, Host budget, participant food
intents, and compact `UserFoodContext` objects. It never receives raw MCP tool
results or a tool capable of loading them.

The pipeline may preprocess a maximum of three participants concurrently. A
failure is isolated to that participant and becomes explicit partial or
unavailable context. Missing information never means no restrictions.

## MCP collection policy

Ordinary planning uses only:

- `silpo_get_my_food_restrictions`
- `silpo_get_my_favorites`

The generic profile tool is excluded because its documented fields are personal
identity/contact data rather than food-planning context. Orders, purchase
history, promotions, product details, addresses, loyalty data, and full catalogs
are not collected. Future recurring purchase-pattern support requires a separate
approved change and deterministic aggregation before any LLM input.

## Schema boundaries

`ParticipantFoodSignalsSchema` is the first internal boundary after external MCP
data. It is strict and bounded:

- participant ID;
- extracted restrictions;
- extracted favorites;
- bounded ambiguous food fragments;
- compact evidence records;
- completeness state.

`UserFoodContextSchema` is the only participant context accepted by group
planning:

- participant ID;
- hard constraints;
- soft preferences;
- dislikes;
- useful food patterns;
- missing-information descriptions;
- completeness state;
- compact source evidence;
- a summary of at most 500 characters.

Every collection has a maximum item count. All text is trimmed, non-empty, and
length-limited. Source evidence contains only a generated reference ID, source
kind, optional retrieval time, and optional source field path. It contains no raw
payload excerpt.

`GroupPlanningInputSchema` contains event metadata, Host, budget, and one entry
per participant with food intent and `UserFoodContext`. Refinements enforce a
maximum of ten participants, unique IDs, Host membership, and matching
participant/context IDs.

`GroupMealPlanSchema` remains the strict planning output contract for dishes,
eaters, conflicts, Host approval proposals, participant insights,
hard-constraint checks, and concise UI summaries.

## Deterministic and semantic normalization

Deterministic preprocessing is always attempted first. It:

- accepts only allowlisted tool names;
- prefers `structuredContent`, otherwise parses bounded JSON text blocks;
- recursively rejects sensitive keys;
- keeps only values under food-related keys;
- caps nesting, strings, fragments, favorites, and restrictions;
- deduplicates normalized labels without inventing meaning.

If all extracted facts are unambiguous, no normalizer model is called. When
ambiguous food-related fragments remain, only the bounded signal object is sent
to the normalizer. The normalizer cannot access MCP tools and must return
`UserFoodContextSchema`. Its output is parsed and merged with declared hard
constraints so model output cannot remove them.

## Main planner

The main planner has no participant-context tool. Its prompt contains only the
validated `GroupPlanningInput`. It plans globally across all participants rather
than creating and concatenating per-person plans.

The existing deterministic safety validator continues to reject invalid
references, incomplete hard-constraint coverage, uncertain compatibility, and
unsafe eater assignments.

## Errors and privacy

Errors distinguish collection, normalization, provider, structured-output, and
safety failures. Participant collection/normalization failures remain visible as
context status and missing information. A provider or invalid-output failure for
the main planner fails the planning request.

Raw MCP payloads exist only within preprocessing call scope. Traces contain only
participant ID, status, source names, counts, and failure reason. Production
errors and logs must not include raw payloads, prompts, contact details, tokens,
addresses, or food-context text.

## Verification

Tests cover strict schemas and limits, sensitive-field removal, tool allowlisting,
deterministic extraction, conditional semantic normalization, participant
isolation, bounded concurrency, unavailable contexts, provider injection, proof
that the main planner receives no raw MCP data, structured plan parsing, and the
existing deterministic safety checks. Final verification runs unit tests, lint,
TypeScript checking, and the production build.
