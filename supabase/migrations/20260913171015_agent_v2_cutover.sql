-- Agent v2 browser entrypoints. Canonical application mutations and their
-- durable source events commit together; authenticated callers never supply
-- actor authority or a private workspace snapshot.
create function public.agent_v2_initial_workspace(p_party_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'schemaVersion',2,'partyId',p_party_id,'inputRevision',0,'draftRevision',0,
  'participants',coalesce((
    select jsonb_object_agg(m.user_id::text,jsonb_build_object('submission','unsubmitted','contexts',jsonb_build_object()))
    from public.party_members m where m.party_id=p_party_id
  ),'{}'::jsonb),
  'requests','[]'::jsonb,'artifacts','[]'::jsonb,'evidence','[]'::jsonb,
  'outcomes','[]'::jsonb,'draft',null
 )
$$;

create function public.agent_v2_submit_intent(
 p_party_id uuid,p_text text,p_dish_name text,p_description text,
 p_content_url text,p_indifferent boolean
) returns table(message_id uuid,job_id uuid)
language plpgsql security definer set search_path='' as $$
declare actor_id uuid; display_content text; request_kind text; edit jsonb;
begin
 actor_id := (select auth.uid());
 if actor_id is null or not exists(select 1 from public.party_members where party_id=p_party_id and user_id=actor_id) then raise exception 'Party membership required'; end if;
 if not exists(select 1 from public.parties where id=p_party_id and status='collecting') then raise exception 'Party is not open for changes'; end if;
 p_text := trim(coalesce(p_text,'')); p_dish_name := trim(coalesce(p_dish_name,''));
 p_description := trim(coalesce(p_description,'')); p_content_url := trim(coalesce(p_content_url,''));
 if p_indifferent is null or length(p_text)>1200 or length(p_dish_name)>120 or length(p_description)>1200 or length(p_content_url)>2000
   or (not p_indifferent and p_text='') then raise exception 'Invalid food intent'; end if;
 if p_indifferent then p_dish_name := ''; p_description := ''; p_content_url := ''; end if;
 insert into public.food_intents(party_id,user_id,dish_name,description,content_url,indifferent,updated_at)
 values(p_party_id,actor_id,p_dish_name,p_description,p_content_url,p_indifferent,clock_timestamp())
 on conflict(party_id,user_id) do update set dish_name=excluded.dish_name,description=excluded.description,
  content_url=excluded.content_url,indifferent=excluded.indifferent,updated_at=excluded.updated_at;
 display_content := case when p_indifferent then 'Мені байдуже — врахуйте мої обмеження.' else p_text end;
 insert into public.party_chat_messages(party_id,participant_id,role,content,status)
 values(p_party_id,actor_id,'user',display_content,'completed') returning id into message_id;
 request_kind := case when p_content_url<>'' then 'recipe' else 'dish' end;
 edit := case when p_indifferent then jsonb_build_object('kind','indifferent') else jsonb_build_object(
  'kind','upsert','requestId','participant:'||actor_id::text||':primary','text',p_text,
  'requestKind',request_kind,'eaterIds',jsonb_build_array(actor_id),'servings',1
 ) end;
 job_id := public.agent_v2_enqueue(p_party_id,actor_id,'intent:'||message_id::text,'request_edit',jsonb_build_object('edit',edit,'messageId',message_id),false,public.agent_v2_initial_workspace(p_party_id));
 return next;
end $$;

