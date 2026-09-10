# Silpo Family

Last updated: 2026-09-10
Status: No-AI multi-user party prototype implemented with Google/Supabase auth and
real Host-cart synchronization through Silpo MCP.

## Source of truth

Read this file before future significant product or architecture changes.
Update it whenever an important decision is made. Keep confirmed decisions,
proposals, MVP scope, long-term direction, and unanswered questions distinct. Do not silently promote a proposal
to an approved requirement. Never store secrets or real personal food profiles here.

## Product and differentiation

Silpo Family originated as a hackathon idea and is being built as a multi-account
AI agent for shared group grocery planning. The MVP uses event-only membership:
the Host creates a meal/party event and participants join that event. There is no
persistent Family membership in the MVP. Persistent household/family groups may be
considered later, but must not shape the current membership model.

Multiple independent users → individual preferences, restrictions and food intents
→ one Host-set shared budget → AI reasoning across ALL users → one coherent shared
meal plan → one optimized shared Silpo basket → collaborative basket management
→ Host final authority.

Silpo already has its own AI assistant connected to Silpo MCP. Our differentiation
is reasoning and coordination across people/accounts, not a generic grocery chatbot.
The interface must make individual contributions and their impact on the shared
result visible.

The survey-validated MVP value proposition is:

Multiple people with different food preferences/restrictions → one shared meal
plan → one shared budget → one shared editable Silpo basket.

The product is not primarily a bill-splitting tool or a personal cookbook. Recipe
ingestion is a supported way to express food intent, not the center of the product.

Our value is AI that coordinates grocery decisions across multiple independent
people/accounts, not AI that helps one person choose groceries. The official MCP docs
confirm personal profile and food-restriction tools. For the current no-AI prototype,
participants use Supabase profiles without needing Silpo; only the Host needs a Silpo
connection for eventual final-cart synchronization. A member may connect Silpo later
for richer context, but it is not required to join or collaborate.

## Confirmed requirements

- One user creates an event and becomes its Host.
- Other people join that event through an invitation link using their own accounts.
- Membership is event-only in the MVP. Joining one event does not create persistent
  Family membership or automatically carry membership into another event.
- There is a fixed participant limit; the Host cannot configure it.
  The limit is 10 people total, including the Host (up to 9 other participants).
  The limit applies to each event and may change in a later product revision.
- Accounts must be real and separate; a demo identity switcher is not the product.
- Use Supabase Auth with Google OAuth for our app accounts and Supabase for event data.
  App authentication and Silpo authorization are separate. Every participant needs an
  app account; only the Host needs Silpo for eventual final cart writes.
- The first supported scenario is an event-based group meal/party plan.
- Each member has an individual food context: allergies, dietary restrictions,
  lifestyle/preferences, dislikes, and other relevant food preferences.
- Profile examples include vegan, gluten-free, religious food restrictions, and
  diets. Other members can see food context; Family-wide versus planning-context
  visibility boundaries remain to be defined.
- Take relevant member food context from Silpo MCP. The official tools include
  `silpo_get_my_profile` and `silpo_get_my_food_restrictions`; the implemented profile
  integration also reads favorites when the tool is available. After native integration
  by Silpo developers, MCP can pull this information from each person's Silpo profile.
  Supabase may store only product-specific answers that MCP does not provide.
- If required information is unavailable or incomplete, ask the affected member only
  for what is missing and keep onboarding minimal. Missing information is not
  equivalent to having no restrictions.
- Each member can submit a meal type (lunch/dinner/etc.), describe what they want to
  eat, name a dish, provide a recipe/content link, or choose “I don't care”. The agent
  converts food/recipe inputs into structured dishes, ingredients and
  portions for group-level planning. Recipe ingestion remains supported as an input
  method, but is not the core product positioning. A persistent personal Cookbook
  and additional intent types remain future scope.
- The AI reasons across all members. It detects conflicts and considers priorities,
  portion counts, and preferences.
