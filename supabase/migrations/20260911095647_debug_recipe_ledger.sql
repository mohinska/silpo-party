create table public.debug_recipe_records (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  recipe_id text not null check (char_length(recipe_id) between 1 and 200),
  title text not null check (char_length(btrim(title)) between 1 and 500),
  source_url text,
  base_servings integer not null check (base_servings > 0),
  ingredients jsonb not null check (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) between 1 and 100 and octet_length(ingredients::text) <= 32768),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, recipe_id)
);
create index debug_recipe_records_party_time_idx on public.debug_recipe_records(party_id, created_at);

alter table public.debug_recipe_records enable row level security;
revoke all on table public.debug_recipe_records from public, anon, authenticated, service_role;
grant select on table public.debug_recipe_records to authenticated, service_role;
grant insert, update, delete on table public.debug_recipe_records to service_role;
create policy "Members read debug recipe records" on public.debug_recipe_records for select to authenticated
  using (debug_party_private.is_member(party_id));

-- Recipe records contain only normalized source facts; clearing a reusable party
-- must remove them together with the cart and chat state.
create or replace function public.clear_debug_party(target_party_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.debug_parties%rowtype; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into target from public.debug_parties where id = target_party_id for update;
  if not found or target.host_id <> actor then raise exception 'Host ownership required' using errcode = '42501'; end if;
  if exists (select 1 from public.debug_agent_runs where party_id = target.id and status in ('queued', 'running')) then raise exception 'Agent run is active'; end if;
  delete from public.debug_send_runs where party_id = target.id;
  delete from public.debug_cart_snapshots where party_id = target.id;
  delete from public.debug_cart_items where party_id = target.id;
  delete from public.debug_agent_runs where party_id = target.id;
  delete from public.debug_recipe_records where party_id = target.id;
  delete from public.debug_food_intents where party_id = target.id;
  delete from public.debug_participant_contexts where party_id = target.id;
  delete from public.debug_chat_messages where party_id = target.id;
  update public.debug_party_members set context_status = 'pending', updated_at = now() where party_id = target.id;
  update public.debug_parties set status = 'collecting', cart_revision = 0, cart_stale = true, updated_at = now() where id = target.id;
end $$;

revoke all on function public.clear_debug_party(uuid) from public, anon, authenticated, service_role;
grant execute on function public.clear_debug_party(uuid) to authenticated;
