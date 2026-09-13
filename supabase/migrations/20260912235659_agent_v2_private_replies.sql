-- Private questions keep their participant replies private as well.
alter table public.party_chat_messages drop constraint assistant_recipient_only;
alter table public.party_chat_messages add constraint private_reply_owner check (recipient_id is null or role='assistant' or (role='user' and participant_id=recipient_id));
drop policy "Members add their own shared chat" on public.party_chat_messages;
create policy "Members add their own shared or private chat" on public.party_chat_messages for insert to authenticated
 with check (role='user' and participant_id=(select auth.uid()) and (recipient_id is null or recipient_id=(select auth.uid())) and public.is_party_member(party_id));

-- A complete public projection has a closed shape at every level. The repository
-- derives these fields from validated domain state; the database rejects raw extras.
create function public.agent_v2_validate_projection() returns trigger language plpgsql set search_path='' as $$
declare key text; line jsonb; code jsonb;
begin
 if jsonb_typeof(new.projection) is distinct from 'object' or jsonb_typeof(new.projection->'lines') is distinct from 'array' or jsonb_typeof(new.projection->'blockerCodes') is distinct from 'array' then raise exception 'Invalid public projection'; end if;
 for key in select jsonb_object_keys(new.projection) loop
  if key<>all(array['schemaVersion','partyId','inputRevision','draftRevision','ready','lines','totalCents','unresolvedCount','blockerCodes']) then raise exception 'Private field in public projection'; end if;
 end loop;
 if (new.projection->>'schemaVersion')::integer is distinct from 2 or new.projection->>'partyId' is distinct from new.party_id::text or (new.projection->>'inputRevision')::bigint is distinct from new.input_revision or (new.projection->>'draftRevision')::bigint is distinct from new.draft_revision or (new.projection->>'ready')::boolean is distinct from new.ready then raise exception 'Invalid public projection revisions'; end if;
 for line in select value from jsonb_array_elements(new.projection->'lines') loop
  if jsonb_typeof(line) is distinct from 'object' then raise exception 'Invalid public line'; end if;
  for key in select jsonb_object_keys(line) loop
   if key<>all(array['productId','name','companyId','branchId','packageCount','packageQuantity','packageUnit','unitPriceCents','lineTotalCents','eaterIds']) then raise exception 'Private field in public line'; end if;
  end loop;
 end loop;
 for code in select value from jsonb_array_elements(new.projection->'blockerCodes') loop
  if code#>>'{}'<>all(array['empty','missing','unknown','unsafe','units','unavailable','budget']) then raise exception 'Private blocker in public projection'; end if;
 end loop;
 return new;
end $$;
create trigger validate_public_projection before insert on public.party_agent_drafts for each row execute function public.agent_v2_validate_projection();
revoke all on function public.agent_v2_validate_projection() from public,anon,authenticated;
grant execute on function public.agent_v2_validate_projection() to service_role;

-- A single model step may refresh several participant sources. CAS still compares
-- the exact starting revision; the validated reducer may advance it more than once.
create or replace function public.agent_v2_checkpoint(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue; next_input bigint; next_draft bigint;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.status<>'running' or q.fence<>p_fence or w.input_revision<>p_expected_input or w.draft_revision<>p_expected_draft then raise exception 'Stale worker or revision'; end if;
 if p_step<>w.step_sequence+1 then raise exception 'Invalid step sequence'; end if;
 next_input := (p_workspace->>'inputRevision')::bigint;
 next_draft := (p_workspace->>'draftRevision')::bigint;
 if next_input is null or next_input not between w.input_revision and 9007199254740991 or next_draft is null or next_draft<>w.draft_revision+(case when p_projection is null then 0 else 1 end) or p_workspace->>'partyId' is distinct from w.party_id::text or (p_workspace->>'schemaVersion')::integer is distinct from 2 then raise exception 'Invalid workspace revisions'; end if;
 if p_projection is not null then
  if (p_projection->>'inputRevision')::bigint is distinct from next_input or (p_projection->>'draftRevision')::bigint is distinct from next_draft or p_projection->>'partyId' is distinct from w.party_id::text then raise exception 'Invalid public projection'; end if;
  insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values(w.party_id,next_draft,next_input,(p_projection->>'ready')::boolean,p_projection);
 end if;
 insert into public.party_agent_steps(party_id,step_sequence,job_id,fence,input_revision,messages,checkpoint) values(w.party_id,p_step,q.id,p_fence,next_input,p_messages,p_checkpoint);
 update public.party_agent_workspaces set workspace=p_workspace,checkpoint=p_checkpoint,input_revision=next_input,draft_revision=next_draft,step_sequence=p_step,updated_at=now() where party_id=w.party_id;
 update public.party_agent_queue set persisted_step=p_step,updated_at=now() where id=q.id;
 if p_activity_code is not null then insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(w.party_id,next_input,next_draft,p_activity_code); end if;
end $$;
