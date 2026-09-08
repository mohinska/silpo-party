create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  allergies text not null default '', dietary_restrictions text not null default '',
  dislikes text not null default '', preferences text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "Users read own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "Users update own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- RLS is enabled with no browser/user policies: only the server service role accesses these tables.
create table if not exists public.silpo_oauth_clients (
  redirect_uri text primary key, client_id text not null, client_secret_ciphertext text,
  created_at timestamptz not null default now()
);
alter table public.silpo_oauth_clients enable row level security;
create table if not exists public.silpo_oauth_states (
  state_hash text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null, code_verifier_ciphertext text not null,
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
alter table public.silpo_oauth_states enable row level security;
create index if not exists silpo_oauth_states_expires_at_idx on public.silpo_oauth_states(expires_at);
create table if not exists public.silpo_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  redirect_uri text not null,
  access_token_ciphertext text not null, refresh_token_ciphertext text,
  token_type text not null default 'Bearer', scope text, expires_at timestamptz,
  connected_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.silpo_connections enable row level security;
revoke all on public.silpo_oauth_clients from anon, authenticated;
revoke all on public.silpo_oauth_states from anon, authenticated;
revoke all on public.silpo_connections from anon, authenticated;