- The Host sets the shared budget before starting the agent. Budget is a first-class
  planning input, not a post-generation filter or optional afterthought.
- When everyone has submitted food intent and the budget is set, the Host starts the
  agent to generate a coherent shared meal plan and one optimized shared Silpo basket
  from all participants' profiles and requests.
- It must not independently generate a shopping list per person/recipe and concatenate
  the lists. It reasons globally across member context, dishes, portions, conflicts
  and compatible ingredient requirements to produce one coherent shopping plan.
- Multiple recipes/dishes can contribute to one shared shopping plan.
- Different participants may eat different dishes; every dish need not suit everyone.
  The AI must consider everyone's needs when optimizing products and the combined
  basket, rather than optimizing each dish or person's shopping independently.
  Exact optimization priorities remain to be agreed.
- AI-proposed changes to requested dishes require Host confirmation before being
  applied. Show the proposed change and its reason; do not silently replace dishes.
- Shared ingredients must be merged instead of purchased separately per recipe.
- The eventual product builds one shared Silpo basket through Silpo MCP.
- In the no-AI prototype, each participant explicitly submits intent and can use
  Supabase profile/preferences without Silpo. Optional member MCP connections may later
  enrich context. Final cart writes must use the Host's linked Silpo MCP session.
- Members can directly edit the shared basket, not only submit suggestions.
- Members are active participants, not passive request submitters. The Host acts as
  administrator and has final authority over important AI-proposed changes;
  detailed administrative permissions remain open.
- The Host has final control, sets budget/priorities, and approves the final purchase.
- The Host can modify and finalize the basket without approval from every participant.
- After generation, the shared meal plan and basket are the primary workspace. AI Chat
  remains available as a supporting tool for requesting changes, understanding
  decisions, resolving conflicts and asking for re-planning; chat is not the center
  of the product.
- Basket ownership attribution, “Mine / Not mine” review and bill splitting are useful
  secondary/demo features. They follow, rather than compete with, a solid core
  group-planning and shared-basket experience.
- Priority/conflict reasoning is a core concept. The exact priority hierarchy remains
  unapproved; see the candidate model under proposals below.

## Global reasoning example — illustrative, not a fixed menu

User A wants lasagna, User B wants carbonara, and User C has dietary constraints.
The agent considers their portions, constraints and preferences together, identifies
suitable dishes/eaters, resolves conflicts, merges compatible overlapping ingredient
requirements, and optimizes product/package quantities into one shared shopping plan.
Different people may eat different dishes. Recipe-level extraction is an input to
global reasoning, not a set of independently finalized shopping lists.

## First MVP scope — confirmed

- One event-based group meal/party planning flow with real accounts and shared event
  data. Membership exists only for that event.
- Minimal individual food context; Create/Join; participant food-intent submission;
  a Host-set budget before generation; global coordination across members,
  restrictions, preferences, dishes, portions, shared ingredients and budget; a
  coherent shared meal plan; one optimized shared Silpo basket; collaborative basket
  edits; supporting AI Chat; and Host-controlled finalization.
- Food/recipe ingestion is supported inside food-intent submission, but is not the
  product's primary value proposition.
- Ownership review and bill splitting are secondary/demo scope and should be
  implemented only after the core group-planning and shared-basket flow is solid.
- The no-AI prototype includes manual product entry, equal allocation of each item
  among selected participants, exact-cent totals owed to the Host, and Host
  finalization so the collaboration loop can be validated before AI work.
- Party/group meal planning is the first event-based demonstration scenario.
- Required integration capabilities still need verification; a demo scenario does
  not authorize replacing core account, event, planning or basket flows with simulations.
  The delivery menu/checkout presentation is an explicit exception: it is a mocked,
  animated demo surface rather than a real delivery integration.

## Goals and constraints

- Build a mobile-first web app in the existing Next.js project.
- Use Ukrainian for the user interface.
- Design from the perspective of being inside the Silpo mobile app, not a separate
  consumer app. This is the UX context; actual embedding is not verified. Our accounts
  use Supabase independently of Silpo authentication, while food context comes from MCP.
