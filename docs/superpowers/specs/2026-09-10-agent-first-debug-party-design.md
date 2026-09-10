# Agent-First Debug Party Design

## Status

Approved in chat on 2026-09-10. This design applies only to the experimental
`/ai-debug` flow. It does not replace the existing `/party` flow or its tables.

## Goal

Build a persistent, real multi-user debug party in which DeepSeek acts as an
MCP-native supervisor. Each participant contributes one short food intent, a
mandatory personal subagent prepares compact context through that participant's
Silpo MCP session, and the supervisor uses validated tools repeatedly to build
and revise one local party cart.

The design reduces hallucinations by making live Silpo tool results authoritative
for products, identifiers, availability, promotions, and prices. The model may
decide which registered tool to call and in what order. It may not invent or
execute arbitrary commands, SQL, HTTP requests, or UI mutations.

## Product flow

1. An authenticated Host creates a debug party and may set one total budget.
   An absent budget means reasonable optimization without a hard price ceiling.
2. The party always shows its stable eight-character code and
   `/ai-debug/join/{code}` invitation link. The link does not expire. New members
   may join while the party is open, up to the existing ten-person limit.
3. Every participant uses a separate app account and connects their own Silpo
   account. A participant enters exactly one short dish, food wish, or recipe URL.
4. Continue starts mandatory participant preprocessing. Until it completes, that
   member sees progress/retry UI and cannot enter the shared workspace.
5. The shared workspace contains participant readiness, chat, the local cart,
   the optional Host budget, a compact agent status, and a sanitized debug log.
6. The Host selects **Build basket**. The supervisor plans across all ready
   participants and creates a local cart through registered tools.
7. Any participant may send natural-language cart requests. The same supervisor
   interprets each request, calls tools as needed, and revises the local cart.
8. The Host selects **Finalize** to create a frozen, read-only snapshot.
9. The final screen shows snapshot items and totals. **Send to Silpo** performs a
   deterministic Host-only synchronization into the Host's real Silpo cart.

Mock data is limited to convenient seed food intents and explicit UI demo
fixtures. Personal context, purchase history, product results, identifiers,
availability, promotions, and prices must come from real Silpo MCP calls. Missing
MCP capabilities or data remain visibly unavailable and are never fabricated.

## Architecture

The feature has four boundaries:

```text
Next.js UI
  -> authenticated debug-party application services
    -> supervisor/personal-agent orchestration
      -> validated Silpo MCP and local-cart tools
        -> Supabase debug-party state
```

The UI renders server-owned state and sends user intent. It does not execute
model tool calls. Application services re-check authentication, membership,
party state, role, and cart revision for every mutation. Orchestration decides
which allowed tools to use. Tool adapters own MCP sessions, input validation,
result minimization, and domain writes.

The current one-shot `planEvent` API remains available to the existing party
prototype. The new debug flow gets a separate supervisor module and contracts so
experimental tool orchestration cannot silently change production behavior.

## Supervisor and personal subagents

### Personal subagent

Continue invokes the same debug-party supervisor in participant-scoped mode. Its
first mandatory action is to dispatch an idempotent personal-subagent run bound
to `(party, participant, intent revision)`. The backend opens only that
participant's encrypted Silpo MCP session and exposes a personal-context toolset
to the personal subagent. This keeps one orchestration entry point for Continue,
Build basket, and later chat turns without allowing the model to select another
participant's credentials.

The subagent is required to collect, when advertised by the connected MCP server:

- profile fields relevant to food planning;
- allergies and forbidden products;
- dietary restrictions;
- relevant food preferences and favorites;
- products from the five most recent purchases or orders;
- the participant's submitted food intent.

Tool names and schemas are discovered from `listTools()` at runtime. The adapter
maps only recognized personal/order capabilities into semantic roles. It does
not guess unsupported tool names. If recent-order tools do not exist, the compact
result records purchase history as unavailable.

Raw MCP responses are `unknown` at the transport edge. A deterministic bounded
extractor redacts sensitive keys, limits traversal/text/array sizes, and produces
food signals. The personal model may normalize only those bounded signals. The
final `ParticipantContext` is strict, compact, and versioned. Raw MCP payloads,
tokens, addresses, contact data, full receipts, and model reasoning are neither
stored nor passed to the supervisor.

### Main supervisor

`Build basket` starts one DeepSeek tool loop with:

- party and Host identifiers represented by opaque IDs;
- every ready participant's validated compact context and food intent;
- the optional total budget;
- the current local-cart revision and concise conversation history;
- a registry of typed tools available for the current party state and actor.

