-- One shared team-testing party. It deliberately has no Host until the first
-- authenticated participant claims it through the locked join RPC.
alter table public.debug_parties alter column host_id drop not null;

insert into public.debug_parties (code, host_id)
values ('AIDEBUG1', null)
on conflict (code) do nothing;

create or replace function public.join_debug_party(party_code text)
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

  if target.host_id is null then
    update public.debug_parties set host_id = actor, updated_at = now() where id = target.id;
    insert into public.debug_party_members(party_id, participant_id, role) values (target.id, actor, 'host');
  else
    insert into public.debug_party_members(party_id, participant_id) values (target.id, actor);
    update public.debug_parties set cart_stale = true, status = 'collecting', updated_at = now() where id = target.id;
  end if;
  return target.code;
end $$;

-- Debug party creation is no longer a user-facing or public-RPC capability.
drop function public.create_debug_party();
