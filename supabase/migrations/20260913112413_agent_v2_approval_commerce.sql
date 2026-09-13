-- Private commerce evidence is captured inside the existing locked approval
-- transaction. Legacy approvals may lack it; application execution fails closed.
alter table public.party_cart_operations add column approved_commerce jsonb;
create function public.agent_v2_capture_approved_commerce() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='INSERT' then
  select checkpoint->'commerce' into new.approved_commerce from public.party_agent_workspaces where party_id=new.party_id;
 elsif new.approved_commerce is distinct from old.approved_commerce then
  raise exception 'Approved commerce is immutable';
 end if;
 return new;
end $$;
create trigger capture_approved_commerce before insert or update on public.party_cart_operations for each row execute function public.agent_v2_capture_approved_commerce();
revoke all on function public.agent_v2_capture_approved_commerce() from public,anon,authenticated;
grant execute on function public.agent_v2_capture_approved_commerce() to service_role;