The supervisor orchestrates the complete planning run and may call tools multiple
times until the cart is complete or a configured step/time limit is reached. It
receives all read-only Silpo MCP capabilities relevant to food planning, catalog,
product, price, promotion, and availability that are advertised by the Host's
session, wrapped by the validated server adapter. It is not forced to call every
advertised tool; it chooses all tools needed for the request. MCP cart-write tools
are intentionally unavailable until the deterministic Send to Silpo stage. The
supervisor must inspect live MCP results before selecting a product. Its selection
policy is:

1. Prefer a suitable product present in a participant's five recent purchases.
2. If multiple suitable previous products exist, prefer a currently discounted
   one, based only on live MCP promotion/price evidence.
3. Otherwise search Silpo and select a reasonable/popular result supported by
   tool output.
4. Never create product IDs, names, availability states, promotions, or prices
   that did not come from an MCP result in the current run or a still-valid
   cached result with provenance.

The supervisor may delegate bounded normalization/evaluation work to personal
subagents, but the backend—not the model—controls participant identity and selects
the corresponding MCP session. The supervisor never receives MCP credentials.

DeepSeek thinking-mode tool use is supported by the official Chat Completions
API. The provider adapter must preserve the complete assistant tool-call message,
including `reasoning_content` when required by the provider, between tool rounds.
Reasoning content is not returned to clients or persisted in the debug log.

## Tool registry and command handling

The app accepts broad natural-language food and cart instructions. It does not
use a hardcoded intent classifier or phrase pipeline. The supervisor selects from
a capability-oriented tool registry such as:

- inspect current party/cart state;
- search Silpo products;
- inspect a product and current price/promotion;
- inspect recent-purchase candidates already minimized by a personal subagent;
- add a verified product to the local cart;
- replace one local line with a verified product;
- change quantity;
- remove a line;
- compare verified alternatives;
- complete the run with a short user-facing reply.

All tool inputs use strict Zod schemas and inferred TypeScript types. Dynamic MCP
schemas remain `unknown` until parsed by a server adapter. Tool executors enforce
membership, allowed party state, Host-only operations, product evidence, numeric
bounds, and optimistic cart revision. The model cannot register new tools.

Every local-cart line includes Silpo product/company/branch identifiers, name,
quantity, unit, current unit price, optional discount evidence, image, provenance,
the MCP observation time, and the cart revision that introduced it. A write is
rejected if the referenced product was not produced by an eligible MCP result or
the expected cart revision is stale.

Each chat turn runs against one serialized party mutation slot. On a stale
revision, the tool returns fresh state to the supervisor for a bounded retry.
The final assistant message is a short Ukrainian status or clarification. Tool
calls, validation failures, retries, and concise decision summaries go only to
the sanitized debug log.

## Persistence and permissions

Use these isolated debug tables rather than extending production party rows:

- `debug_parties`: stable code, Host, optional budget, lifecycle state, cart
  revision, timestamps;
- `debug_party_members`: event-scoped member role and preprocessing state;
- `debug_food_intents`: one current short intent with a monotonically increasing
  revision;
- `debug_participant_contexts`: compact validated context, source status,
  intent revision, schema version, timestamps;
- `debug_chat_messages`: user-visible messages and short assistant replies;
- `debug_agent_runs`: run type/status, actor, model, limits, safe error summary;
- `debug_tool_events`: sanitized tool name/status/duration and bounded metadata;
- `debug_cart_items`: mutable local cart lines tied to cart revision;
- `debug_cart_snapshots` and snapshot items: immutable final basket and totals.

The implementation plan may split immutable snapshot items into a dedicated
child table, but it must retain these table prefixes and boundaries. All
foreign-key columns and frequent party/time lookup paths receive indexes. Public
tables enable RLS and use explicit grants because current Supabase projects may
not expose new tables to the Data API automatically.

Members may read their party, members, ready states, chat, cart, and sanitized
debug events. A member may write only their own intent and chat message. Host-only
actions are budget changes, Build basket, Finalize, and Send to Silpo. Server-only
services write normalized context, assistant messages, run events, MCP provenance,
cart mutations, and snapshots. Authorization never relies on user-editable
`user_metadata`.

Capacity-safe join and snapshot creation are atomic database operations. Any
necessary privileged function lives outside an exposed schema where practical,
sets a safe `search_path`, checks `auth.uid()`, revokes default `PUBLIC` execute,
and grants only the required role.

## Party lifecycle

```text
collecting -> ready -> building/revising -> finalized -> sent
```