- Design only Silpo Family and minimal surrounding navigation, not the entire Silpo app.
- Build working core flows with real accounts and shared event data. The user's
  latest instruction supersedes the earlier preference for demo completeness over
  a real product. Keep the first scenario focused on an event-based group meal/party.
- The user can supply required information and access; availability and capabilities
  still need verification. The delivery menu is intentionally mocked and animated;
  do not substitute simulations for other core integrations without agreement.
- Keep scope minimal while making the multi-account concept unmistakable.
- Ask the user before making major product or design decisions.
- The pre-implementation discovery checkpoint was completed in this file. Continue to
  record material product and architecture decisions here.
- Implement product surfaces incrementally from the confirmed MVP hierarchy.

## Existing repository: inspected facts

- `src/app/page.tsx` provides Google login and an authenticated profile entry point.
- `src/app/profile/page.tsx` is the protected individual profile and Silpo connection surface.
- `src/app/parties/page.tsx`, `src/app/join/[code]/page.tsx` and
  `src/app/party/[code]/page.tsx` implement party creation, joining and the no-AI workspace.
- `src/app/globals.css` contains the initial mobile-first auth/profile styling.
- `next.config.ts` enables the React compiler.
- `package.json`: Next.js 16.3.4, React 19.2.8, Tailwind CSS 4, TypeScript;
  AI SDK, OpenAI, MCP, and Supabase client dependencies are also declared.
- Supabase SSR and the official MCP TypeScript SDK are installed for server-side auth
  and Streamable HTTP MCP access.
- Available package scripts: `dev`, `build`, `start`, `lint`; no test script is declared.
- `package-lock.json` exists; use npm for this project.
- `README.md` is starter documentation. Public assets inspected are starter SVGs.
- `AGENTS.md` requires reading relevant local guides in `node_modules/next/dist/docs/`
  before writing Next.js code. Do not assume older Next.js conventions apply.
- `AGENTS.md` had an existing user change before this task; preserve it.
- Production credentials and a live end-to-end OAuth run have not yet been provided or verified.

## Auth and Silpo connection architecture — implemented

- Supabase Auth uses Google as the app login provider. The `/auth/google` route starts
  login and `/auth/callback` exchanges the PKCE code into a cookie-backed Supabase session.
- `/profile` verifies the current user with Supabase on the server. Users can save
  fallback allergies, restrictions, dislikes and preferences under row-level security,
  so the product remains usable without a connected Silpo account.
- “Підключити Сільпо” starts the official Silpo OAuth 2.1 Authorization Code + PKCE
  flow. The server uses Dynamic Client Registration and an exact callback URI.
- OAuth state is random, stored only as a SHA-256 hash, bound to the current Supabase
  user, expires after ten minutes and is deleted on callback use. The PKCE verifier is
  encrypted server-side and never placed in browser-readable storage.
- Silpo access tokens, refresh tokens and dynamically issued client secrets are
  encrypted with AES-256-GCM before storage in Supabase. Token tables have RLS enabled,
  no browser/user policies and revoked `anon`/`authenticated` privileges; only the
  server-only service-role client can access them. `SILPO_TOKEN_ENCRYPTION_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` must never use `NEXT_PUBLIC_` names.
- MCP calls execute only in server-only modules. The client receives connection state
  and safe availability summaries, never Silpo access/refresh tokens. Expiring access
  tokens are refreshed server-side when a refresh token is available.
- Each Supabase user has at most one optional linked Silpo connection. Event
  participation requires only Supabase auth. Optional member MCP enrichment selects
  that member's connection; final cart mutations select the Host user ID.
- The required schema is in `supabase/migrations/202609080001_auth_profiles_silpo_oauth.sql`;
  required environment variables are documented in `.env.example`.

## No-AI party prototype architecture — implemented

