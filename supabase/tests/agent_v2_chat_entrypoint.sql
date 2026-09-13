begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000011'),
 ('00000000-0000-0000-0000-000000000012'),
 ('00000000-0000-0000-0000-000000000013');
insert into public.parties(id,code,title,host_id) values
 ('10000000-0000-0000-0000-000000000011','V2CHAT01','chat','00000000-0000-0000-0000-000000000011');
insert into public.party_members(party_id,user_id,role,display_name) values
 ('10000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000011','host','Host'),
 ('10000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000012','member','Member');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000012',true);
create temporary table submitted as select * from public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','Add rice',null);
grant select on submitted to service_role;
select extensions.is((select count(*)::int from submitted),1,'member submits one atomic chat event');
select extensions.is((select participant_id from public.party_chat_messages where id=(select message_id from submitted)),'00000000-0000-0000-0000-000000000012'::uuid,'chat actor comes from auth.uid');
reset role;
set local role service_role;
select extensions.is((select actor_id from public.party_agent_events where id=(select event_id from public.party_agent_queue where id=(select job_id from submitted))),'00000000-0000-0000-0000-000000000012'::uuid,'durable event actor matches authenticated member');
select extensions.is((select count(*)::int from public.party_agent_workspaces w cross join lateral jsonb_object_keys(w.workspace->'participants') where w.party_id='10000000-0000-0000-0000-000000000011'),2,'initial private workspace participants are database-derived');
insert into public.party_chat_messages(id,party_id,role,recipient_id,content,status) values
 ('40000000-0000-4000-8000-000000000011','10000000-0000-0000-0000-000000000011','assistant','00000000-0000-0000-0000-000000000012','Any allergy?','waiting_for_input');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000011',true);
select extensions.throws_ok($$select public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','No','40000000-0000-4000-8000-000000000011')$$,'P0001','Recipient-owned open question required','host cannot answer member question');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000012',true);
create temporary table replied as select * from public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','No','40000000-0000-4000-8000-000000000011');
grant select on replied to service_role;
select extensions.is((select recipient_id from public.party_chat_messages where id=(select message_id from replied)),'00000000-0000-0000-0000-000000000012'::uuid,'private reply remains recipient-only');
select extensions.throws_ok($$select public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','Again','40000000-0000-4000-8000-000000000011')$$,'P0001','Recipient-owned open question required','one open question accepts only one durable reply');
reset role;
set local role service_role;
select extensions.is((select kind from public.party_agent_events where id=(select event_id from public.party_agent_queue where id=(select job_id from replied))),'resume','correlated reply enqueues a resume event');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000013',true);
select extensions.throws_ok($$select public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','intrude',null)$$,'P0001','Party membership required','outsider cannot submit agent chat');
reset role;
set local role service_role;
insert into public.party_members(party_id,user_id,role,display_name) values('10000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000013','member','Late member');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000013',true);
select extensions.lives_ok($$select public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','late request',null)$$,'newly joined member can enqueue');
reset role;
set local role service_role;
select extensions.is((select count(*)::int from public.party_agent_workspaces w cross join lateral jsonb_object_keys(w.workspace->'participants') where w.party_id='10000000-0000-0000-0000-000000000011'),3,'enqueue reconciles newly joined participants');
update public.parties set status='finalized' where id='10000000-0000-0000-0000-000000000011';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000012',true);
select extensions.throws_ok($$select public.agent_v2_submit_chat('10000000-0000-0000-0000-000000000011','change finalized',null)$$,'P0001','Party is not open for changes','direct RPC cannot mutate a finalized party');

select * from extensions.finish();
rollback;
