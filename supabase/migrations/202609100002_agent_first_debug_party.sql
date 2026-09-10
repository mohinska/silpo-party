-- Isolated agent-first debug parties. Browser roles can read their own party;
-- normalized context, evidence, cart and execution records are server-owned.
create schema if not exists debug_party_private;
revoke all on schema debug_party_private from public, anon;
grant usage on schema debug_party_private to authenticated;

create table public.debug_parties (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{8}$'),
  host_id uuid not null references auth.users(id) on delete restrict,
  budget_cents bigint check (budget_cents >= 0),
  status text not null default 'collecting' check (status in ('collecting', 'ready', 'running', 'finalized', 'sent')),
  cart_revision bigint not null default 0 check (cart_revision >= 0),
  -- Cleared by the server only after a successful build for current membership/intents.
  cart_stale boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index debug_parties_host_idx on public.debug_parties(host_id);

create table public.debug_party_members (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  participant_id uuid not null references auth.users(id) on delete restrict,
  role text not null default 'member' check (role in ('host', 'member')),
  context_status text not null default 'pending' check (context_status in ('pending', 'running', 'ready', 'failed')),
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, participant_id)
);
create index debug_party_members_participant_idx on public.debug_party_members(participant_id);
create unique index debug_party_single_host_idx on public.debug_party_members(party_id) where role = 'host';

create table public.debug_food_intents (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  participant_id uuid not null references auth.users(id) on delete restrict,
  request text not null check (char_length(btrim(request)) between 1 and 500),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, participant_id),
  foreign key (party_id, participant_id) references public.debug_party_members(party_id, participant_id) on delete cascade
);
create index debug_food_intents_participant_idx on public.debug_food_intents(participant_id);

create table public.debug_participant_contexts (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  participant_id uuid not null references auth.users(id) on delete restrict,
  intent_revision bigint not null check (intent_revision > 0),
  context_status text not null check (context_status in ('pending', 'running', 'ready', 'failed')),
  purchase_history_status text not null check (purchase_history_status in ('available', 'unavailable')),
  dietary_restrictions jsonb not null default '[]' check (jsonb_typeof(dietary_restrictions) = 'array' and jsonb_array_length(dietary_restrictions) <= 30),
  favorites jsonb not null default '[]' check (jsonb_typeof(favorites) = 'array' and jsonb_array_length(favorites) <= 30),
  recent_products jsonb not null default '[]' check (jsonb_typeof(recent_products) = 'array' and jsonb_array_length(recent_products) <= 5),
  summary text not null check (char_length(btrim(summary)) between 1 and 500),
  schema_version integer not null default 1 check (schema_version = 1),
  collected_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, participant_id),
  foreign key (party_id, participant_id) references public.debug_party_members(party_id, participant_id) on delete cascade
);
create index debug_participant_contexts_participant_idx on public.debug_participant_contexts(participant_id);

create table public.debug_chat_messages (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  participant_id uuid references auth.users(id) on delete restrict,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(btrim(content)) between 1 and 2000),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (role <> 'user' or participant_id is not null),
  unique (party_id, id),
  foreign key (party_id, participant_id) references public.debug_party_members(party_id, participant_id) on delete cascade
);
create index debug_chat_messages_party_time_idx on public.debug_chat_messages(party_id, created_at);
create index debug_chat_messages_participant_idx on public.debug_chat_messages(participant_id);
create index debug_chat_messages_member_idx on public.debug_chat_messages(party_id, participant_id);

create table public.debug_agent_runs (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  mode text not null check (mode in ('preprocess', 'build', 'chat')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  message_id uuid,
  intent_revision bigint check (intent_revision > 0),
  model text check (char_length(model) between 1 and 200),
  max_steps integer check (max_steps between 1 and 100),
  error text check (char_length(error) <= 500),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, id),
  foreign key (party_id, actor_id) references public.debug_party_members(party_id, participant_id) on delete cascade,
  foreign key (party_id, message_id) references public.debug_chat_messages(party_id, id) on delete cascade
);
create index debug_agent_runs_party_time_idx on public.debug_agent_runs(party_id, created_at);
create index debug_agent_runs_actor_idx on public.debug_agent_runs(actor_id);
create index debug_agent_runs_member_idx on public.debug_agent_runs(party_id, actor_id);
create index debug_agent_runs_message_idx on public.debug_agent_runs(party_id, message_id);
create unique index debug_agent_runs_mutation_slot_idx on public.debug_agent_runs(party_id)
  where status = 'running' and mode in ('build', 'chat');
