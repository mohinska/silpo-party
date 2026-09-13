-- No automatic lease expiry: MCP cannot fence an in-flight remote writer.
alter table public.party_cart_operations add column cart_id text, add column worker_id text, add column intended_changes jsonb;
create unique index party_cart_one_writer_idx on public.party_cart_operations(party_id) where status in ('applying','unknown');
create unique index host_cart_one_writer_idx on public.party_cart_operations(approved_by,cart_id) where status in ('applying','unknown');
create index party_cart_previous_verified_idx on public.party_cart_operations(party_id,cart_id,updated_at desc) where status='verified';

create function public.agent_v2_cart_acquire(p_operation_id uuid,p_actor_id uuid,p_worker_id text,p_cart_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare op public.party_cart_operations; w public.party_agent_workspaces; d public.party_agent_drafts; previous jsonb;
begin
 select * into op from public.party_cart_operations where id=p_operation_id;
 if op.id is null or op.approved_by<>p_actor_id or not exists(select 1 from public.parties where id=op.party_id and host_id=p_actor_id) then raise exception 'Host authority required'; end if;
 if nullif(btrim(p_worker_id),'') is null or nullif(btrim(p_cart_id),'') is null then raise exception 'Cart and worker required'; end if;
 -- Same lock order as source arrival/approval: workspace, then operation.
 select * into w from public.party_agent_workspaces where party_id=op.party_id for update;
 select * into op from public.party_cart_operations where id=p_operation_id for update;
 if op.status='verified' then return to_jsonb(op); end if;
 if op.status<>'approved' then raise exception 'Cart operation already acquired'; end if;
 if w.source_revision<>w.processed_source_revision then raise exception 'Pending source events'; end if;
 select * into d from public.party_agent_drafts where party_id=op.party_id and draft_revision=op.draft_revision;
 if d.party_id is null or not d.ready or d.input_revision<>w.input_revision or d.draft_revision<>w.draft_revision or d.projection<>op.approved_snapshot then raise exception 'Exact current ready draft required'; end if;
 if exists(select 1 from public.party_cart_operations where status in ('applying','unknown') and (party_id=op.party_id or (approved_by=p_actor_id and cart_id=p_cart_id))) then raise exception 'Cart writer already active'; end if;
 begin
  update public.party_cart_operations set status='applying',cart_id=p_cart_id,worker_id=p_worker_id,updated_at=clock_timestamp() where id=op.id returning * into op;
 exception when unique_violation then raise exception 'Cart writer already active'; end;
 select expected_cart->'managed' into previous from public.party_cart_operations where party_id=op.party_id and cart_id=p_cart_id and status='verified' order by updated_at desc limit 1;
 return to_jsonb(op)||jsonb_build_object('previous_managed',coalesce(previous,'[]'::jsonb));
end $$;

create function public.agent_v2_cart_prepare(p_operation_id uuid,p_worker_id text,p_baseline jsonb,p_expected_cart jsonb,p_changes jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare op public.party_cart_operations;
begin
 select * into op from public.party_cart_operations where id=p_operation_id for update;
 if op.id is null or op.status<>'applying' or op.worker_id is distinct from p_worker_id then raise exception 'Cart writer required'; end if;
 if op.baseline is not null then raise exception 'Cart plan is immutable'; end if;
 if jsonb_typeof(p_baseline) is distinct from 'object' or jsonb_typeof(p_expected_cart) is distinct from 'object' or jsonb_typeof(p_changes) is distinct from 'array' or p_baseline->>'cartId' is distinct from op.cart_id or p_expected_cart->'snapshot'->>'cartId' is distinct from op.cart_id then raise exception 'Invalid cart plan'; end if;
 update public.party_cart_operations set baseline=p_baseline,expected_cart=p_expected_cart,intended_changes=p_changes,updated_at=clock_timestamp() where id=op.id;
end $$;

create function public.agent_v2_cart_finish(p_operation_id uuid,p_worker_id text,p_status text,p_readback jsonb,p_private_error text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare op public.party_cart_operations;
begin
 select * into op from public.party_cart_operations where id=p_operation_id for update;
 if op.id is null or op.status not in ('applying','unknown') or op.worker_id is distinct from p_worker_id then raise exception 'Cart writer required'; end if;
 if p_status not in ('verified','failed','unknown') then raise exception 'Invalid cart completion'; end if;
 -- Unknown can only be cleared by exact full expected readback, never baseline.
 if op.status='unknown' and p_status='failed' then raise exception 'Ambiguous cart requires reconciliation'; end if;
 if p_status='verified' and (op.expected_cart is null or p_readback is distinct from op.expected_cart->'snapshot') then raise exception 'Exact expected readback required'; end if;
 update public.party_cart_operations set status=p_status,readback=p_readback,private_error=p_private_error,updated_at=clock_timestamp() where id=op.id;
end $$;

create function public.agent_v2_cart_immutable_plan() returns trigger language plpgsql set search_path='' as $$
begin
 if old.baseline is not null and (new.baseline is distinct from old.baseline or new.expected_cart is distinct from old.expected_cart or new.intended_changes is distinct from old.intended_changes) then raise exception 'Cart plan is immutable'; end if;
 if old.worker_id is not null and (new.worker_id is distinct from old.worker_id or new.cart_id is distinct from old.cart_id) then raise exception 'Cart writer is immutable'; end if;
 return new;
end $$;
create trigger immutable_cart_plan before update on public.party_cart_operations for each row execute function public.agent_v2_cart_immutable_plan();
revoke all on function public.agent_v2_cart_acquire(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.agent_v2_cart_prepare(uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.agent_v2_cart_finish(uuid,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.agent_v2_cart_immutable_plan() from public,anon,authenticated;
grant execute on function public.agent_v2_cart_acquire(uuid,uuid,text,text) to service_role;
grant execute on function public.agent_v2_cart_prepare(uuid,text,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.agent_v2_cart_finish(uuid,text,text,jsonb,text) to service_role;
grant execute on function public.agent_v2_cart_immutable_plan() to service_role;
