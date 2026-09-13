begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000021'),
 ('00000000-0000-0000-0000-000000000022'),
 ('00000000-0000-0000-0000-000000000023');
insert into public.profiles(id) values
 ('00000000-0000-0000-0000-000000000021'),
 ('00000000-0000-0000-0000-000000000022'),
 ('00000000-0000-0000-0000-000000000023');
insert into public.parties(id,code,title,host_id) values
 ('10000000-0000-0000-0000-000000000021','V2CUT021','cutover','00000000-0000-0000-0000-000000000021');
insert into public.party_members(party_id,user_id,role,display_name) values
 ('10000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000021','host','Host'),
 ('10000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000022','member','Member');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000022',true);
create temporary table intent_result as select * from public.agent_v2_submit_intent(
 '10000000-0000-0000-0000-000000000021','Rice for one','Rice','','',false
);
grant select on intent_result to service_role;
select extensions.is((select dish_name from public.food_intents where party_id='10000000-0000-0000-0000-000000000021' and user_id='00000000-0000-0000-0000-000000000022'),'Rice','intent canonical state changes atomically');
reset role;
set local role service_role;
select extensions.is((select kind from public.party_agent_events e join public.party_agent_queue q on q.event_id=e.id where q.id=(select job_id from intent_result)),'request_edit','intent queues a typed request edit');
select extensions.is((select payload->'edit'->>'requestId' from public.party_agent_events e join public.party_agent_queue q on q.event_id=e.id where q.id=(select job_id from intent_result)),'participant:00000000-0000-0000-0000-000000000022:primary','intent owns a stable participant request');
select extensions.is((select payload->'edit'->>'kind' from public.party_agent_events e join public.party_agent_queue q on q.event_id=e.id where q.id=(select job_id from intent_result)),'upsert','normal intent uses deterministic upsert');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000021',true);
select public.agent_v2_update_budget('10000000-0000-0000-0000-000000000021',25000);
select extensions.is((select budget_cents from public.parties where id='10000000-0000-0000-0000-000000000021'),25000::bigint,'host budget update is canonical');
reset role;
set local role service_role;
select extensions.is((select input_revision from public.party_agent_workspaces where party_id='10000000-0000-0000-0000-000000000021'),1::bigint,'budget change immediately invalidates prior input revision');
select extensions.is((select count(*)::int from public.party_agent_events where party_id='10000000-0000-0000-0000-000000000021' and kind='manual_edit' and payload->>'type'='budget'),1,'budget change queues one source event');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000022',true);
select extensions.throws_ok($$select public.agent_v2_update_budget('10000000-0000-0000-0000-000000000021',1)$$,'P0001','Host authority required','member cannot change budget');

select public.agent_v2_update_profile('nuts','vegan','cilantro','spicy');
select extensions.is((select allergies from public.profiles where id='00000000-0000-0000-0000-000000000022'),'nuts','profile canonical state changes atomically');
reset role;
set local role service_role;
select extensions.is((select count(*)::int from public.party_agent_events where party_id='10000000-0000-0000-0000-000000000021' and actor_id='00000000-0000-0000-0000-000000000022' and kind='context_refresh'),1,'profile update queues context refresh for the open party');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000023',true);
select extensions.is(public.agent_v2_join_party('V2CUT021','Late member',null,null),'V2CUT021','v2 join returns normalized party code');
reset role;
set local role service_role;
select extensions.ok(exists(select 1 from public.party_members where party_id='10000000-0000-0000-0000-000000000021' and user_id='00000000-0000-0000-0000-000000000023'),'v2 join creates membership');
select extensions.is((select count(*)::int from public.party_agent_events where party_id='10000000-0000-0000-0000-000000000021' and actor_id='00000000-0000-0000-0000-000000000023' and kind='context_refresh'),1,'v2 join queues participant context refresh');
select extensions.ok((select (workspace->'participants') ? '00000000-0000-0000-0000-000000000023' from public.party_agent_workspaces where party_id='10000000-0000-0000-0000-000000000021'),'v2 join reconciles participant into private workspace');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000022',true);
select public.agent_v2_submit_request_edit('10000000-0000-0000-0000-000000000021','{"kind":"remove","requestId":"participant:00000000-0000-0000-0000-000000000022:primary"}');
select extensions.throws_ok($$select public.agent_v2_submit_request_edit('10000000-0000-0000-0000-000000000021','{"kind":"remove","requestId":"x","actorId":"00000000-0000-0000-0000-000000000021"}')$$,'P0001','Invalid request edit','request edits cannot supply actor authority');

select * from extensions.finish();
rollback;