create unique index debug_agent_runs_preprocess_slot_idx on public.debug_agent_runs(party_id, actor_id, intent_revision)
  where mode = 'preprocess' and status in ('queued', 'running');

create table public.debug_tool_events (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  run_id uuid not null,
  tool_name text not null check (char_length(tool_name) between 1 and 200),
  status text not null check (status in ('running', 'completed', 'failed')),
  duration_ms integer check (duration_ms >= 0),
  -- Application validates/redacts this compact metadata before persistence.
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192),
  created_at timestamptz not null default now(),
  foreign key (party_id, run_id) references public.debug_agent_runs(party_id, id) on delete cascade
);
create index debug_tool_events_run_idx on public.debug_tool_events(party_id, run_id);
create index debug_tool_events_party_time_idx on public.debug_tool_events(party_id, created_at);

create table public.debug_product_evidence (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  run_id uuid not null,
  source text not null check (source in ('recent_purchase', 'catalog_search', 'product_detail')),
  product_id text not null check (char_length(product_id) between 1 and 200),
  company_id text not null check (char_length(company_id) between 1 and 200),
  branch_id text not null check (char_length(branch_id) between 1 and 200),
  name text not null check (char_length(btrim(name)) between 1 and 500),
  unit text not null check (char_length(btrim(unit)) between 1 and 500),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents bigint check (discount_cents >= 0),
  image_url text,
  available boolean not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (party_id, id),
  foreign key (party_id, run_id) references public.debug_agent_runs(party_id, id) on delete cascade
);
create index debug_product_evidence_run_idx on public.debug_product_evidence(party_id, run_id);
create index debug_product_evidence_party_time_idx on public.debug_product_evidence(party_id, created_at);

create table public.debug_cart_items (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  product_id text not null check (char_length(product_id) between 1 and 200),
  company_id text not null check (char_length(company_id) between 1 and 200),
  branch_id text not null check (char_length(branch_id) between 1 and 200),
  name text not null check (char_length(btrim(name)) between 1 and 500),
  quantity numeric not null check (quantity > 0 and quantity < 'Infinity'::numeric),
  unit text not null check (char_length(btrim(unit)) between 1 and 500),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents bigint check (discount_cents >= 0),
  image_url text,
  evidence_id uuid not null,
  observed_at timestamptz not null,
  introduced_revision bigint not null check (introduced_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, product_id, company_id, branch_id),
  foreign key (party_id, evidence_id) references public.debug_product_evidence(party_id, id) on delete cascade
);
create index debug_cart_items_evidence_idx on public.debug_cart_items(party_id, evidence_id);

create table public.debug_cart_snapshots (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null unique references public.debug_parties(id) on delete cascade,
  cart_revision bigint not null check (cart_revision >= 0),
  total_cents bigint not null check (total_cents >= 0),
  finalized_at timestamptz not null default now(),
  unique (party_id, id)
);
create table public.debug_cart_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  snapshot_id uuid not null,
  product_id text not null,
  company_id text not null,
  branch_id text not null,
  name text not null,
  quantity numeric not null check (quantity > 0 and quantity < 'Infinity'::numeric),
  unit text not null,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents bigint check (discount_cents >= 0),
  image_url text,
  -- Evidence ID is copied provenance, deliberately not a cascading FK: deleting
  -- intermediate run/evidence records must never delete frozen snapshot lines.
  evidence_id uuid not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (party_id, snapshot_id) references public.debug_cart_snapshots(party_id, id) on delete cascade
);
create index debug_cart_snapshot_items_snapshot_idx on public.debug_cart_snapshot_items(party_id, snapshot_id);
create index debug_cart_snapshot_items_snapshot_id_idx on public.debug_cart_snapshot_items(snapshot_id);

