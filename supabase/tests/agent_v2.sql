-- Run against a disposable local database with ON_ERROR_STOP. All fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();
select extensions.has_table('public', 'party_agent_workspaces', 'private workspace exists');
select extensions.has_column('public', 'party_agent_queue', 'next_attempt_at', 'retry eligibility is durable');
select extensions.ok(not has_table_privilege('authenticated', 'public.party_agent_workspaces', 'select'), 'workspace is service-only');
select extensions.ok(not has_table_privilege('anon', 'public.party_agent_steps', 'select'), 'steps are private');
select extensions.ok(not has_function_privilege('authenticated', 'public.agent_v2_claim(text,integer)', 'execute'), 'claim is service-only');
select extensions.ok(not has_function_privilege('authenticated', 'public.agent_v2_checkpoint_and_ack(uuid,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb,jsonb,jsonb,text,boolean,jsonb,text,timestamptz,jsonb)', 'execute'), 'atomic checkpoint transition is service-only');
select extensions.ok(not exists(select 1 from pg_policies where tablename='profiles' and policyname='Party members read shared food profiles'), 'shared profile policy removed');
select extensions.ok(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename in ('party_agent_workspaces','party_agent_steps','party_agent_events','party_agent_queue','party_cart_operations')), 'raw state is not published');
select extensions.ok(not has_table_privilege('authenticated','public.party_agent_drafts','insert'), 'members cannot publish drafts');
select extensions.ok(not has_table_privilege('anon','public.party_cart_operations','insert'), 'anon cannot approve carts');
select extensions.ok(not has_function_privilege('authenticated','public.agent_v2_enqueue(uuid,uuid,text,text,jsonb,boolean,jsonb)','execute'), 'authenticated cannot impersonate event actors');

insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'), ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000004');
insert into public.parties(id, code, title, host_id) values ('10000000-0000-0000-0000-000000000001','V2TEST01','test','00000000-0000-0000-0000-000000000001');
insert into public.party_members(party_id,user_id,role,display_name) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','host','Host'),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member','Member');
insert into public.profiles(id) values('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),('00000000-0000-0000-0000-000000000004') on conflict do nothing;
set local role service_role;
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-1','chat','{"text":"Rice"}',false,'{"schemaVersion":2,"partyId":"10000000-0000-0000-0000-000000000001","inputRevision":0,"draftRevision":0,"participants":{},"requests":[],"artifacts":[],"evidence":[],"outcomes":[],"draft":null}');
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-1','chat','{"text":"Rice"}',false,'{}');
select extensions.is((select count(*)::int from public.party_agent_events),1,'enqueue is idempotent');
select extensions.is((select count(*)::int from public.party_agent_queue),1,'one queued job per event');
create temporary table claim_one as select * from public.agent_v2_claim('worker-one',60);
select extensions.is((select count(*)::int from claim_one),1,'first worker claims');
select extensions.is((select attempts from claim_one),1,'claim returns the incremented attempt count');
select extensions.is((select count(*)::int from public.agent_v2_claim('worker-two',60)),0,'second worker cannot claim held party lease');
select extensions.throws_ok($$select public.agent_v2_ack((select job_id from claim_one),'worker-one',(select fence from claim_one),0,'completed')$$,'P0001','Persist a step before acknowledging','cannot ack unpersisted work');
update public.party_agent_workspaces set lease_until=now()-interval '1 second';
create temporary table claim_two as select * from public.agent_v2_claim('worker-two',60);
select extensions.ok((select c2.fence > c1.fence from claim_one c1, claim_two c2),'expired lease recovery increases fence');
select extensions.throws_ok($$select public.agent_v2_checkpoint((select job_id from claim_one),'worker-one',(select fence from claim_one),0,0,1,1,(select workspace from public.party_agent_workspaces),'[]','{}',null,null,true)$$,'P0001','Stale worker or revision','stale worker cannot publish');
select public.agent_v2_checkpoint((select job_id from claim_two),'worker-two',(select fence from claim_two),0,0,1,1,(select workspace from public.party_agent_workspaces),'[]','{}',null,null,true);
select public.agent_v2_ack((select job_id from claim_two),'worker-two',(select fence from claim_two),1,'completed');
select extensions.is((select status from public.party_agent_queue),'completed','ack follows durable step');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'a')$$,'P0001','Host approval required','member cannot approve');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'a')$$,'P0001','Exact current ready draft required','missing draft cannot be approved');
insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values('10000000-0000-0000-0000-000000000001',1,0,true,'{"schemaVersion":2,"partyId":"10000000-0000-0000-0000-000000000001","inputRevision":0,"draftRevision":1,"ready":true,"lines":[],"totalCents":0,"unresolvedCount":0,"blockerCodes":[]}');
update public.party_agent_workspaces set draft_revision=1;
select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'approved-1');
select extensions.throws_ok($$update public.party_cart_operations set approved_snapshot='{}'$$,'P0001','Approved snapshot is immutable','approved snapshot cannot change');
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-pending','chat','{"text":"Remove rice"}',false,'{}');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'pending-approval')$$,'P0001','Pending source events','pending raw chat fences previous ready approval');
create temporary table pending_claim as select * from public.agent_v2_claim('worker-pending',60);
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-question','chat','{"text":"How much?"}',false,'{}');
select extensions.is((select input_revision from public.party_agent_workspaces),0::bigint,'raw source events do not manufacture meaningful input revisions');
select extensions.lives_ok($$select public.agent_v2_checkpoint((select job_id from pending_claim),'worker-pending',(select fence from pending_claim),0,1,2,2,jsonb_set((select workspace from public.party_agent_workspaces),'{draftRevision}','2'),'[]','{}',jsonb_set((select projection from public.party_agent_drafts),'{draftRevision}','2'),null,true)$$,'newer source keeps the completed versioned projection without model replay');
select public.agent_v2_ack((select job_id from pending_claim),'worker-pending',(select fence from pending_claim),2,'completed');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1,'still-pending')$$,'P0001','Pending source events','processing one event cannot clear newer pending event');
create temporary table question_claim as select * from public.agent_v2_claim('worker-question',60);
select public.agent_v2_checkpoint((select job_id from question_claim),'worker-question',(select fence from question_claim),0,2,3,3,(select workspace from public.party_agent_workspaces),'[]','{}',null,null,true);
select public.agent_v2_ack((select job_id from question_claim),'worker-question',(select fence from question_claim),3,'completed');
select extensions.is((select processed_source_revision from public.party_agent_workspaces),3::bigint,'processed watermark catches up in source order');
select extensions.is((select input_revision from public.party_agent_workspaces),0::bigint,'processing pure question preserves meaningful input revision');
select extensions.lives_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',2,'after-question')$$,'processed pure questions restore approval of latest ready draft');

select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-retry','chat','{"text":"retry me"}',false,'{}');
create temporary table retry_claim as select * from public.agent_v2_claim('worker-retry',60);
select public.agent_v2_checkpoint((select job_id from retry_claim),'worker-retry',(select fence from retry_claim),0,2,4,4,(select workspace from public.party_agent_workspaces),'[]','{}',null,'working',false);
select public.agent_v2_ack((select job_id from retry_claim),'worker-retry',(select fence from retry_claim),4,'queued',now()+interval '1 hour');
select extensions.is((select count(*)::int from public.agent_v2_claim('worker-too-early',60)),0,'future retry is not claimable');
update public.party_agent_queue set next_attempt_at=now()-interval '1 second' where id=(select job_id from retry_claim);
create temporary table retry_due_claim as select * from public.agent_v2_claim('worker-retry-due',60);
select extensions.is((select attempts from retry_due_claim),2,'due retry preserves and increments attempt history');
select public.agent_v2_checkpoint((select job_id from retry_due_claim),'worker-retry-due',(select fence from retry_due_claim),0,2,4,5,(select workspace from public.party_agent_workspaces),'[]','{}',null,'working',true);
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',2,'during-active-job')$$,'P0001','Pending agent work','processed watermark alone cannot approve during an active job');
select public.agent_v2_ack((select job_id from retry_due_claim),'worker-retry-due',(select fence from retry_due_claim),5,'completed');

