create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  input_message_id uuid not null references public.party_chat_messages(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  stage text not null default 'intent' check (stage in ('intent', 'supervisor', 'recipe', 'ingredients', 'product_search', 'proposal', 'done')),
  progress_message text not null default 'Запит у черзі',
  attempt smallint not null default 0 check (attempt >= 0 and attempt <= 3),
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.party_chat_messages
  add column agent_run_id uuid references public.agent_runs(id) on delete set null;

create index agent_runs_party_created_idx
  on public.agent_runs(party_id, created_at desc);

create index agent_runs_queue_idx
  on public.agent_runs(status, created_at)
  where status = 'queued';

create unique index party_chat_messages_agent_reply_idx
  on public.party_chat_messages(agent_run_id)
  where role = 'assistant' and agent_run_id is not null;

create unique index agent_runs_running_party_idx
  on public.agent_runs(party_id)
  where status = 'running';

alter table public.agent_runs enable row level security;

create policy "Members read party agent runs"
  on public.agent_runs for select to authenticated
  using (public.is_party_member(party_id));

grant select on public.agent_runs to authenticated;
revoke insert, update, delete on public.agent_runs from anon, authenticated;
grant select, insert, update on public.agent_runs to service_role;

-- The worker claims work through this function so concurrent dispatchers cannot
-- execute the same run. Execution is restricted to service_role.
create or replace function public.claim_next_agent_run(target_run_id uuid default null)
returns setof public.agent_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select id
    from public.agent_runs
    where status = 'queued'
      and (target_run_id is null or id = target_run_id)
    order by created_at
    for update skip locked
    limit 1
  )
  update public.agent_runs run
  set status = 'running',
      attempt = run.attempt + 1,
      started_at = coalesce(run.started_at, now()),
      updated_at = now(),
      progress_message = 'Розбираю запит'
  from candidate
  where run.id = candidate.id
  returning run.*;
end;
$$;

revoke all on function public.claim_next_agent_run(uuid) from public;
grant execute on function public.claim_next_agent_run(uuid) to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'party_chat_messages'
  ) then
    alter publication supabase_realtime add table public.party_chat_messages;
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'agent_runs'
  ) then
    alter publication supabase_realtime add table public.agent_runs;
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_meal_proposals'
  ) then
    alter publication supabase_realtime add table public.ai_meal_proposals;
  end if;
end
$$;