create table public.debug_send_runs (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.debug_parties(id) on delete cascade,
  snapshot_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'running', 'confirmation_required', 'partial', 'completed', 'failed')),
  line_results jsonb not null default '[]' check (jsonb_typeof(line_results) = 'array' and jsonb_array_length(line_results) <= 100 and octet_length(line_results::text) <= 65536),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (party_id, idempotency_key),
  foreign key (party_id, snapshot_id) references public.debug_cart_snapshots(party_id, id) on delete cascade,
  foreign key (party_id, actor_id) references public.debug_party_members(party_id, participant_id) on delete cascade
);
create index debug_send_runs_snapshot_idx on public.debug_send_runs(party_id, snapshot_id);
create index debug_send_runs_actor_idx on public.debug_send_runs(actor_id);
create index debug_send_runs_member_idx on public.debug_send_runs(party_id, actor_id);
create unique index debug_send_runs_active_idx on public.debug_send_runs(party_id) where status = 'running';

-- The requested public helper is internal only; policies call a private wrapper.
create function public.is_debug_party_member(target_party_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.debug_party_members
    where party_id = target_party_id and participant_id = (select auth.uid())
  )
$$;
revoke all on function public.is_debug_party_member(uuid) from public, anon, authenticated, service_role;
create function debug_party_private.is_member(target_party_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_debug_party_member(target_party_id)
$$;
revoke all on function debug_party_private.is_member(uuid) from public, anon, authenticated, service_role;
grant execute on function debug_party_private.is_member(uuid) to authenticated;

create function public.create_debug_party()
returns text language plpgsql security definer set search_path = '' as $$
declare new_id uuid; new_code text; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  loop
    new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    insert into public.debug_parties(code, host_id) values (new_code, actor)
      on conflict (code) do nothing returning id into new_id;
    exit when new_id is not null;
  end loop;
  insert into public.debug_party_members(party_id, participant_id, role) values (new_id, actor, 'host');
  return new_code;
end $$;

create function public.join_debug_party(party_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare target public.debug_parties%rowtype; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if party_code is null or upper(btrim(party_code)) !~ '^[A-Z0-9]{8}$' then raise exception 'Invalid party code'; end if;
  select * into target from public.debug_parties where code = upper(btrim(party_code)) for update;
  if not found then raise exception 'Party not found'; end if;
  if exists (select 1 from public.debug_party_members where party_id = target.id and participant_id = actor) then return target.code; end if;
  if target.status in ('finalized', 'sent') then raise exception 'Party is finalized'; end if;
  if (select count(*) from public.debug_party_members where party_id = target.id) >= 10 then raise exception 'Party is full'; end if;
  insert into public.debug_party_members(party_id, participant_id) values (target.id, actor);
  update public.debug_parties set cart_stale = true, status = 'collecting', updated_at = now() where id = target.id;
  return target.code;
end $$;

-- Lock the same parent row used by join/cart/finalize before accepting intent or
-- chat writes. Direct intent writes cannot forge revision or attribution.
create function debug_party_private.guard_member_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare party_status text;
begin
  select status into party_status from public.debug_parties where id = new.party_id for update;
  if party_status in ('finalized', 'sent') then raise exception 'Party is finalized'; end if;
  if tg_table_name = 'debug_food_intents' then
    if tg_op = 'UPDATE' then
      if new.id <> old.id or new.party_id <> old.party_id or new.participant_id <> old.participant_id then raise exception 'Intent attribution is immutable'; end if;
      new.revision := old.revision + 1;
      new.created_at := old.created_at;
    else
      new.revision := 1;
    end if;
    new.updated_at := now();
    update public.debug_party_members set context_status = 'pending', updated_at = now()
      where party_id = new.party_id and participant_id = new.participant_id;
    update public.debug_parties set cart_stale = true, status = 'collecting', updated_at = now() where id = new.party_id;
  end if;
  return new;
end $$;
revoke all on function debug_party_private.guard_member_write() from public, anon, authenticated, service_role;
create trigger debug_intent_guard before insert or update on public.debug_food_intents
  for each row execute function debug_party_private.guard_member_write();
create trigger debug_chat_guard before insert or update on public.debug_chat_messages
  for each row execute function debug_party_private.guard_member_write();

-- Service-only RPC: authorization, optimistic revision, and mutation are one
-- transaction. Product fields always come from party-scoped recorded evidence.
-- mutation: {type: add|replace|quantity|remove, evidenceId?, itemId?, quantity?}.
create function public.advance_debug_cart_revision(
  target_party_id uuid, actor_id uuid, expected_revision bigint, mutation jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.debug_parties%rowtype; evidence public.debug_product_evidence%rowtype;
  operation text := mutation->>'type'; item uuid; qty numeric; next_revision bigint;
begin
  if actor_id is null or not exists (select 1 from public.debug_party_members where party_id = target_party_id and participant_id = actor_id) then
    raise exception 'Party membership required' using errcode = '42501';
  end if;
  select * into target from public.debug_parties where id = target_party_id for update;
  if not found or target.status in ('finalized', 'sent') then raise exception 'Party is unavailable'; end if;
  if expected_revision is null or expected_revision < 0 then raise exception 'Invalid expected revision'; end if;
  if target.cart_revision <> expected_revision then
    return jsonb_build_object('status', 'stale', 'currentRevision', target.cart_revision);
  end if;
  if operation is null or operation not in ('add', 'replace', 'quantity', 'remove') then raise exception 'Invalid cart mutation'; end if;
  if operation <> 'remove' then
    qty := (mutation->>'quantity')::numeric;
    if qty is null or not (qty > 0 and qty < 'Infinity'::numeric) then raise exception 'Invalid quantity'; end if;
  end if;
  if operation <> 'add' then
    select id into item from public.debug_cart_items where party_id = target.id and id = (mutation->>'itemId')::uuid;
    if not found then raise exception 'Cart item not found'; end if;
  end if;
  next_revision := target.cart_revision + 1;
  if operation in ('add', 'replace') then
    select * into evidence from public.debug_product_evidence where party_id = target.id and id = (mutation->>'evidenceId')::uuid;
    if not found or not evidence.available then raise exception 'Available product evidence required'; end if;
    if operation = 'replace' then delete from public.debug_cart_items where id = item; end if;
    if (select count(*) from public.debug_cart_items where party_id = target.id) >= 100 then raise exception 'Cart is full'; end if;
    insert into public.debug_cart_items(party_id, product_id, company_id, branch_id, name, quantity, unit, unit_price_cents,
      discount_cents, image_url, evidence_id, observed_at, introduced_revision)
    values (target.id, evidence.product_id, evidence.company_id, evidence.branch_id, evidence.name, qty, evidence.unit,
      evidence.unit_price_cents, evidence.discount_cents, evidence.image_url, evidence.id, evidence.observed_at, next_revision)
    returning id into item;
  elsif operation = 'quantity' then
    update public.debug_cart_items set quantity = qty, updated_at = now() where id = item;
  else
    delete from public.debug_cart_items where id = item;
  end if;
  update public.debug_parties set cart_revision = next_revision, updated_at = now() where id = target.id;
  return jsonb_build_object('status', 'applied', 'currentRevision', next_revision, 'itemId', item);
end $$;

create function public.finalize_debug_party(target_party_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target public.debug_parties%rowtype; snapshot uuid; total bigint; actor uuid := auth.uid(); line_count integer;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into target from public.debug_parties where id = target_party_id for update;
  if not found or target.host_id <> actor then raise exception 'Host ownership required' using errcode = '42501'; end if;
  if target.status in ('finalized', 'sent') then
    select id into snapshot from public.debug_cart_snapshots where party_id = target.id;
    if snapshot is null then raise exception 'Finalized snapshot missing'; end if;
    return snapshot;
  end if;
  if target.status = 'running' or exists (select 1 from public.debug_agent_runs where party_id = target.id and status = 'running') then raise exception 'Agent run is active'; end if;
  if target.cart_stale then raise exception 'Cart requires a new build'; end if;
  if exists (
    select 1 from public.debug_party_members member
    left join public.debug_food_intents intent on intent.party_id = member.party_id and intent.participant_id = member.participant_id
    left join public.debug_participant_contexts context on context.party_id = member.party_id and context.participant_id = member.participant_id
    where member.party_id = target.id and (member.context_status <> 'ready' or intent.id is null or context.id is null
      or context.context_status <> 'ready' or context.intent_revision <> intent.revision)
  ) then raise exception 'Participant contexts are stale'; end if;
  select count(*), sum(round(quantity * unit_price_cents))::bigint into line_count, total from public.debug_cart_items where party_id = target.id;
  if line_count = 0 or line_count > 100 then raise exception 'Cart must contain 1 to 100 items'; end if;
  insert into public.debug_cart_snapshots(party_id, cart_revision, total_cents) values (target.id, target.cart_revision, total) returning id into snapshot;
  insert into public.debug_cart_snapshot_items(party_id, snapshot_id, product_id, company_id, branch_id, name, quantity, unit,
    unit_price_cents, discount_cents, image_url, evidence_id, observed_at)
  select party_id, snapshot, product_id, company_id, branch_id, name, quantity, unit, unit_price_cents, discount_cents,
    image_url, evidence_id, observed_at from public.debug_cart_items where party_id = target.id;
  update public.debug_parties set status = 'finalized', updated_at = now() where id = target.id;
  return snapshot;
end $$;

revoke all on function public.create_debug_party(), public.join_debug_party(text), public.finalize_debug_party(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_debug_party(), public.join_debug_party(text), public.finalize_debug_party(uuid) to authenticated;
revoke all on function public.advance_debug_cart_revision(uuid, uuid, bigint, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.advance_debug_cart_revision(uuid, uuid, bigint, jsonb) to service_role;

-- Explicit grants also remove privileges inherited from existing public-schema
-- default privileges. All twelve tables receive tenant-scoped SELECT policies.
do $$
declare table_name text;
begin
  foreach table_name in array array['debug_parties', 'debug_party_members', 'debug_food_intents', 'debug_participant_contexts',
    'debug_chat_messages', 'debug_agent_runs', 'debug_tool_events', 'debug_product_evidence', 'debug_cart_items',
    'debug_cart_snapshots', 'debug_cart_snapshot_items', 'debug_send_runs']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', table_name);
    execute format('grant select on table public.%I to authenticated, service_role', table_name);
    execute format('create policy "Members read debug party" on public.%I for select to authenticated using (debug_party_private.is_member(%I))',
      table_name, case when table_name = 'debug_parties' then 'id' else 'party_id' end);
    if table_name not in ('debug_cart_items', 'debug_cart_snapshots', 'debug_cart_snapshot_items') then
      execute format('grant insert, update, delete on table public.%I to service_role', table_name);
    end if;
  end loop;
end $$;

grant insert (party_id, participant_id, request), update (request) on public.debug_food_intents to authenticated;
create policy "Members insert their own debug intent" on public.debug_food_intents for insert to authenticated
  with check (participant_id = (select auth.uid()) and debug_party_private.is_member(party_id));
create policy "Members update their own debug intent" on public.debug_food_intents for update to authenticated
  using (participant_id = (select auth.uid()) and debug_party_private.is_member(party_id))
  with check (participant_id = (select auth.uid()) and debug_party_private.is_member(party_id));
grant insert (party_id, participant_id, role, content) on public.debug_chat_messages to authenticated;
create policy "Members insert their own debug message" on public.debug_chat_messages for insert to authenticated
  with check (participant_id = (select auth.uid()) and role = 'user' and debug_party_private.is_member(party_id));

-- Budget updates are server-owned: the authenticated application service checks
-- Host ownership and open lifecycle before using its service-role client.
-- Snapshot tables are SELECT-only even for service_role; the Host RPC is the
-- only application writer. Cascading party deletion still works for cleanup.
