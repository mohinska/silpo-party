create extension if not exists pgcrypto;

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{8}$'),
  title text not null check (char_length(title) between 1 and 80),
  host_id uuid not null references auth.users(id) on delete cascade,
  budget_cents bigint not null default 0 check (budget_cents >= 0),
  status text not null default 'collecting' check (status in ('collecting', 'finalized')),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.party_members (
  party_id uuid not null references public.parties(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('host', 'member')),
  display_name text not null check (char_length(display_name) between 1 and 100),
  email text,
  avatar_url text,
  joined_at timestamptz not null default now(),
  primary key (party_id, user_id)
);

create table public.food_intents (
  party_id uuid not null references public.parties(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  dish_name text not null default '',
  description text not null default '',
  content_url text not null default '',
  indifferent boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (party_id, user_id),
  foreign key (party_id, user_id) references public.party_members(party_id, user_id) on delete cascade
);

create table public.basket_items (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  quantity numeric(10,2) not null default 1 check (quantity > 0 and quantity <= 10000),
  unit text not null default 'шт.' check (char_length(unit) between 1 and 20),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  added_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (party_id, added_by) references public.party_members(party_id, user_id)
);

create table public.basket_item_shares (
  item_id uuid not null references public.basket_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

create index party_members_user_id_idx on public.party_members(user_id);
create index basket_items_party_id_idx on public.basket_items(party_id);
create index basket_item_shares_user_id_idx on public.basket_item_shares(user_id);

create or replace function public.is_party_member(target_party_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from party_members where party_id = target_party_id and user_id = auth.uid()) $$;

create or replace function public.is_party_host(target_party_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from parties where id = target_party_id and host_id = auth.uid()) $$;

create or replace function public.is_party_open(target_party_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from parties where id = target_party_id and status = 'collecting') $$;

revoke all on function public.is_party_member(uuid) from public;
revoke all on function public.is_party_host(uuid) from public;
revoke all on function public.is_party_open(uuid) from public;
grant execute on function public.is_party_member(uuid), public.is_party_host(uuid), public.is_party_open(uuid) to authenticated;

create or replace function public.create_party(
  party_title text,
  member_name text,
  member_email text default null,
  member_avatar text default null
) returns text language plpgsql security definer set search_path = public as $$
declare new_party_id uuid; new_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(party_title)) not between 1 and 80 then raise exception 'Invalid party title'; end if;
  loop
    new_code := upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from parties where code = new_code);
  end loop;
  insert into parties(code, title, host_id) values(new_code, trim(party_title), auth.uid()) returning id into new_party_id;
  insert into party_members(party_id, user_id, role, display_name, email, avatar_url)
  values(new_party_id, auth.uid(), 'host', left(coalesce(nullif(trim(member_name), ''), 'Host'), 100), member_email, member_avatar);
  return new_code;
end $$;

create or replace function public.join_party(
  party_code text,
  member_name text,
  member_email text default null,
  member_avatar text default null
) returns text language plpgsql security definer set search_path = public as $$
declare target_party parties%rowtype; member_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into target_party from parties where code = upper(trim(party_code)) for update;
  if not found then raise exception 'Party not found'; end if;
  if target_party.status <> 'collecting' then raise exception 'Party is finalized'; end if;
  if exists(select 1 from party_members where party_id = target_party.id and user_id = auth.uid()) then return target_party.code; end if;
  select count(*) into member_count from party_members where party_id = target_party.id;
  if member_count >= 10 then raise exception 'Party is full'; end if;
  insert into party_members(party_id, user_id, role, display_name, email, avatar_url)
  values(target_party.id, auth.uid(), 'member', left(coalesce(nullif(trim(member_name), ''), 'Учасник'), 100), member_email, member_avatar);
  return target_party.code;
end $$;

revoke all on function public.create_party(text, text, text, text) from public;
revoke all on function public.join_party(text, text, text, text) from public;
grant execute on function public.create_party(text, text, text, text) to authenticated;
grant execute on function public.join_party(text, text, text, text) to authenticated;