- The Host creates an event and receives an eight-character code plus a shareable
  `/join/{code}` URL. The link survives Google login through the `next` callback
  parameter; manual code entry is a fallback.
- Membership is event-scoped and limited to 10 people. PostgreSQL creates Host
  membership transactionally and locks the event during joins so concurrent requests
  cannot exceed the limit.
- Every participant can submit a dish, free-text intent, recipe/content URL or explicit
  “I don't care” response.
- The Host sets the shared budget. Every member can add, edit and remove manual basket
  items while the event is open.
- Each item has one or more selected participants and is split equally among them.
  Remainder cents are distributed deterministically, so participant totals exactly
  match the whole party bill.
- The Host can finalize without unanimous approval after setting a budget. Finalization
  freezes edits; the Host can reopen the party.
- RLS plus server authorization protects party data. Security-definer functions handle
  creation, capacity-safe joining and atomic share replacement.
- Apply `supabase/migrations/202609090001_party_prototype.sql` and then
  `supabase/migrations/202609090002_silpo_cart_sync.sql` after the auth migration.
- Product lookup, quantity changes and removals synchronize with the Host's active
  Silpo basket through the Host's server-only MCP session. Failed synchronization is
  retained visibly and can be retried by the Host. This stage deliberately does not
  run AI.

## Confirmed MVP user experience

Profile → Create/Join event → everyone submits food intent → Host sets budget →
Host runs AI → shared meal plan + shared basket → collaborative edits →
Host finalizes.

Optional after the core flow is solid: Mine / Not mine → split bill.

1. **Profile / food context.** Each user has their own preferences, dislikes, allergies
   and dietary/lifestyle restrictions. Keep onboarding minimal, combine relevant
   Silpo MCP context with any required product-specific answers, and ask that member
   only for required information that is missing.
2. **Entry.** Two primary actions: Create an event and Join an event. Joining uses the
   confirmed invitation-link mechanism and independent accounts. Membership is scoped
   to this event; there is no persistent Family membership in the MVP.
3. **Group planning.** Each participant submits an intent: meal type (lunch/dinner/etc.),
   what they want to eat, a recipe/content link, or “I don't care”. The latter is an
   explicit choice, not missing input, and does not erase that member's restrictions.
4. **Budget.** Before generation, the Host sets the shared budget. The agent must use
   it as a first-class constraint/objective alongside member needs and food intent.
5. **AI generation.** Once everyone has submitted intent and the budget is set, the
   Host starts the agent. It reasons globally across all members, restrictions,
   preferences, requested dishes, portions, shared ingredients and budget. It produces
   one coherent shared meal plan and one optimized shared Silpo basket. Important
   AI-proposed dish changes still require Host confirmation.
6. **Primary post-generation workspace.** The shared meal plan and basket are the main
   interface. Members can view the plan and collaboratively edit the shared basket.
   AI Chat is available as a supporting tool to ask for changes, understand decisions,
   resolve conflicts and request re-planning; it must not dominate the experience.
7. **Member edits.** Members interact with and edit the basket within their permissions.
   Host final authority remains in place; unanimous participant approval is not required.
8. **Host finalization.** The Host controls the budget, important AI changes, basket
   modifications and finalization, and may finalize without requiring approval from
   every participant.
9. **Optional secondary flow.** After the core experience is solid, participants may
   use Mine / Not mine to resolve ambiguous ownership, including shared products, and
   calculate a bill split. Exact allocation rules remain open; calculating amounts
   does not itself specify an in-app payment or collection flow.

This sequence and the primacy of the shared plan/basket workspace are confirmed product direction.
Detailed screen layouts, readiness mechanics, ownership-conflict handling and split
formulas have not been specified. The MVP delivery menu/checkout presentation is a
mocked animation. Real Silpo catalog/cart execution and checkout-link handoff are now
implemented through MCP; placing the order, payment and delivery tracking remain deferred.

## Design proposals — not approved