create function public.agent_v2_update_budget(p_party_id uuid,p_budget_cents bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor_id uuid; job_id uuid; event_key text;
begin
 actor_id := (select auth.uid());
 if actor_id is null or not exists(select 1 from public.parties where id=p_party_id and host_id=actor_id) then raise exception 'Host authority required'; end if;
 if not exists(select 1 from public.parties where id=p_party_id and status='collecting') then raise exception 'Party is not open for changes'; end if;
 if p_budget_cents is not null and (p_budget_cents<0 or p_budget_cents>1000000000) then raise exception 'Invalid budget'; end if;
 update public.parties set budget_cents=p_budget_cents,updated_at=clock_timestamp() where id=p_party_id;
 event_key := 'budget:'||pg_catalog.gen_random_uuid()::text;
 job_id := public.agent_v2_enqueue(p_party_id,actor_id,event_key,'manual_edit',jsonb_build_object('type','budget','budgetCents',p_budget_cents),true,public.agent_v2_initial_workspace(p_party_id));
 return job_id;
end $$;

create function public.agent_v2_update_profile(p_allergies text,p_dietary_restrictions text,p_dislikes text,p_preferences text)
returns integer language plpgsql security definer set search_path='' as $$
declare actor_id uuid; target_party uuid; queued integer := 0; event_key text;
begin
 actor_id := (select auth.uid());
 if actor_id is null then raise exception 'Authentication required'; end if;
 p_allergies := trim(coalesce(p_allergies,'')); p_dietary_restrictions := trim(coalesce(p_dietary_restrictions,''));
 p_dislikes := trim(coalesce(p_dislikes,'')); p_preferences := trim(coalesce(p_preferences,''));
 if length(p_allergies)>1000 or length(p_dietary_restrictions)>1000 or length(p_dislikes)>1000 or length(p_preferences)>1000 then raise exception 'Invalid profile'; end if;
 insert into public.profiles(id,allergies,dietary_restrictions,dislikes,preferences,updated_at)
 values(actor_id,p_allergies,p_dietary_restrictions,p_dislikes,p_preferences,clock_timestamp())
 on conflict(id) do update set allergies=excluded.allergies,dietary_restrictions=excluded.dietary_restrictions,
  dislikes=excluded.dislikes,preferences=excluded.preferences,updated_at=excluded.updated_at;
 for target_party in
  select m.party_id from public.party_members m join public.parties p on p.id=m.party_id
  where m.user_id=actor_id and p.status='collecting' order by m.party_id
 loop
  event_key := 'profile:'||pg_catalog.gen_random_uuid()::text;
  perform public.agent_v2_enqueue(target_party,actor_id,event_key,'context_refresh',jsonb_build_object('participantId',actor_id,'source','profile'),false,public.agent_v2_initial_workspace(target_party));
  queued := queued+1;
 end loop;
 return queued;
end $$;

create function public.agent_v2_join_party(party_code text,member_name text,member_email text default null,member_avatar text default null)
returns text language plpgsql security definer set search_path='' as $$
declare actor_id uuid; target_party public.parties%rowtype; member_count integer; event_key text;
begin
 actor_id := (select auth.uid());
 if actor_id is null then raise exception 'Authentication required'; end if;
 select * into target_party from public.parties where code=upper(trim(party_code)) for update;
 if not found then raise exception 'Party not found'; end if;
 if target_party.status<>'collecting' then raise exception 'Party is finalized'; end if;
 if exists(select 1 from public.party_members where party_id=target_party.id and user_id=actor_id) then return target_party.code; end if;
 select count(*) into member_count from public.party_members where party_id=target_party.id;
 if member_count>=10 then raise exception 'Party is full'; end if;
 insert into public.party_members(party_id,user_id,role,display_name,email,avatar_url)
 values(target_party.id,actor_id,'member',left(coalesce(nullif(trim(member_name),''),'Учасник'),100),member_email,member_avatar);
 event_key := 'member-joined:'||pg_catalog.gen_random_uuid()::text;
 perform public.agent_v2_enqueue(target_party.id,actor_id,event_key,'context_refresh',jsonb_build_object('participantId',actor_id,'source','profile'),false,public.agent_v2_initial_workspace(target_party.id));
 return target_party.code;
end $$;

create function public.agent_v2_submit_request_edit(p_party_id uuid,p_edit jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor_id uuid; event_key text;
begin
 actor_id := (select auth.uid());
 if actor_id is null or not exists(select 1 from public.party_members where party_id=p_party_id and user_id=actor_id) then raise exception 'Party membership required'; end if;
 if not exists(select 1 from public.parties where id=p_party_id and status='collecting') then raise exception 'Party is not open for changes'; end if;
 if jsonb_typeof(p_edit)<>'object' or p_edit->>'kind' not in ('add','remove','replace','quantity','servings','eaters','indifferent')
  or p_edit ?| array['actorId','actor_id','participantId','participant_id','hostId','host_id']
  or (p_edit->>'kind'<>'indifferent' and nullif(trim(p_edit->>'requestId'),'') is null)
 then raise exception 'Invalid request edit'; end if;
 event_key := 'request-edit:'||pg_catalog.gen_random_uuid()::text;
 return public.agent_v2_enqueue(p_party_id,actor_id,event_key,'request_edit',jsonb_build_object('edit',p_edit),false,public.agent_v2_initial_workspace(p_party_id));
end $$;

revoke all on function public.agent_v2_initial_workspace(uuid) from public,anon,authenticated;
revoke all on function public.agent_v2_submit_intent(uuid,text,text,text,text,boolean) from public,anon;
revoke all on function public.agent_v2_update_budget(uuid,bigint) from public,anon;
revoke all on function public.agent_v2_update_profile(text,text,text,text) from public,anon;
revoke all on function public.agent_v2_join_party(text,text,text,text) from public,anon;
revoke all on function public.agent_v2_submit_request_edit(uuid,jsonb) from public,anon;
grant execute on function public.agent_v2_initial_workspace(uuid) to service_role;
grant execute on function public.agent_v2_submit_intent(uuid,text,text,text,text,boolean) to authenticated;
grant execute on function public.agent_v2_update_budget(uuid,bigint) to authenticated;
grant execute on function public.agent_v2_update_profile(text,text,text,text) to authenticated;
grant execute on function public.agent_v2_join_party(text,text,text,text) to authenticated;
grant execute on function public.agent_v2_submit_request_edit(uuid,jsonb) to authenticated;

alter table public.party_agent_activity drop constraint party_agent_activity_code_check;
alter table public.party_agent_activity add constraint party_agent_activity_code_check check (code in (
 'queued','working','draft_updated','waiting_for_input','blocked','completed','failed','cancelled','superseded',
 'cart_approved','cart_applying','cart_applied','cart_failed','cart_unknown'
));

create function public.agent_v2_publish_cart_activity()
returns trigger language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; public_code text;
begin
 if tg_op='UPDATE' and new.status=old.status then return new; end if;
 public_code := case new.status
  when 'approved' then 'cart_approved' when 'applying' then 'cart_applying'
  when 'verified' then 'cart_applied' when 'failed' then 'cart_failed'
  when 'unknown' then 'cart_unknown' when 'cancelled' then 'cancelled'
 end;
 if public_code is null then return new; end if;
 select * into w from public.party_agent_workspaces where party_id=new.party_id;
 insert into public.party_agent_activity(party_id,input_revision,draft_revision,code)
 values(new.party_id,coalesce(w.input_revision,0),new.draft_revision,public_code);
 return new;
end $$;

create trigger publish_agent_v2_cart_activity
after insert or update of status on public.party_cart_operations
for each row execute function public.agent_v2_publish_cart_activity();
revoke all on function public.agent_v2_publish_cart_activity() from public,anon,authenticated;
grant execute on function public.agent_v2_publish_cart_activity() to service_role;
