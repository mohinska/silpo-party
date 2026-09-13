-- Browser chat submission and durable source enqueue are one transaction.
-- Identity and the initial participant set are database-owned, never supplied
-- by form JSON or inferred by the model.
create function public.agent_v2_submit_chat(p_party_id uuid,p_content text,p_reply_to_message_id uuid default null)
returns table(message_id uuid,job_id uuid)
language plpgsql security definer set search_path='' as $$
declare actor_id uuid; initial_participants jsonb; initial_workspace jsonb; event_kind text; event_payload jsonb; question public.party_chat_messages;
begin
 actor_id := (select auth.uid());
 if actor_id is null or not exists(select 1 from public.party_members where party_id=p_party_id and user_id=actor_id) then raise exception 'Party membership required'; end if;
 if not exists(select 1 from public.parties where id=p_party_id and status='collecting') then raise exception 'Party is not open for changes'; end if;
 p_content := nullif(trim(p_content),'');
 if p_content is null or length(p_content)>2000 then raise exception 'Invalid chat content'; end if;
 if p_reply_to_message_id is not null then
  select * into question from public.party_chat_messages m where m.id=p_reply_to_message_id for update;
  if question.id is null or question.party_id<>p_party_id or question.role<>'assistant' or question.recipient_id<>actor_id or question.status<>'waiting_for_input' then raise exception 'Recipient-owned open question required'; end if;
  update public.party_chat_messages set status='running' where id=question.id;
 end if;
 select jsonb_object_agg(m.user_id::text,jsonb_build_object('submission','unsubmitted','contexts',jsonb_build_object()))
 into initial_participants from public.party_members m where m.party_id=p_party_id;
 initial_workspace := jsonb_build_object(
  'schemaVersion',2,'partyId',p_party_id,'inputRevision',0,'draftRevision',0,
  'participants',coalesce(initial_participants,'{}'::jsonb),'requests','[]'::jsonb,
  'artifacts','[]'::jsonb,'evidence','[]'::jsonb,'outcomes','[]'::jsonb,'draft',null
 );
 insert into public.party_chat_messages(party_id,participant_id,recipient_id,role,content,status)
 values(p_party_id,actor_id,case when p_reply_to_message_id is null then null else actor_id end,'user',p_content,'completed')
 returning id into message_id;
 event_kind := case when p_reply_to_message_id is null then 'chat' else 'resume' end;
 event_payload := jsonb_build_object('text',p_content,'messageId',message_id);
 if p_reply_to_message_id is not null then event_payload := event_payload||jsonb_build_object('replyToMessageId',p_reply_to_message_id); end if;
 job_id := public.agent_v2_enqueue(p_party_id,actor_id,'chat:'||message_id::text,event_kind,event_payload,false,initial_workspace);
 return next;
end $$;

revoke all on function public.agent_v2_submit_chat(uuid,text,uuid) from public,anon;
grant execute on function public.agent_v2_submit_chat(uuid,text,uuid) to authenticated;