The MVP must use event-scoped membership and must not introduce a persistent Family
membership layer. The confirmed MVP flow and primary shared plan/basket workspace
supersede earlier navigation alternatives. Auth/profile implementation is now underway;
detailed planning and basket layouts remain unapproved.

Candidate priority model:
hard constraints (e.g. allergies) > strong restrictions > preferences > optimization
objectives such as budget, package efficiency and leftovers.
This hierarchy, its weights and override rules are not final decisions.

## Proposed state model and unresolved behavior

Concepts, not committed database tables or APIs:
- Account; event; event membership/role; individual food context, its MCP source and
  completeness.
- Event invitation link; per-event participant limit; available/full state.
- Event participants; authored intents; structured dishes, eaters, ingredients and
  portions. The first event type is a group meal/party.
- Constraint conflict; proposed resolution; shared basket and its revision; Host approval.
- Participant readiness, including an explicit “I don't care” intent; Host-set budget;
  agent conversation and proposals. Secondary concepts include item-to-participant
  attribution with multiple owners, ambiguous-item review responses and amounts owed.

Current no-AI states: collecting intents/basket and awaiting Host budget → collaborative
review/editing and allocation → Host finalization. The later AI state adds generation
between collection and review.
Exact state transitions and exceptional paths remain design work; these labels do
not add participant approval gates or change the confirmed UX sequence.
Support empty, pending, failed/retry, and stale-result states for real usage.
Concurrent basket edits and server-enforced permissions must be addressed in the
implementation design; specific synchronization and persistence mechanisms are unapproved.
Joining must enforce the participant limit on the server, including simultaneous
join attempts. Reopening the link as an existing participant must not use another place.
An unauthenticated visitor must retain the invitation context through sign-in.

Suggested consistency rules to confirm:
- Missing profile answers must not count as an absence of restrictions.
- Allergy/restriction conflicts must remain visible and cannot silently disappear
  under budget optimization; agree on hard-constraint and override policy.
- Combine only compatible ingredients/variants and compatible units; preserve dish
  attribution so merging does not obscure dietary differences or portion needs.
- Changes to relevant profiles, wishes, dishes, or quantities make affected proposals
  stale; changes after approval should require fresh Host approval.
- Members can see food context and edit the basket. Event visibility boundaries,
  profile access after leaving an event, deletion/checkout permissions, and approval invalidation
  remain open.
- MCP profile-context freshness and conflicts with product-specific answers need
  explicit handling; do not silently overwrite one source with another.

## Key questions awaiting the user

1. **Supabase deployment setup:** Google OAuth is selected and implemented. The target
   Supabase project, Google provider credentials, redirect allow-list and production
   environment values still need to be configured and tested end to end.
2. **Event lifecycle and portions:** removal/leave behavior, invitation revocation,
   event expiry/reopening and eaters/portions remain open. The fixed per-event limit is
   settled: 10 including Host.
3. **Constraints and approval details:** Host confirmation is required for AI-proposed
   dish changes. Which constraints are non-overridable?
   What happens when someone edits an already approved basket?
   Different dishes for different participants are confirmed. Rules for restrictions
   that affect the whole shared setting remain to be defined separately.
   Optimization proposal awaiting approval: satisfy each eater's restrictions and
   portions, then optimize for the Host's budget, compatible shared ingredients,
   pack sizes and reduced leftovers. If requests cannot fit the budget, show options
   for the Host to choose. Product substitution permissions remain to be specified
   separately from the confirmed rule for dish changes.
4. **Member food context:** required MCP fields, completeness gating, visibility,
   freshness and conflicts with product-specific answers remain open. Store actionable
   food restrictions rather than inferring them from a religious identity.
5. **Services and purchase endpoint:** confirm the known Silpo MCP profile/restriction
   fields, authorization model, AI service, hosting and persistence resources. How is
   each member authorized/connected, and whose Silpo account owns the shared basket?
   The current delivery menu is a mocked animation, not a real checkout integration.
6. **Visual references and delivery:** which Silpo screens/assets should guide the
   feature, and what is the target delivery date?
