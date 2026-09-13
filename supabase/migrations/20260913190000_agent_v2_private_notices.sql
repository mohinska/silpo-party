-- Private, non-blocking notices (e.g. an unresolved dietary/allergy warning
-- on an otherwise-ready draft). Unlike p_question, a notice is inserted with
-- status='completed': it never registers as an open question, never blocks
-- agent_v2_approve, and never participates in resume matching.
drop function public.agent_v2_checkpoint_and_ack(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,text,timestamptz);
drop function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb);

create function public.agent_v2_checkpoint(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_expected_source bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null,p_event_processed boolean default false,p_question jsonb default null,p_notices jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue; next_input bigint; next_draft bigint; event_sequence bigint; next_processed bigint; recipient uuid; question_id uuid; question_content text; event_kind text; event_payload jsonb; changed integer; notice jsonb;
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
 if p_notices is not null then
  if jsonb_typeof(p_notices) is distinct from 'array' then raise exception 'Invalid private notices'; end if;
  for notice in select value from jsonb_array_elements(p_notices) loop
   if (notice->>'id')::uuid is null or (notice->>'recipientId')::uuid is null or nullif(trim(notice->>'content'),'') is null or length(trim(notice->>'content'))>1000
    or not exists(select 1 from public.party_members where party_id=w.party_id and user_id=(notice->>'recipientId')::uuid) then raise exception 'Invalid private notice'; end if;
  end loop;
 end if;
 insert into public.party_agent_steps(party_id,step_sequence,job_id,fence,input_revision,messages,checkpoint) values(w.party_id,p_step,q.id,p_fence,next_input,p_messages,p_checkpoint);
 if p_question is not null then insert into public.party_chat_messages(id,party_id,recipient_id,role,content,status) values(question_id,w.party_id,recipient,'assistant',question_content,'waiting_for_input'); end if;
 if p_notices is not null then
  insert into public.party_chat_messages(id,party_id,recipient_id,role,content,status)
  select (value->>'id')::uuid, w.party_id, (value->>'recipientId')::uuid, 'assistant', trim(value->>'content'), 'completed'
  from jsonb_array_elements(p_notices);
 end if;
 update public.party_agent_workspaces set workspace=p_workspace,checkpoint=p_checkpoint,input_revision=next_input,draft_revision=next_draft,processed_source_revision=next_processed,step_sequence=p_step,updated_at=now() where party_id=w.party_id;
 update public.party_agent_queue set persisted_step=p_step,updated_at=now() where id=q.id;
 if p_activity_code is not null then insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(w.party_id,next_input,next_draft,p_activity_code); end if;
end $$;

-- p_notices is appended after p_next_attempt_at (not next to p_question) so
-- every existing positional call in supabase/tests/agent_v2.sql -- which
-- calls this by position, unlike the app's named-argument RPC calls --
-- keeps working unchanged; it just defaults to null.
create function public.agent_v2_checkpoint_and_ack(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_expected_source bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null,p_event_processed boolean default false,p_question jsonb default null,p_status text default 'queued',p_next_attempt_at timestamptz default null,p_notices jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform public.agent_v2_checkpoint(p_job_id,p_worker_id,p_fence,p_expected_input,p_expected_draft,p_expected_source,p_step,p_workspace,p_messages,p_checkpoint,p_projection,p_activity_code,p_event_processed,p_question,p_notices);
 perform public.agent_v2_ack(p_job_id,p_worker_id,p_fence,p_step,p_status,p_next_attempt_at);
end $$;

revoke all on function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.agent_v2_checkpoint_and_ack(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.agent_v2_checkpoint(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,jsonb) to service_role;
grant execute on function public.agent_v2_checkpoint_and_ack(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,text,timestamptz,jsonb) to service_role;