create or replace function public.set_item_shares(target_item_id uuid, owner_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare target_party_id uuid; invalid_owner_count integer;
begin
  select party_id into target_party_id from basket_items where id = target_item_id for update;
  if not found or not is_party_member(target_party_id) or not is_party_open(target_party_id) then
    raise exception 'Item is unavailable';
  end if;
  if coalesce(array_length(owner_ids, 1), 0) = 0 then raise exception 'Choose at least one owner'; end if;
  select count(*) into invalid_owner_count from unnest(owner_ids) owner_id
  where not exists(select 1 from party_members where party_id = target_party_id and user_id = owner_id);
  if invalid_owner_count > 0 then raise exception 'Invalid item owner'; end if;
  delete from basket_item_shares where item_id = target_item_id;
  insert into basket_item_shares(item_id, user_id)
  select target_item_id, owner_id from unnest(owner_ids) owner_id group by owner_id;
end $$;
revoke all on function public.set_item_shares(uuid, uuid[]) from public;
grant execute on function public.set_item_shares(uuid, uuid[]) to authenticated;

alter table public.parties enable row level security;
alter table public.party_members enable row level security;
alter table public.food_intents enable row level security;
alter table public.basket_items enable row level security;
alter table public.basket_item_shares enable row level security;

create policy "Members read their parties" on public.parties for select to authenticated
using (public.is_party_member(id));
create policy "Hosts update their parties" on public.parties for update to authenticated
using (public.is_party_host(id)) with check (public.is_party_host(id));

create policy "Members read fellow members" on public.party_members for select to authenticated
using (public.is_party_member(party_id));

create policy "Members read party intents" on public.food_intents for select to authenticated
using (public.is_party_member(party_id));
create policy "Members add own intent" on public.food_intents for insert to authenticated
with check (user_id = auth.uid() and public.is_party_member(party_id) and public.is_party_open(party_id));
create policy "Members update own intent" on public.food_intents for update to authenticated
using (user_id = auth.uid() and public.is_party_member(party_id) and public.is_party_open(party_id))
with check (user_id = auth.uid() and public.is_party_member(party_id) and public.is_party_open(party_id));

create policy "Members read basket" on public.basket_items for select to authenticated
using (public.is_party_member(party_id));
create policy "Members add basket items" on public.basket_items for insert to authenticated
with check (added_by = auth.uid() and public.is_party_member(party_id) and public.is_party_open(party_id));
create policy "Members update basket items" on public.basket_items for update to authenticated
using (public.is_party_member(party_id) and public.is_party_open(party_id))
with check (public.is_party_member(party_id) and public.is_party_open(party_id));
create policy "Members delete basket items" on public.basket_items for delete to authenticated
using (public.is_party_member(party_id) and public.is_party_open(party_id));

create policy "Members read basket shares" on public.basket_item_shares for select to authenticated
using (exists(select 1 from public.basket_items item where item.id = item_id and public.is_party_member(item.party_id)));

grant select, update on public.parties to authenticated;
grant select on public.party_members to authenticated;
grant select, insert, update on public.food_intents to authenticated;
grant select, insert, update, delete on public.basket_items to authenticated;
grant select on public.basket_item_shares to authenticated;

-- Members may see one another's fallback food profiles only while they share
-- an event. Silpo OAuth tokens and personal MCP responses remain server-only.
create or replace function public.shares_party_with(target_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1
    from party_members mine
    join party_members theirs on theirs.party_id = mine.party_id
    where mine.user_id = auth.uid() and theirs.user_id = target_user_id
  )
$$;
revoke all on function public.shares_party_with(uuid) from public;
grant execute on function public.shares_party_with(uuid) to authenticated;

create policy "Party members read shared food profiles" on public.profiles
for select to authenticated using (public.shares_party_with(id));
grant select on public.profiles to authenticated;