7. **Readiness and secondary ownership mechanics:** how is readiness recorded and
   affected by intent edits? After the core flow is solid, define how unresolved or
   conflicting ownership responses are handled and how costs are divided for shared
   products. Allocation of discounts/fees, rounding and post-review basket changes
   remain unspecified. Do not assume equal splitting, automatic item deletion after
   “Not mine”, or unanimous approval before finalization.

## Long-term direction and deferred scope

Discovery checkpoint: the core product definition and MVP UX flow are confirmed.
The user asked whether many questions
remain; avoid continuing a long sequence of granular questions. Group remaining
design proposals for review and request service access when implementation needs it.
Do not interpret this checkpoint as approval of unspecified major decisions.

- Later event types may include dinner, weekly groceries, picnic and others. Only the
  group meal/party event is first-release scope.
- Persistent household/Family membership and multi-Family management are deferred.
  They must not be assumed by the MVP data model or user flow.
- Possible personal Cookbook, additional roles, granular priority controls, extra
  intent types, recurring plans, notifications, pantry tracking and voting.
- Ownership attribution, post-generation Mine/Not mine review and bill calculation
  are secondary/demo features, deferred until the core group planning, budget,
  shared meal plan and editable basket experience is solid. Payment collection is
  not specified.
- Full Silpo navigation, catalog browsing, loyalty, real delivery management, checkout
  and payment UI. The MVP delivery menu is only a mocked animation.
- Supabase is selected for own accounts, event data and product-specific answers not
  available through MCP. Google auth, profile/token storage, MCP connection, event
  membership, intent, budget, collaborative basket, Host MCP cart synchronization,
  allocation and finalization are implemented. Realtime, AI orchestration, automated
  recipe ingestion and remaining persistence design await implementation.

## Decision log

Historical entries below preserve the discussion. The latest correction and current
confirmed sections prevail over superseded interpretations.

- 2026-09-08: User established the product requirements and Next.js/mobile-first scope.
- 2026-09-08: User designated root `PROJECT.md` as persistent source of truth.
- 2026-09-08: Repository inspected; proposed flow, state, navigation, and open questions
  recorded. No frontend implementation or major architecture choice approved yet.
- 2026-09-08: User changed the target from a demo-first prototype to a real user
  product with separate accounts. First task: party meal planning. Host is an admin;
  other members can edit the shared basket. Food profiles include vegan, gluten-free,
  religious restrictions and diets and are visible to others. UI is Ukrainian and
  conceived as a feature inside Silpo. User can provide needed information/access.
  These decisions supersede earlier demo-first assumptions; auth/integration details
  and final interaction design remain open.
- 2026-09-08: User confirmed our own Supabase-based accounts/profiles, rather than
  existing Silpo authentication. No Supabase project connection or schema changes
  have been made. The later clarification establishes event-only membership and MCP
  as the food-context source; this entry is retained only as history.
- 2026-09-08: User specified invitation-link joining, event-only membership and a
  participant limit, noting Silpo has no existing family entity. A later document pass
  incorrectly restored persistent Family membership; the current event-only model
  corrects that mistake. Link joining remains.
- 2026-09-08: User chose a fixed participant limit, changeable in a later product
  revision, rather than a Host-configurable limit. Numeric value is not yet specified.
- 2026-09-08: User approved 10 participants total, including the Host. This resolves
  the earlier numeric-limit question. The limit applies per event.
- 2026-09-08: User approved different dishes for different participants, emphasizing
  optimal products and a shared basket for everyone. Optimize at event level across
  dishes; do not require one universally suitable dish. Detailed optimization criteria
  and authority to change requested dishes are still unapproved.
- 2026-09-08: User confirmed that AI dish changes require confirmation, accepting
  the proposed Host approval flow. Core discovery is ready for a consolidated design;
  remaining implementation details should not become a long question-by-question loop.
