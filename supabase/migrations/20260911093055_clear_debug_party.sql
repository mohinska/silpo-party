-- Host-only reset for the reusable AI Debug party. Membership and budget are
-- intentionally retained; all per-session party content is discarded.
create or replace function public.clear_debug_party(target_party_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target public.debug_parties%rowtype; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into target from public.debug_parties where id = target_party_id for update;
  if not found or target.host_id <> actor then raise exception 'Host ownership required' using errcode = '42501'; end if;
  if exists (select 1 from public.debug_agent_runs where party_id = target.id and status in ('queued', 'running')) then
    raise exception 'Agent run is active';
  end if;

  delete from public.debug_send_runs where party_id = target.id;
  delete from public.debug_cart_snapshots where party_id = target.id;
  delete from public.debug_cart_items where party_id = target.id;
  delete from public.debug_agent_runs where party_id = target.id;
  delete from public.debug_food_intents where party_id = target.id;
  delete from public.debug_participant_contexts where party_id = target.id;
  delete from public.debug_chat_messages where party_id = target.id;
  update public.debug_party_members
    set context_status = 'pending', updated_at = now()
    where party_id = target.id;
  update public.debug_parties
    set status = 'collecting', cart_revision = 0, cart_stale = true, updated_at = now()
    where id = target.id;
end $$;

revoke all on function public.clear_debug_party(uuid) from public, anon, authenticated, service_role;
grant execute on function public.clear_debug_party(uuid) to authenticated;
