-- The commerce adapter requires an opaque cartVersion on every mutation.
-- Persist the baseline token and accept a changed token only when all other
-- verified cart state equals the immutable expected snapshot.
create or replace function public.agent_v2_cart_prepare(p_operation_id uuid,p_worker_id text,p_baseline jsonb,p_expected_cart jsonb,p_changes jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare op public.party_cart_operations;
begin
 select * into op from public.party_cart_operations where id=p_operation_id for update;
 if op.id is null or op.status<>'applying' or op.worker_id is distinct from p_worker_id then raise exception 'Cart writer required'; end if;
 if op.baseline is not null then raise exception 'Cart plan is immutable'; end if;
 if jsonb_typeof(p_baseline) is distinct from 'object' or jsonb_typeof(p_expected_cart) is distinct from 'object' or jsonb_typeof(p_changes) is distinct from 'array' or p_baseline->>'cartId' is distinct from op.cart_id or p_expected_cart->'snapshot'->>'cartId' is distinct from op.cart_id then raise exception 'Invalid cart plan'; end if;
 if nullif(p_baseline->>'cartVersion','') is null or nullif(p_expected_cart->'snapshot'->>'cartVersion','') is null then raise exception 'Conditional cartVersion required'; end if;
 update public.party_cart_operations set baseline=p_baseline,expected_cart=p_expected_cart,intended_changes=p_changes,updated_at=clock_timestamp() where id=op.id;
end $$;

create or replace function public.agent_v2_cart_finish(p_operation_id uuid,p_worker_id text,p_status text,p_readback jsonb,p_private_error text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare op public.party_cart_operations;
begin
 select * into op from public.party_cart_operations where id=p_operation_id for update;
 if op.id is null or op.status not in ('applying','unknown') or op.worker_id is distinct from p_worker_id then raise exception 'Cart writer required'; end if;
 if p_status not in ('verified','failed','unknown') then raise exception 'Invalid cart completion'; end if;
 if op.status='unknown' and p_status='failed' then raise exception 'Ambiguous cart requires reconciliation'; end if;
 if p_status='verified' and (op.expected_cart is null or nullif(p_readback->>'cartVersion','') is null or (p_readback-('cartVersion'::text)) is distinct from ((op.expected_cart->'snapshot')-('cartVersion'::text))) then raise exception 'Exact expected readback required'; end if;
 update public.party_cart_operations set status=p_status,readback=p_readback,private_error=p_private_error,updated_at=clock_timestamp() where id=op.id;
end $$;

revoke all on function public.agent_v2_cart_prepare(uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.agent_v2_cart_finish(uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.agent_v2_cart_prepare(uuid,text,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.agent_v2_cart_finish(uuid,text,text,jsonb,text) to service_role;
