# Сільпо Family

Next.js MVP for event-based shared meal planning. App accounts use Supabase Auth
with Google; every participant can independently connect their Silpo account through
the official MCP OAuth 2.1 + PKCE flow.

## Local setup

1. Create a Supabase project and run
   `supabase/migrations/202609080001_auth_profiles_silpo_oauth.sql` in its SQL editor.
2. In Supabase Authentication, enable Google and configure the Google client ID and
   secret. Add `http://localhost:3000/auth/callback` (and the production equivalent)
   to the Supabase redirect allow-list. Google's authorized redirect URI is the
   callback URL shown on the Supabase Google provider page.
3. Copy `.env.example` to `.env.local`, fill in the Supabase URL, publishable key and
   service-role key, and generate a 32-byte encryption key with
   `openssl rand -base64 32`.
4. Run `npm install` and `npm run dev`.

The Silpo OAuth client is registered dynamically on the first connection. Its client
secret, each user's access/refresh tokens, and PKCE verifier state are encrypted before
being stored. Never expose the service-role or encryption keys through `NEXT_PUBLIC_`
variables.

## Validation

- `npm run lint`
- `npm run build`
