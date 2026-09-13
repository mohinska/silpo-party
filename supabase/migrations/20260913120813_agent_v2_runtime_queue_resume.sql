-- Durable slices may be retried later without a hot polling loop. The source
-- watermark remains the serialization boundary for every party.
alter table public.party_agent_queue
  add column next_attempt_at timestamptz not null default now();

drop index public.party_agent_queue_claim_idx;
create index party_agent_queue_claim_idx
  on public.party_agent_queue(next_attempt_at, created_at)
  where status in ('queued','running');

-- Private resumes are accepted only from the participant who owns the exact
-- still-open assistant question. Actor authority still comes from the caller.
create or replace function public.agent_v2_enqueue(p_party_id uuid,p_actor_id uuid,p_idempotency_key text,p_kind text,p_payload jsonb,p_changes_input boolean,p_initial_workspace jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; existing uuid; event_id uuid; job_id uuid; queue_message bigint; reply_to uuid; current_participants jsonb;
begin
 if not exists(select 1 from public.party_members where party_id=p_party_id and user_id=p_actor_id) then raise exception 'Party membership required'; end if;
 if p_kind='resume' then
  begin reply_to := (p_payload->>'replyToMessageId')::uuid; exception when invalid_text_representation then raise exception 'Invalid private reply'; end;
  if nullif(trim(p_payload->>'text'),'') is null or reply_to is null or not exists(
   select 1 from public.party_chat_messages m
   where m.id=reply_to and m.party_id=p_party_id and m.role='assistant'
    and m.recipient_id=p_actor_id and m.status in ('waiting_for_input','running')
  ) then raise exception 'Recipient-owned open question required'; end if;
 end if;
 insert into public.party_agent_workspaces(party_id,workspace) values(p_party_id,p_initial_workspace) on conflict do nothing;
 select * into w from public.party_agent_workspaces where party_id=p_party_id for update;
 select coalesce(jsonb_object_agg(m.user_id::text,jsonb_build_object('submission','unsubmitted','contexts',jsonb_build_object())),'{}'::jsonb)
 into current_participants from public.party_members m where m.party_id=p_party_id;
 update public.party_agent_workspaces set workspace=jsonb_set(workspace,'{participants}',current_participants||coalesce(workspace->'participants','{}'::jsonb)),updated_at=now()
 where party_id=p_party_id returning * into w;
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
returns table(job_id uuid,party_id uuid,event_id uuid,attempts integer,fence bigint,input_revision bigint,draft_revision bigint,source_revision bigint,processed_source_revision bigint,step_sequence bigint,workspace jsonb,checkpoint jsonb)
language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue;
begin
 if length(trim(p_worker_id))=0 or p_lease_seconds not between 1 and 60 then raise exception 'Invalid lease'; end if;
 select s.* into w from public.party_agent_workspaces s
 where (s.lease_until is null or s.lease_until<=clock_timestamp()) and exists(
  select 1 from public.party_agent_queue j join public.party_agent_events e on e.id=j.event_id
  where j.party_id=s.party_id
   and ((j.status='queued' and j.next_attempt_at<=clock_timestamp()) or (j.status='running' and s.lease_until<=clock_timestamp()))
   and e.source_sequence between s.processed_source_revision and s.processed_source_revision+1
 ) order by s.updated_at for update skip locked limit 1;
 if not found then return; end if;
 select j.* into q from public.party_agent_queue j join public.party_agent_events e on e.id=j.event_id
 where j.party_id=w.party_id
  and ((j.status='queued' and j.next_attempt_at<=clock_timestamp()) or (j.status='running' and w.lease_until<=clock_timestamp()))
  and e.source_sequence between w.processed_source_revision and w.processed_source_revision+1
 order by e.source_sequence for update of j skip locked limit 1;
 if not found then return; end if;
 update public.party_agent_workspaces s set fence=s.fence+1,lease_owner=p_worker_id,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where s.party_id=w.party_id returning s.* into w;
 update public.party_agent_queue set status='running',attempts=party_agent_queue.attempts+1,fence=w.fence,worker_id=p_worker_id,updated_at=now() where id=q.id returning * into q;
 return query select q.id,w.party_id,q.event_id,q.attempts,w.fence,w.input_revision,w.draft_revision,w.source_revision,w.processed_source_revision,w.step_sequence,w.workspace,w.checkpoint;
end $$;

-- A targeted assistant question and its fenced durable checkpoint are one
-- transaction. A processed resume closes the exact correlated question.
drop function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean);
create function public.agent_v2_checkpoint(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_expected_source bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null,p_event_processed boolean default false,p_question jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue; next_input bigint; next_draft bigint; event_sequence bigint; next_processed bigint; recipient uuid; question_id uuid; question_content text; event_kind text; event_payload jsonb; changed integer;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.status<>'running' or q.fence<>p_fence or w.input_revision<>p_expected_input or w.draft_revision<>p_expected_draft then raise exception 'Stale worker or revision'; end if;
 if p_step<>w.step_sequence+1 then raise exception 'Invalid step sequence'; end if;
 select source_sequence,kind,payload into event_sequence,event_kind,event_payload from public.party_agent_events where id=q.event_id;
 if p_expected_source is null or p_expected_source<event_sequence or p_expected_source>w.source_revision then raise exception 'Invalid source boundary'; end if;
 next_processed:=w.processed_source_revision;
 if p_event_processed then
  if event_sequence>w.processed_source_revision+1 then raise exception 'Source events must be processed in order'; end if;
  next_processed:=greatest(w.processed_source_revision,event_sequence);
  if event_kind='resume' then
   update public.party_chat_messages set status='completed'
   where id=(event_payload->>'replyToMessageId')::uuid and party_id=w.party_id
    and recipient_id=(select actor_id from public.party_agent_events where id=q.event_id)
    and role='assistant' and status in ('waiting_for_input','running');
   get diagnostics changed = row_count;
   if changed<>1 then raise exception 'Private question is no longer open'; end if;
  end if;
 end if;
 -- A newer source can make this projection stale after the worker claim. Keep
 -- the versioned work instead of replaying the model; approval still requires
 -- source_revision=processed_source_revision and no active work.
 next_input := (p_workspace->>'inputRevision')::bigint; next_draft := (p_workspace->>'draftRevision')::bigint;
 if next_input is null or next_input not between w.input_revision and 9007199254740991 or next_draft is null or next_draft<>w.draft_revision+(case when p_projection is null then 0 else 1 end) or p_workspace->>'partyId' is distinct from w.party_id::text or (p_workspace->>'schemaVersion')::integer is distinct from 2 then raise exception 'Invalid workspace revisions'; end if;
 if p_projection is not null then
  if (p_projection->>'inputRevision')::bigint is distinct from next_input or (p_projection->>'draftRevision')::bigint is distinct from next_draft or p_projection->>'partyId' is distinct from w.party_id::text then raise exception 'Invalid public projection'; end if;
  insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values(w.party_id,next_draft,next_input,(p_projection->>'ready')::boolean,p_projection);
 end if;
 if p_question is not null then
  question_id := (p_question->>'id')::uuid; recipient := (p_question->>'recipientId')::uuid; question_content := nullif(trim(p_question->>'content'),'');
  if question_id is null or recipient is null or question_content is null or length(question_content)>1000 or not exists(select 1 from public.party_members where party_id=w.party_id and user_id=recipient) then raise exception 'Invalid targeted question'; end if;
 end if;
 insert into public.party_agent_steps(party_id,step_sequence,job_id,fence,input_revision,messages,checkpoint) values(w.party_id,p_step,q.id,p_fence,next_input,p_messages,p_checkpoint);
 if p_question is not null then insert into public.party_chat_messages(id,party_id,recipient_id,role,content,status) values(question_id,w.party_id,recipient,'assistant',question_content,'waiting_for_input'); end if;
 update public.party_agent_workspaces set workspace=p_workspace,checkpoint=p_checkpoint,input_revision=next_input,draft_revision=next_draft,processed_source_revision=next_processed,step_sequence=p_step,updated_at=now() where party_id=w.party_id;
 update public.party_agent_queue set persisted_step=p_step,updated_at=now() where id=q.id;
 if p_activity_code is not null then insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(w.party_id,next_input,next_draft,p_activity_code); end if;
end $$;

-- Checkpoint and queue transition share one transaction. A lost HTTP response
-- can only cause a harmless stale-fence retry, never a duplicated model step.
create function public.agent_v2_checkpoint_and_ack(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_expected_source bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null,p_event_processed boolean default false,p_question jsonb default null,p_status text default 'queued',p_next_attempt_at timestamptz default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform public.agent_v2_checkpoint(p_job_id,p_worker_id,p_fence,p_expected_input,p_expected_draft,p_expected_source,p_step,p_workspace,p_messages,p_checkpoint,p_projection,p_activity_code,p_event_processed,p_question);
 perform public.agent_v2_ack(p_job_id,p_worker_id,p_fence,p_step,p_status,p_next_attempt_at);
end $$;

drop function public.agent_v2_ack(uuid,text,bigint,bigint,text);
create function public.agent_v2_ack(p_job_id uuid,p_worker_id text,p_fence bigint,p_step bigint,p_status text,p_next_attempt_at timestamptz default null)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue; event_sequence bigint;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.fence<>p_fence or q.status<>'running' then raise exception 'Stale worker or revision'; end if;
 if q.persisted_step is null or q.persisted_step<>p_step or not exists(select 1 from public.party_agent_steps where job_id=q.id and step_sequence=p_step and fence=p_fence) then raise exception 'Persist a step before acknowledging'; end if;
 if p_status not in ('queued','completed','failed','waiting_for_input','blocked','cancelled','superseded') then raise exception 'Invalid acknowledgement status'; end if;
 select source_sequence into event_sequence from public.party_agent_events where id=q.event_id;
 if p_status not in ('queued','blocked') and w.processed_source_revision<event_sequence then raise exception 'Source event is not processed'; end if;
 update public.party_agent_queue set status=p_status,worker_id=null,next_attempt_at=case when p_status='queued' then coalesce(p_next_attempt_at,clock_timestamp()) else clock_timestamp() end,updated_at=now() where id=q.id;
 update public.party_agent_workspaces set lease_owner=null,lease_until=null,updated_at=now() where party_id=w.party_id;
 if p_status<>'queued' then perform pgmq.delete('party_agent_v2',q.message_id); end if;
end $$;

-- Explicit operator recovery preserves history and source ordering while
-- creating a fresh queue signal. It never advances the source watermark.
create function public.agent_v2_retry_blocked(p_job_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare q public.party_agent_queue; w public.party_agent_workspaces; event_sequence bigint; queue_message bigint;
begin
 select * into q from public.party_agent_queue where id=p_job_id for update;
 if q.status<>'blocked' then raise exception 'Blocked job required'; end if;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 select source_sequence into event_sequence from public.party_agent_events where id=q.event_id;
 if event_sequence<>w.processed_source_revision+1 then raise exception 'Blocked job is not the next source event'; end if;
 select pgmq.send('party_agent_v2',jsonb_build_object('event_id',q.event_id,'party_id',q.party_id)) into queue_message;
 update public.party_agent_queue set status='queued',message_id=queue_message,next_attempt_at=clock_timestamp(),worker_id=null,updated_at=now() where id=q.id;
end $$;

-- A source watermark means the model has interpreted the input, not that the
-- multi-step run has finished. Approval additionally requires quiescent work
-- and no unanswered private question.
create or replace function public.agent_v2_approve(p_party_id uuid,p_actor_id uuid,p_draft_revision bigint,p_idempotency_key text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; d public.party_agent_drafts; result uuid;
begin
 if not exists(select 1 from public.parties where id=p_party_id and host_id=p_actor_id) then raise exception 'Host approval required'; end if;
 select * into w from public.party_agent_workspaces where party_id=p_party_id for update;
 if w.source_revision<>w.processed_source_revision then raise exception 'Pending source events'; end if;
 if exists(select 1 from public.party_agent_queue where party_id=p_party_id and status in ('queued','running')) then raise exception 'Pending agent work'; end if;
 if exists(select 1 from public.party_chat_messages where party_id=p_party_id and role='assistant' and status='waiting_for_input') then raise exception 'Pending participant question'; end if;
 select * into d from public.party_agent_drafts where party_id=p_party_id and draft_revision=p_draft_revision;
 if d.party_id is null or not d.ready or d.input_revision<>w.input_revision or d.draft_revision<>w.draft_revision then raise exception 'Exact current ready draft required'; end if;
 select id into result from public.party_cart_operations where party_id=p_party_id and idempotency_key=p_idempotency_key and draft_revision=p_draft_revision;
 if result is not null then return result; end if;
 insert into public.party_cart_operations(party_id,draft_revision,approved_by,idempotency_key,approved_snapshot) values(p_party_id,p_draft_revision,p_actor_id,p_idempotency_key,d.projection) returning id into result;
 return result;
end $$;

revoke all on function public.agent_v2_claim(text,integer) from public,anon,authenticated;
revoke all on function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb) from public,anon,authenticated;
revoke all on function public.agent_v2_ack(uuid,text,bigint,bigint,text,timestamptz) from public,anon,authenticated;
revoke all on function public.agent_v2_checkpoint_and_ack(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,text,timestamptz) from public,anon,authenticated;
revoke all on function public.agent_v2_retry_blocked(uuid) from public,anon,authenticated;
grant execute on function public.agent_v2_claim(text,integer) to service_role;
grant execute on function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb) to service_role;
grant execute on function public.agent_v2_ack(uuid,text,bigint,bigint,text,timestamptz) to service_role;
grant execute on function public.agent_v2_checkpoint_and_ack(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,text,timestamptz) to service_role;
grant execute on function public.agent_v2_retry_blocked(uuid) to service_role;
