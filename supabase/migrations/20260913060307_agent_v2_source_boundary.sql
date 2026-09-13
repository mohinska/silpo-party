-- Source arrival is distinct from a meaningful domain edit. Every new source
-- event closes approval/publication until the serial worker has interpreted it.
alter table public.party_agent_workspaces
 add column source_revision bigint not null default 0 check (source_revision between 0 and 9007199254740991),
 add column processed_source_revision bigint not null default 0,
 add constraint source_processing_order check (processed_source_revision between 0 and source_revision);
alter table public.party_agent_events add column source_sequence bigint;
with numbered as (
 select id,row_number() over (partition by party_id order by created_at,id) as sequence
 from public.party_agent_events
) update public.party_agent_events e set source_sequence=n.sequence from numbered n where e.id=n.id;
alter table public.party_agent_events alter column source_sequence set not null;
alter table public.party_agent_events add constraint party_source_sequence unique(party_id,source_sequence);
update public.party_agent_workspaces w set
 source_revision=coalesce((select max(e.source_sequence) from public.party_agent_events e where e.party_id=w.party_id),0),
 processed_source_revision=coalesce((select min(e.source_sequence)-1 from public.party_agent_events e join public.party_agent_queue q on q.event_id=e.id where e.party_id=w.party_id and q.status in ('queued','running')), (select max(e.source_sequence) from public.party_agent_events e where e.party_id=w.party_id),0);

create or replace function public.agent_v2_enqueue(p_party_id uuid,p_actor_id uuid,p_idempotency_key text,p_kind text,p_payload jsonb,p_changes_input boolean,p_initial_workspace jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; existing uuid; event_id uuid; job_id uuid; queue_message bigint;
begin
 if not exists(select 1 from public.party_members where party_id=p_party_id and user_id=p_actor_id) then raise exception 'Party membership required'; end if;
 insert into public.party_agent_workspaces(party_id,workspace) values(p_party_id,p_initial_workspace) on conflict do nothing;
 select * into w from public.party_agent_workspaces where party_id=p_party_id for update;
 select q.id into existing from public.party_agent_events e join public.party_agent_queue q on q.event_id=e.id where e.party_id=p_party_id and e.idempotency_key=p_idempotency_key;
 if existing is not null then return existing; end if;
 update public.party_agent_workspaces set source_revision=source_revision+1,updated_at=now() where party_id=p_party_id returning * into w;
 if p_changes_input then
  update public.party_agent_workspaces set input_revision=input_revision+1,workspace=jsonb_set(workspace,'{inputRevision}',to_jsonb(input_revision+1)),updated_at=now() where party_id=p_party_id returning * into w;
 end if;
 insert into public.party_agent_events(party_id,actor_id,idempotency_key,kind,payload,input_revision,source_sequence) values(p_party_id,p_actor_id,p_idempotency_key,p_kind,p_payload,w.input_revision,w.source_revision) returning id into event_id;
 select pgmq.send('party_agent_v2',jsonb_build_object('event_id',event_id,'party_id',p_party_id)) into queue_message;
 insert into public.party_agent_queue(party_id,event_id,message_id) values(p_party_id,event_id,queue_message) returning id into job_id;
 insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(p_party_id,w.input_revision,w.draft_revision,'queued');
 return job_id;
end $$;

drop function public.agent_v2_claim(text,integer);
create function public.agent_v2_claim(p_worker_id text,p_lease_seconds integer default 60)
returns table(job_id uuid,party_id uuid,event_id uuid,fence bigint,input_revision bigint,draft_revision bigint,source_revision bigint,processed_source_revision bigint,step_sequence bigint,workspace jsonb,checkpoint jsonb)
language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue;
begin
 if length(trim(p_worker_id))=0 or p_lease_seconds not between 1 and 60 then raise exception 'Invalid lease'; end if;
 select s.* into w from public.party_agent_workspaces s
 where (s.lease_until is null or s.lease_until<=clock_timestamp()) and exists(select 1 from public.party_agent_queue j where j.party_id=s.party_id and j.status in ('queued','running'))
 order by s.updated_at for update skip locked limit 1;
 if not found then return; end if;
 select j.* into q from public.party_agent_queue j join public.party_agent_events e on e.id=j.event_id
 where j.party_id=w.party_id and j.status in ('queued','running') order by e.source_sequence for update of j skip locked limit 1;
 if not found then return; end if;
 update public.party_agent_workspaces s set fence=s.fence+1,lease_owner=p_worker_id,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where s.party_id=w.party_id returning s.* into w;
 update public.party_agent_queue set status='running',attempts=attempts+1,fence=w.fence,worker_id=p_worker_id,updated_at=now() where id=q.id;
 return query select q.id,w.party_id,q.event_id,w.fence,w.input_revision,w.draft_revision,w.source_revision,w.processed_source_revision,w.step_sequence,w.workspace,w.checkpoint;
end $$;

drop function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text);
create function public.agent_v2_checkpoint(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_expected_source bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null,p_event_processed boolean default false)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue; next_input bigint; next_draft bigint; event_sequence bigint; next_processed bigint;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.status<>'running' or q.fence<>p_fence or w.input_revision<>p_expected_input or w.draft_revision<>p_expected_draft then raise exception 'Stale worker or revision'; end if;
 if p_step<>w.step_sequence+1 then raise exception 'Invalid step sequence'; end if;
 select source_sequence into event_sequence from public.party_agent_events where id=q.event_id;
 if p_expected_source is null or p_expected_source<event_sequence or p_expected_source>w.source_revision then raise exception 'Invalid source boundary'; end if;
 next_processed:=w.processed_source_revision;
 if p_event_processed then
  if event_sequence>w.processed_source_revision+1 then raise exception 'Source events must be processed in order'; end if;
  next_processed:=greatest(w.processed_source_revision,event_sequence);
 end if;
 if p_projection is not null and (w.source_revision<>p_expected_source or next_processed<>w.source_revision) then raise exception 'Pending source events'; end if;
 next_input := (p_workspace->>'inputRevision')::bigint;
 next_draft := (p_workspace->>'draftRevision')::bigint;
 if next_input is null or next_input not between w.input_revision and 9007199254740991 or next_draft is null or next_draft<>w.draft_revision+(case when p_projection is null then 0 else 1 end) or p_workspace->>'partyId' is distinct from w.party_id::text or (p_workspace->>'schemaVersion')::integer is distinct from 2 then raise exception 'Invalid workspace revisions'; end if;
 if p_projection is not null then
  if (p_projection->>'inputRevision')::bigint is distinct from next_input or (p_projection->>'draftRevision')::bigint is distinct from next_draft or p_projection->>'partyId' is distinct from w.party_id::text then raise exception 'Invalid public projection'; end if;
  insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values(w.party_id,next_draft,next_input,(p_projection->>'ready')::boolean,p_projection);
 end if;
 insert into public.party_agent_steps(party_id,step_sequence,job_id,fence,input_revision,messages,checkpoint) values(w.party_id,p_step,q.id,p_fence,next_input,p_messages,p_checkpoint);
 update public.party_agent_workspaces set workspace=p_workspace,checkpoint=p_checkpoint,input_revision=next_input,draft_revision=next_draft,processed_source_revision=next_processed,step_sequence=p_step,updated_at=now() where party_id=w.party_id;
 update public.party_agent_queue set persisted_step=p_step,updated_at=now() where id=q.id;
 if p_activity_code is not null then insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(w.party_id,next_input,next_draft,p_activity_code); end if;