select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-targeted-question','chat','{"text":"ask privately"}',false,'{}');
create temporary table targeted_claim as select * from public.agent_v2_claim('worker-targeted',60);
select public.agent_v2_checkpoint((select job_id from targeted_claim),'worker-targeted',(select fence from targeted_claim),0,2,5,6,(select workspace from public.party_agent_workspaces),'[]','{}',null,'waiting_for_input',true,'{"id":"40000000-0000-4000-8000-000000000001","recipientId":"00000000-0000-0000-0000-000000000002","content":"Any dairy allergy?"}');
select public.agent_v2_ack((select job_id from targeted_claim),'worker-targeted',(select fence from targeted_claim),6,'waiting_for_input');
select extensions.is((select status from public.party_chat_messages where id='40000000-0000-4000-8000-000000000001'),'waiting_for_input','question is atomically visible as waiting');
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',2,'during-question')$$,'P0001','Pending participant question','open targeted question blocks approval');
select extensions.throws_ok($$select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','invalid-private-resume','resume','{"text":"No","replyToMessageId":"40000000-0000-4000-8000-000000000001"}',false,'{}')$$,'P0001','Recipient-owned open question required','another member cannot answer a private question');
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','valid-private-resume','resume','{"text":"No","replyToMessageId":"40000000-0000-4000-8000-000000000001"}',false,'{}');
create temporary table resume_claim as select * from public.agent_v2_claim('worker-resume',60);
select public.agent_v2_checkpoint((select job_id from resume_claim),'worker-resume',(select fence from resume_claim),0,2,6,7,(select workspace from public.party_agent_workspaces),'[]','{}',null,'working',true);
select public.agent_v2_ack((select job_id from resume_claim),'worker-resume',(select fence from resume_claim),7,'completed');
select extensions.is((select status from public.party_chat_messages where id='40000000-0000-4000-8000-000000000001'),'completed','processed correlated reply closes its question');
select extensions.lives_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',2,'after-private-resume')$$,'completed reply restores approval when no work is active');

select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-blocked','chat','{"text":"blocked"}',false,'{}');
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','event-after-blocked','chat','{"text":"later"}',false,'{}');
create temporary table blocked_claim as select * from public.agent_v2_claim('worker-blocked',60);
select public.agent_v2_checkpoint((select job_id from blocked_claim),'worker-blocked',(select fence from blocked_claim),0,2,8,8,(select workspace from public.party_agent_workspaces),'[]','{}',null,'blocked',false);
select public.agent_v2_ack((select job_id from blocked_claim),'worker-blocked',(select fence from blocked_claim),8,'blocked');
select extensions.is((select count(*)::int from public.agent_v2_claim('worker-gap',60)),0,'later source cannot cross a terminal unprocessed block');
select public.agent_v2_retry_blocked((select job_id from blocked_claim));
create temporary table recovered_claim as select * from public.agent_v2_claim('worker-recovered',60);
select extensions.is((select event_id from recovered_claim),(select event_id from blocked_claim),'operator recovery retries the same source event');
select public.agent_v2_checkpoint((select job_id from recovered_claim),'worker-recovered',(select fence from recovered_claim),0,2,8,9,(select workspace from public.party_agent_workspaces),'[]','{}',null,'working',true);
select public.agent_v2_ack((select job_id from recovered_claim),'worker-recovered',(select fence from recovered_claim),9,'completed');
create temporary table after_block_claim as select * from public.agent_v2_claim('worker-after-block',60);
select extensions.is((select source_sequence from public.party_agent_events where id=(select event_id from after_block_claim)),8::bigint,'next source becomes claimable only after recovery');
select public.agent_v2_checkpoint_and_ack((select job_id from after_block_claim),'worker-after-block',(select fence from after_block_claim),0,2,8,10,(select workspace from public.party_agent_workspaces),'[]','{}',null,'working',true,null,'completed',null);

update public.party_agent_workspaces set input_revision=1;
select extensions.throws_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',2,'approved-2')$$,'P0001','Exact current ready draft required','stale ready draft cannot be approved');

insert into public.party_chat_messages(party_id,role,content,recipient_id) values
 ('10000000-0000-0000-0000-000000000001','assistant','Private question','00000000-0000-0000-0000-000000000002'),
 ('10000000-0000-0000-0000-000000000001','assistant','Shared answer',null);
insert into public.party_chat_messages(party_id,participant_id,role,content,recipient_id) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','user','Private answer','00000000-0000-0000-0000-000000000002');

-- Private notices (p_notices): isolated party and a user not referenced by
-- the RLS section below, so this block cannot shift those message counts.
-- Proves a notice never sets waiting_for_input and never blocks approval.
insert into public.parties(id, code, title, host_id) values ('10000000-0000-0000-0000-000000000003','V2TEST03','notices-test','00000000-0000-0000-0000-000000000004');
insert into public.party_members(party_id,user_id,role,display_name) values ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','host','Host');
select public.agent_v2_enqueue('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','notice-event','chat','{"text":"Rice"}',false,'{"schemaVersion":2,"partyId":"10000000-0000-0000-0000-000000000003","inputRevision":0,"draftRevision":0,"participants":{},"requests":[],"artifacts":[],"evidence":[],"outcomes":[],"draft":null}');
create temporary table notice_claim as select * from public.agent_v2_claim('worker-notice',60);
select public.agent_v2_checkpoint((select job_id from notice_claim),'worker-notice',(select fence from notice_claim),0,0,1,1,(select workspace from public.party_agent_workspaces where party_id='10000000-0000-0000-0000-000000000003'),'[]','{}',null,null,true,null,'[{"id":"50000000-0000-4000-8000-000000000001","recipientId":"00000000-0000-0000-0000-000000000004","content":"Check this item against your restriction."}]'::jsonb);
select public.agent_v2_ack((select job_id from notice_claim),'worker-notice',(select fence from notice_claim),1,'completed');
select extensions.is((select status from public.party_chat_messages where id='50000000-0000-4000-8000-000000000001'),'completed','private notice never sets waiting_for_input');
select extensions.is((select recipient_id from public.party_chat_messages where id='50000000-0000-4000-8000-000000000001'),'00000000-0000-0000-0000-000000000004'::uuid,'notice reaches only its named recipient');
insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values('10000000-0000-0000-0000-000000000003',1,0,true,'{"schemaVersion":2,"partyId":"10000000-0000-0000-0000-000000000003","inputRevision":0,"draftRevision":1,"ready":true,"lines":[],"totalCents":0,"unresolvedCount":0,"blockerCodes":[]}');
update public.party_agent_workspaces set draft_revision=1 where party_id='10000000-0000-0000-0000-000000000003';
select extensions.lives_ok($$select public.agent_v2_approve('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',1,'notice-approve')$$,'a private notice does not block Host approval');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select extensions.is((select count(*)::int from public.party_chat_messages),1,'host cannot read recipient question');
select extensions.is((select count(*)::int from public.profiles),1,'host sees only own profile');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
select extensions.is((select count(*)::int from public.party_chat_messages),4,'recipient can read own questions and private answer');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
select extensions.is((select count(*)::int from public.party_chat_messages),0,'outsider cannot read chat');
reset role;
select * from extensions.finish();
rollback;
