# Event Planning Agent Design

## Scope

The module creates one event-level meal plan from a Host budget, participant
intents, declared preferences, and independently normalized Silpo context. It
does not manage rooms, permissions, persistence, carts, or checkout.

The backend owns membership, authorization, OAuth token lookup, and MCP client
creation. The planner receives neither credentials nor raw MCP responses.

## Pipeline

Each participant is processed independently:

```text
Silpo MCP result
→ deterministic bounded extraction
→ optional semantic normalization
→ UserFoodContextSchema
```

The event is then planned once:

```text
event + Host budget + food intents + UserFoodContext[]
→ GroupPlanningInputSchema
→ group planner
→ EventPlanSchema
→ deterministic safety validation
```

At most three participant loaders run concurrently. Results remain ordered by
the event participant list. A participant failure becomes explicit unavailable
context and cannot be interpreted as an absence of restrictions.

## MCP data minimization

The normalizer recognizes only `silpo_get_my_food_restrictions` and
`silpo_get_my_favorites`. It ignores profile contact data, addresses, orders,
purchase history, promotions, product details, loyalty data, and other tools.

External MCP data is `unknown` only at the transport edge. The deterministic
extractor prefers structured content, otherwise parses bounded JSON text,
rejects sensitive keys, caps traversal and collection sizes, and creates
compact source evidence. Raw responses never enter model prompts or traces.

Semantic normalization is conditional. Unambiguous facts never invoke the
normalizer model. Only bounded ambiguous food fragments plus compact extracted
signals can be sent to it. Declared hard constraints are merged afterward and
cannot be removed by model output.

## Contracts

- `EventPlanningInputSchema`: backend-owned event, participants, declarations,
  intents, and budget.
- `ParticipantFoodSignalsSchema`: bounded deterministic output from external MCP
  data.
- `UserFoodContextSchema`: compact normalized participant constraints,
  preferences, missing information, and evidence.
- `GroupPlanningInputSchema`: the only input accepted by the main planner.
- `EventPlanSchema`: dishes, eaters, conflicts, Host approval proposals,
  participant insights, and hard-constraint checks.

All objects are strict. Text and arrays are bounded. Group refinements enforce
unique participant IDs, Host membership, at most ten participants, and matching
participant/context IDs.

## Provider isolation

`PlanningModelProvider` exposes separate model factories for participant
normalization and group planning. Business logic imports no provider-specific
model SDK.

Production uses Alibaba Cloud Model Studio through `@ai-sdk/openai-compatible`
and the international DashScope endpoint. Both roles default to
`qwen3.8-flash` and can be changed independently:

```env
AI_PROVIDER=alibaba
AI_API_KEY=...
AI_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
AI_NORMALIZER_MODEL=qwen3.8-flash
AI_PLANNER_MODEL=qwen3.8-flash
```

Tests inject generation adapters or a model provider and require no network or
credentials.

## Planning and safety

The main model has no MCP tools. Its complete input is the validated compact
group context. It must plan globally rather than concatenate per-person plans.

All normalized allergies and hard restrictions are absolute. For every eater,
the output must contain a safe check for every applicable hard constraint.
Deterministic validation rejects unknown references, duplicate identifiers,
insufficient servings, incomplete participant insights, missing checks, and
uncertain or conflicting assignments.

## Tracing and privacy

Participant traces contain only participant ID, availability, source names,
and counts of restrictions, favorites, and ambiguous fragments. Unavailable
traces may contain a concise operational reason. They contain no raw payload,
prompt, credential, personal contact value, or food-content excerpt.

## Debug route

The temporary authenticated `/ai-debug` server action continues to use the real
user's MCP session, but passes its result into the same preprocessing pipeline.
Its planning trace is metadata-only. Frontend files are intentionally unchanged
by this backend architecture revision.

## Verification

Unit tests cover schema boundaries, sensitive-data removal, unsupported tools,
conditional semantic normalization, immutable declared constraints, unavailable
context, provider configuration, participant concurrency, planner input
minimization, and hard-constraint safety. TypeScript, ESLint, and the production
build provide integration checks.