- 2026-09-08: A documentation pass described a persistent Family plus planning contexts;
  this was later corrected because MVP membership is event-only. The durable decisions
  from that pass are global multi-account reasoning, supported recipe ingestion, MCP
  use and the pause on frontend implementation/redesign.
- 2026-09-08: User confirmed the MVP UX: Profile → Create/Join → Submit intents
  (including meal type and “I don't care”) → Host runs AI when everyone is ready
  → Chat + Basket → Member edits → post-generation Mine/Not mine ownership review
  → Host finalizes → Split bill. Products may have multiple owners. Host can modify/
  finalize without unanimous approval. This supersedes the earlier proposed flow and
  navigation alternatives; no frontend work is authorized by this documentation task.
- 2026-09-08: Survey validation refined the MVP hierarchy. The core is multi-person
  food context and intent coordination under a Host-set budget, producing one coherent
  shared meal plan and one collaboratively editable Silpo basket. The shared plan/basket
  is the primary post-generation workspace; Chat is supporting. Recipe ingestion is an
  input method rather than the core positioning. Mine/Not mine and bill splitting moved
  to secondary/demo scope after the core flow. No UI changes were authorized or made.
- 2026-09-08: User clarified that membership is event-only, not persistent Family
  membership; relevant food context is taken from Silpo MCP now, with future native
  integration allowing MCP to pull it from each person's Silpo profile; and the
  delivery menu is intentionally a mocked animation. The later official-doc review
  confirmed dedicated Silpo MCP profile and food-restriction tools.
- 2026-09-08: Implemented Google-only Supabase Auth, a protected per-user profile with
  fallback preferences, and official Silpo MCP OAuth 2.1 + PKCE. Silpo credentials and
  PKCE verifier state are encrypted server-side and linked to the Supabase user; the
  browser receives no Silpo tokens. The server fetches available personal profile,
  restriction and favorites context through each member's own MCP session. Shared-event
  architecture reserves final cart writes for the Host's MCP session.
- 2026-09-09: Implemented the no-AI party prototype: transactional event creation and
  invitation/code joining, server-enforced 10-person membership, food intents, Host
  budget, collaborative manual basket edits, multi-owner allocation, exact-cent
  per-person amounts, and Host finalization/reopening. Participants need only Supabase
  accounts; Silpo is optional for members. This established the local collaboration
  layer before real-cart synchronization was added in the next implementation step.
- 2026-09-09: Added real Silpo basket synchronization. Collaborative product additions,
  quantity changes and removals resolve through the official MCP catalog/cart tools and
  mutate only the Host's active Silpo cart. MCP failures are stored for retry; tokens
  remain encrypted and server-only. Friends still need app accounts, while their own
  Silpo connections remain optional.
- 2026-09-10: Switched the existing OpenAI-compatible AI planning provider from
  Alibaba/Qwen to DeepSeek. Normalization and group planning remain independently
  configurable and default to the cost-efficient `deepseek-v4-flash`; the provider
  abstraction, agent contracts and strict Zod schemas are unchanged.
- 2026-09-10: DeepSeek planning uses Chat Completions JSON-object mode rather than
  unsupported native JSON Schema response formatting. Zod-derived schemas are sent
  as explicit JSON instructions, responses retain strict Zod validation, and one
  validation-aware correction attempt is allowed without changing agent contracts.

## Contradictions resolved and ambiguity retained

- Persistent Family membership was an incorrect restoration. The MVP has event-only
  membership; persistent household/Family groups are deferred.
- Supabase accounts and fallback profiles are sufficient for participation. Silpo MCP
  can enrich an optionally connected member's context; only the Host connection is
  required for current real-cart writes.
- The fixed 10-person limit is preserved and applies to each event.
- Core product flows should be functional, but the delivery menu is deliberately a
  mocked animation. Real delivery/checkout integration is deferred.
- Historical statements that recipe ingestion, Chat, ownership review or bill splitting
  are core are superseded by the survey-validated hierarchy recorded above. These
  capabilities remain in the product direction at their newly stated priority levels.
