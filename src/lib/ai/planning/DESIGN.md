# Event Planning Agent Design

## Scope

The module builds one event-level food plan with Gemini. It does not read or
write the application database, manage rooms or permissions, write carts,
select product packages, merge ingredients across dishes, or persist results.

The backend owns event membership, authorization, OAuth token lookup, and MCP
client creation. It passes validated event data plus a callback that can fetch
personal Silpo context for one participant at a time.

## Public contract

The module exports:

- `EventPlanningInputSchema` and `EventPlanningInput`
- `EventPlanSchema` and `EventPlan`
- `ParticipantContextLoader`
- `planEvent(input, options)`
- typed planning and safety errors

`planEvent` accepts event metadata, host, budget, participants, their declared
preferences and restrictions, and food intent. A participant can optionally
arrive with already-resolved Silpo context. When it is absent, the agent may use
the participant context tool backed by `ParticipantContextLoader`.

The loader receives only a participant ID and returns curated personal context
or an explicit unavailable result. The AI module never receives OAuth tokens
and never queries Supabase directly.

## Input model

Event metadata contains an opaque event ID, title, optional description,
ISO-8601 start time, locale, and optional meal notes. The host is represented
by a participant ID and display name. Budget contains a positive amount and an
ISO 4217 currency code.

Each participant contains:

- opaque ID and display name;
- allergies, always treated as hard constraints;
- dietary restrictions with `hard` or `preference` strength;
- likes, dislikes, cuisines, and free-form notes;
- one food intent: no preference, a requested dish, or a recipe URL with
  optional extracted recipe text;
- optional curated Silpo profile, food restrictions, and favorites;
- context completeness: `complete`, `partial`, or `unknown`.

A missing field never means that the participant has no restrictions. A bare
recipe URL is not treated as recipe content because the planning agent has no
web-fetching responsibility.

## MCP context collection

The Gemini call receives a single AI SDK tool named
`get_participant_silpo_context`. Its input is a participant ID constrained to
the IDs in the current event. Its executor calls the injected
`ParticipantContextLoader`.

The prompt requires Gemini to inspect the whole event first, request missing
Silpo context for every eligible participant, and only then produce one global
plan. Already-provided context is not fetched again. A failed or unavailable
lookup is represented explicitly and does not get interpreted as an absence of
restrictions.

The eventual backend adapter is responsible for mapping a participant ID to
that participant's authenticated Silpo MCP client and invoking the allowed
`silpo_get_my_profile`, `silpo_get_my_food_restrictions`, and
`silpo_get_my_favorites` functions.

## Structured plan

Gemini returns a Zod-constrained object containing:

- overall status: `ready`, `needs_input`, or `blocked`;
- dishes with stable plan-local IDs, eater participant IDs, servings, and a
  per-dish ingredient list;
- conflicts with affected participants/dishes, severity, and status;
- proposed resolutions linked to conflicts, including whether host approval or
  participant input is required;
- short event-level and dish-level reasoning summaries suitable for UI display;
- hard-constraint checks for every proposed eater and every applicable allergy
  or hard dietary restriction.

Ingredients remain scoped to their dish. Amounts may only be copied as source
text supplied in the event context; the module does not calculate quantities or
merge equivalent ingredients.

## Hard-restriction safety

Safety is fail-closed and has two layers:

1. The system prompt forbids assigning an eater to a dish that violates or has
   uncertain compatibility with an allergy or hard restriction.
2. A deterministic post-generation validator verifies participant references,
   servings, and complete hard-constraint coverage for every eater.

Every required check must be `safe` and include a short explanation. A missing,
`uncertain`, or `conflict` check makes the structured result invalid and raises
a typed safety error. The result is never silently returned as a usable plan.
The caller may ask for more participant information and run planning again.

Because free-form ingredient names cannot prove medical safety by string
matching, the validator verifies explicit coverage rather than pretending to
perform medical ingredient classification.

## Gemini orchestration

The implementation uses AI SDK `generateText`, Gemini through
`@ai-sdk/google`, MCP-style AI SDK tools, a bounded multi-step tool loop, and
`Output.object({ schema: EventPlanSchema })`.

The model is configured by `GEMINI_MODEL` and defaults to
`gemini-3.8-flash`. The Google provider receives the server-side API key
explicitly from `GEMINI_API_KEY`; neither value is exposed through a
`NEXT_PUBLIC_` variable. Tests inject the model call and participant loader, so
they do not require network access or real credentials.

## Error handling

The public function distinguishes:

- invalid backend input;
- unavailable participant context;
- model/provider or structured-output failure;
- invalid participant/dish references;
- hard-restriction safety failure.

MCP context failures are disclosed to Gemini and must appear as missing context
or conflicts in the plan. Secrets and raw OAuth data never appear in prompts,
outputs, or errors.

## Temporary authenticated debug page

Until the event backend is available, `/ai-debug` provides an explicitly
temporary, single-participant integration harness. It requires the existing
authenticated user, constructs an in-memory event, and injects a loader that
can only resolve that user's participant ID through the existing Silpo MCP
helper.

The page displays the redacted MCP payload returned to the agent, the curated
participant context used for planning, tool execution trace, structured plan,
and explicit errors. It performs no writes and never renders OAuth tokens or
server environment values. Its source is isolated under the `ai-debug` route so
it can be deleted without affecting the production agent contract.

## Verification

Tests cover schema acceptance/rejection, tool participant isolation, global
prompt requirements, output reference integrity, full hard-constraint coverage,
rejection of unsafe or uncertain eater assignments, and debug-data redaction.
TypeScript compilation, ESLint, and the production build provide integration
checks.
