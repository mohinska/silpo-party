# Сільпо Family

Next.js MVP for event-based shared meal planning. App accounts use Supabase Auth
with Google. Silpo connection uses the official MCP OAuth 2.1 + PKCE flow; members
can participate without it, while real-cart writes use the Host's connection.

## Local setup

For a complete localhost setup and multi-account testing walkthrough, see
[LOCAL_DEVELOPMENT_TESTING.md](LOCAL_DEVELOPMENT_TESTING.md).

1. Create a Supabase project and run these migrations in its SQL editor, in order:
   `supabase/migrations/202609080001_auth_profiles_silpo_oauth.sql`, then
   `supabase/migrations/202609090001_party_prototype.sql`, then
   `supabase/migrations/202609090002_silpo_cart_sync.sql`, then
   `supabase/migrations/202609090003_fix_party_code_generation.sql`, then
   `supabase/migrations/202609100001_ai_meal_proposals.sql`, then
   `supabase/migrations/20260912120000_remove_debug_party.sql`, then
   `supabase/migrations/20260912121000_party_agent_workspace.sql`. The cleanup
   migration is also safe for existing databases that applied the temporary
   debug migrations.
2. In Supabase Authentication, enable Google and configure the Google client ID and
   secret. Add `http://localhost:3000/auth/callback` (and the production equivalent)
   to the Supabase redirect allow-list. Google's authorized redirect URI is the
   callback URL shown on the Supabase Google provider page.
3. Copy `.env.example` to `.env.local`, fill in the Supabase URL, publishable key and
   service-role key, and generate a 32-byte encryption key with
   `openssl rand -base64 32`.
4. Run `npm install` and `npm run dev`.

## No-AI party prototype

Open `/parties` after signing in. A Host can create an event and share its `/join/CODE`
link. Members use their own Google-backed app accounts, but do not need Silpo accounts.
Everyone can submit food intent and collaboratively edit the basket. Product searches,
quantity changes and removals are mirrored into the Host's real Silpo cart through the
Host's server-side MCP session. The Host sets the budget and finalizes it. Item
assignments calculate exactly how much each member owes the Host.

For a real test, the Host must connect Silpo from `/profile` and already have an active
Silpo cart with a delivery method/store selected. The shared event should use a
dedicated empty cart because this prototype manages quantities for matched products.

## Local agent harness

The repository includes a terminal-only observer for the canonical agent flow. It
does not expose a production route or mutate a Silpo cart; it prints Intent,
Supervisor and read-only catalog-search traces.

```bash
export AI_AGENT_HARNESS_SECRET="$(openssl rand -hex 32)"
npm run dev
python3 scripts/agent_harness.py run
```

The script opens Silpo OAuth in a browser, keeps the access token in memory, and
calls only `http://localhost:3000/api/agent-harness`. Set `AGENT_HARNESS_URL` only
when using another local port.

The Silpo OAuth client is registered dynamically on the first connection. Its client
secret, each user's access/refresh tokens, and PKCE verifier state are encrypted before
being stored. Never expose the service-role or encryption keys through `NEXT_PUBLIC_`
variables.

## Validation

- `npm run lint`
- `npm run build`