end $$;

create or replace function public.agent_v2_ack(p_job_id uuid,p_worker_id text,p_fence bigint,p_step bigint,p_status text)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.fence<>p_fence or q.status<>'running' then raise exception 'Stale worker or revision'; end if;
 if q.persisted_step is null or q.persisted_step<>p_step or not exists(select 1 from public.party_agent_steps where job_id=q.id and step_sequence=p_step and fence=p_fence) then raise exception 'Persist a step before acknowledging'; end if;
 if p_status not in ('queued','completed','failed','waiting_for_input','blocked','cancelled','superseded') then raise exception 'Invalid acknowledgement status'; end if;
 if p_status<>'queued' and w.processed_source_revision<(select source_sequence from public.party_agent_events where id=q.event_id) then raise exception 'Source event is not processed'; end if;
 update public.party_agent_queue set status=p_status,worker_id=null,updated_at=now() where id=q.id;
 update public.party_agent_workspaces set lease_owner=null,lease_until=null,updated_at=now() where party_id=w.party_id;
 if p_status<>'queued' then perform pgmq.delete('party_agent_v2',q.message_id); end if;
end $$;

create or replace function public.agent_v2_approve(p_party_id uuid,p_actor_id uuid,p_draft_revision bigint,p_idempotency_key text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; d public.party_agent_drafts; result uuid;
begin
 if not exists(select 1 from public.parties where id=p_party_id and host_id=p_actor_id) then raise exception 'Host approval required'; end if;
 select * into w from public.party_agent_workspaces where party_id=p_party_id for update;
 if w.source_revision<>w.processed_source_revision then raise exception 'Pending source events'; end if;
 select * into d from public.party_agent_drafts where party_id=p_party_id and draft_revision=p_draft_revision;
 if d.party_id is null or not d.ready or d.input_revision<>w.input_revision or d.draft_revision<>w.draft_revision then raise exception 'Exact current ready draft required'; end if;
 select id into result from public.party_cart_operations where party_id=p_party_id and idempotency_key=p_idempotency_key and draft_revision=p_draft_revision;
 if result is not null then return result; end if;
 insert into public.party_cart_operations(party_id,draft_revision,approved_by,idempotency_key,approved_snapshot) values(p_party_id,p_draft_revision,p_actor_id,p_idempotency_key,d.projection) returning id into result;
 return result;
end $$;

revoke all on function public.agent_v2_claim(text,integer) from public,anon,authenticated;
revoke all on function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.agent_v2_claim(text,integer) to service_role;
grant execute on function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean) to service_role;
