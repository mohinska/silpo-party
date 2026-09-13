-- Run against a disposable local database with ON_ERROR_STOP. All fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();
select extensions.has_table('public', 'party_agent_workspaces', 'private workspace exists');
select extensions.ok(not has_table_privilege('authenticated', 'public.party_agent_workspaces', 'select'), 'workspace is service-only');
select extensions.ok(not has_table_privilege('anon', 'public.party_agent_steps', 'select'), 'steps are private');
select extensions.ok(not has_function_privilege('authenticated', 'public.agent_v2_claim(text,integer)', 'execute'), 'claim is service-only');
select extensions.ok(not exists(select 1 from pg_policies where tablename='profiles' and policyname='Party members read shared food profiles'), 'shared profile policy removed');
select extensions.ok(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename in ('party_agent_workspaces','party_agent_steps','party_agent_events','party_agent_queue','party_cart_operations')), 'raw state is not published');
select extensions.ok(not has_table_privilege('authenticated','public.party_agent_drafts','insert'), 'members cannot publish drafts');
select extensions.ok(not has_table_privilege('anon','public.party_cart_operations','insert'), 'anon cannot approve carts');
select extensions.ok(not has_function_privilege('authenticated','public.agent_v2_enqueue(uuid,uuid,text,text,jsonb,boolean,jsonb)','execute'), 'authenticated cannot impersonate event actors');

insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'), ('00000000-0000-0000-0000-000000000003');
insert into public.parties(id, code, title, host_id) values ('10000000-0000-0000-0000-000000000001','V2TEST01','test','00000000-0000-0000-0000-000000000001');
insert into public.party_members(party_id,user_id,role,display_name) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','host','Host'),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member','Member');
insert into public.profiles(id) values('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002') on conflict do nothing;
set local role service_role;
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-1','chat','{"text":"Rice"}',false,'{"schemaVersion":2,"partyId":"10000000-0000-0000-0000-000000000001","inputRevision":0,"draftRevision":0,"participants":{},"requests":[],"artifacts":[],"evidence":[],"outcomes":[],"draft":null}');
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-1','chat','{"text":"Rice"}',false,'{}');
select extensions.is((select count(*)::int from public.party_agent_events),1,'enqueue is idempotent');
select extensions.is((select count(*)::int from public.party_agent_queue),1,'one queued job per event');
create temporary table claim_one as select * from public.agent_v2_claim('worker-one',60);
select extensions.is((select count(*)::int from claim_one),1,'first worker claims');
select extensions.is((select count(*)::int from public.agent_v2_claim('worker-two',60)),0,'second worker cannot claim held party lease');
select extensions.throws_ok($$select public.agent_v2_ack((select job_id from claim_one),'worker-one',(select fence from claim_one),0,'completed')$$,'P0001','Persist a step before acknowledging','cannot ack unpersisted work');
update public.party_agent_workspaces set lease_until=now()-interval '1 second';
create temporary table claim_two as select * from public.agent_v2_claim('worker-two',60);
select extensions.ok((select c2.fence > c1.fence from claim_one c1, claim_two c2),'expired lease recovery increases fence');
select extensions.throws_ok($$select public.agent_v2_checkpoint((select job_id from claim_one),'worker-one',(select fence from claim_one),0,0,1,(select workspace from public.party_agent_workspaces),'[]','{}',null,null)$$,'P0001','Stale worker or revision','stale worker cannot publish');
select public.agent_v2_checkpoint((select job_id from claim_two),'worker-two',(select fence from claim_two),0,0,1,(select workspace from public.party_agent_workspaces),'[]','{}',null,null);
select public.agent_v2_ack((select job_id from claim_two),'worker-two',(select fence from claim_two),1,'completed');
select extensions.is((select status from public.party_agent_queue),'completed','ack follows durable step');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'a')$$,'P0001','Host approval required','member cannot approve');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'a')$$,'P0001','Exact current ready draft required','missing draft cannot be approved');
insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values('10000000-0000-0000-0000-000000000001',1,0,true,'{"schemaVersion":2,"partyId":"10000000-0000-0000-0000-000000000001","inputRevision":0,"draftRevision":1,"ready":true,"lines":[],"totalCents":0,"unresolvedCount":0,"blockerCodes":[]}');
update public.party_agent_workspaces set draft_revision=1;
select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'approved-1');
select extensions.throws_ok($$update public.party_cart_operations set approved_snapshot='{}'$$,'P0001','Approved snapshot is immutable','approved snapshot cannot change');
update public.party_agent_workspaces set input_revision=1;
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'approved-2')$$,'P0001','Exact current ready draft required','stale ready draft cannot be approved');

insert into public.party_chat_messages(party_id,role,content,recipient_id) values
 ('10000000-0000-0000-0000-000000000001','assistant','Private question','00000000-0000-0000-0000-000000000002'),
 ('10000000-0000-0000-0000-000000000001','assistant','Shared answer',null);
insert into public.party_chat_messages(party_id,participant_id,role,content,recipient_id) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','user','Private answer','00000000-0000-0000-0000-000000000002');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select extensions.is((select count(*)::int from public.party_chat_messages),1,'host cannot read recipient question');
select extensions.is((select count(*)::int from public.profiles),1,'host sees only own profile');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
select extensions.is((select count(*)::int from public.party_chat_messages),3,'recipient can read own question and private answer');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
select extensions.is((select count(*)::int from public.party_chat_messages),0,'outsider cannot read chat');
reset role;
select * from extensions.finish();
rollback;