- `collecting`: members may join and submit/revise their single intent.
- `ready`: every current member has context for the latest intent revision.
- `building/revising`: one supervisor run owns the mutation slot; chat messages
  may queue, but cart mutations are serialized.
- `finalized`: membership, intents, chat mutations, and cart edits are frozen;
  all users see the final read-only snapshot.
- `sent`: deterministic Host synchronization completed. The snapshot remains the
  audit source of truth.

Changing an intent invalidates only that member's compact context and requires a
new mandatory preprocessing run. Joining after an initial basket build marks the
basket stale and requires a new Host build before finalization. The invite code
never expires, but new joining stops once finalized.

## Deterministic Send to Silpo

Finalize atomically creates an immutable snapshot from one cart revision and
recomputes totals server-side. Send to Silpo is not an agent tool and never calls
DeepSeek. It:

1. verifies current user is Host and snapshot is final/unsent;
2. validates every frozen line with the strict snapshot schema;
3. opens the Host's Silpo MCP session;
4. re-checks product identity, availability, quantity rules, and current price;
5. reports material price/availability changes for explicit Host confirmation;
6. applies the validated frozen lines to the real Host cart;
7. records per-line outcome and an idempotency key.

A partial external failure does not mutate the frozen snapshot. The run remains
retryable and reconciles the actual Host cart before repeating writes.

## UI and UX

The route is mobile-first and Ukrainian, with a clear debug identity so it cannot
be confused with the production party. The main screens are:

- create/join with the stable code, copyable invite link, Host budget, and seeded
  example-intent chips;
- one-field participant intent with MCP connection status, Continue, staged
  preprocessing progress, retry, and safe failure details;
- shared workspace with participant readiness at the top, compact chat, sticky
  Build basket/Finalize actions for the Host, and a prominent local cart;
- collapsible debug drawer with filters for run, participant, tool, and status;
- final read-only basket with total, freshness warnings, Send to Silpo, and
  deterministic synchronization progress.

The UI optimistically adds user chat text but renders cart state only after a
validated server revision. Agent activity uses explicit states such as analyzing,
calling Silpo, updating cart, completed, and failed. It never displays chain of
thought. Empty, disconnected-MCP, partial-context, queued, timeout, stale-cart,
conflict, retry, and partial-send states have dedicated messages and actions.

Realtime updates may use Supabase Postgres Changes on public application tables;
the implementation must not create or alter objects in the locked `realtime`
schema. A polling fallback keeps the debug flow usable if Realtime is unavailable.

## Limits and failure handling

Each agent run has maximum steps, wall-clock duration, MCP-call count, per-tool
timeout, result-size limit, and one active mutation run per party. Hitting a limit
stops safely with a short user-facing message and a retryable run record.

Personal MCP failure leaves that participant in a retryable preprocessing state.
The main supervisor cannot build while a current participant lacks context for
their current intent. Product search with no verified result produces a concise
clarification or omission; it never produces a placeholder cart line.

Sensitive values are removed before logs are persisted. Debug payloads contain
tool names, timing, status, counts, opaque evidence references, and bounded error
summaries—not MCP tokens, raw tool results, prompts, reasoning content, addresses,
contact details, or full purchase history.

## Verification

Automated tests cover:

- strict Zod parsing and absence of `any` in new orchestration code;
- stable code joining, capacity, membership, and Host permissions;
- optional budget behavior and hard-budget enforcement when present;
- mandatory/idempotent preprocessing tied to intent revision;
- use of the correct participant MCP session and raw-result redaction;
- five-most-recent purchase truncation and unavailable-capability behavior;
- multi-round tool execution, tool input rejection, call/step/time limits;
- previous-product and live-discount selection policy;
- rejection of invented or unproven product lines;
- natural-language add/remove/replace/cheaper-alternative cart turns;
- optimistic revisions, serialized runs, stale-cart invalidation;
- immutable final snapshots and read-only enforcement;
- Host-only deterministic, idempotent Send to Silpo;
- sanitized debug streams and short user-visible replies.

Run the smallest relevant Vitest files first, then the full test suite, ESLint,
TypeScript checking, and the Next.js production build. Database verification must
exercise RLS with Host, member, non-member, and service-role contexts, plus atomic
join/finalize behavior.

## References

- DeepSeek Tool Calls: <https://api-docs.deepseek.com/guides/tool_calls/>
- DeepSeek Thinking Mode: <https://api-docs.deepseek.com/guides/thinking_mode/>
- Supabase 2026 Data API grants change:
  <https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically>
- Supabase Realtime schema restriction:
  <https://supabase.com/changelog/realtime-schema-locked-down-against-modification>
