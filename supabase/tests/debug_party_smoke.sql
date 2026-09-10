-- Run after the debug-party migration IN THE SAME ROLLBACK-ONLY TRANSACTION.
-- scripts/check-debug-party-db.mjs assembles and executes that transaction.
create function pg_temp.assert_true(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Assertion failed: %', label; end if;
end $$;
create function pg_temp.expect_error(statement text, expected_state text, message_part text default '')
returns void language plpgsql as $$
declare caught boolean := false;
begin
  begin
    execute statement;
  exception when others then
    caught := true;
    if sqlstate <> expected_state or position(message_part in sqlerrm) = 0 then
      raise exception 'Unexpected error: % [%], expected % / %', sqlerrm, sqlstate, expected_state, message_part;
    end if;
  end;
  if not caught then raise exception 'Expected error did not occur: %', statement; end if;
end $$;

create temporary table debug_test_users (n integer primary key, id uuid not null);
insert into debug_test_users select n, gen_random_uuid() from generate_series(1, 12) n;
insert into auth.users(id, email) select id, 'debug-test-' || id::text || '@example.invalid' from debug_test_users;
create temporary table debug_test_state (label text primary key, id uuid, code text);
grant select on debug_test_users to authenticated, service_role;
grant select, insert, update on debug_test_state to authenticated, service_role;

-- Validate the instantiated schema/catalog, never migration-source text.
select pg_temp.assert_true((select count(*) = 12 and bool_and(relrowsecurity)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = any(array['debug_parties', 'debug_party_members', 'debug_food_intents',
    'debug_participant_contexts', 'debug_chat_messages', 'debug_agent_runs', 'debug_tool_events', 'debug_product_evidence',
    'debug_cart_items', 'debug_cart_snapshots', 'debug_cart_snapshot_items', 'debug_send_runs'])), 'all twelve tables have RLS');
select pg_temp.assert_true(not exists (
  select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
  where t.relnamespace = 'public'::regnamespace and t.relname like 'debug_%' and c.contype = 'f'
  and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid and i.indpred is null
    and (i.indkey::smallint[])[0:array_length(c.conkey, 1)-1] @> c.conkey)
), 'every foreign key has a matching leading index');
select pg_temp.assert_true(not has_function_privilege('authenticated', 'public.is_debug_party_member(uuid)', 'execute'), 'public helper is not exposed');
select pg_temp.assert_true(not has_function_privilege('anon', 'public.create_debug_party()', 'execute'), 'anonymous create is denied');
select pg_temp.assert_true(not has_function_privilege('authenticated', 'public.advance_debug_cart_revision(uuid,uuid,bigint,jsonb)', 'execute'), 'cart RPC is server-only');
select pg_temp.assert_true(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'debug_%' and c.relkind = 'r'
    and has_table_privilege('anon', c.oid, 'select,insert,update,delete')
), 'anonymous role has no debug-table privileges');

set local role authenticated;
select pg_temp.expect_error('select public.create_debug_party()', '42501', 'Authentication required');
select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 1), true);
insert into debug_test_state(label, code) values ('party', public.create_debug_party());
update debug_test_state set id = (select id from public.debug_parties where code = debug_test_state.code) where label = 'party';
select pg_temp.assert_true((select count(*) = 1 from public.debug_parties), 'host reads own party');
select pg_temp.assert_true((select role = 'host' from public.debug_party_members), 'creator is host');
select pg_temp.expect_error('update public.debug_parties set status = ''finalized''', '42501');

-- Nonmember sees no party rows and cannot submit content or finalize.
select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 2), true);
select pg_temp.assert_true((select count(*) = 0 from public.debug_parties), 'nonmember cannot read party');
do $$
declare table_name text; row_count bigint;
begin
  foreach table_name in array array['debug_party_members', 'debug_food_intents', 'debug_participant_contexts', 'debug_chat_messages',
    'debug_agent_runs', 'debug_tool_events', 'debug_product_evidence', 'debug_cart_items', 'debug_cart_snapshots', 'debug_cart_snapshot_items', 'debug_send_runs'] loop
    execute format('select count(*) from public.%I', table_name) into row_count;
    perform pg_temp.assert_true(row_count = 0, 'nonmember cannot read ' || table_name);
  end loop;
end $$;
select pg_temp.expect_error('insert into public.debug_food_intents(party_id,participant_id,request) select s.id,u.id,''Soup'' from debug_test_state s,debug_test_users u where s.label=''party'' and u.n=2', '42501');
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', '42501', 'Host ownership');
select pg_temp.assert_true(public.join_debug_party((select '  ' || lower(code) || '  ' from debug_test_state where label = 'party')) =
  (select code from debug_test_state where label = 'party'), 'join normalizes code');
select public.join_debug_party((select code from debug_test_state where label = 'party'));
select pg_temp.assert_true((select count(*) = 2 from public.debug_party_members), 'joining twice is idempotent');
select pg_temp.expect_error('select public.join_debug_party(''bad'')', 'P0001', 'Invalid party code');
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', '42501', 'Host ownership');

insert into public.debug_food_intents(party_id, participant_id, request)
  select s.id, u.id, 'Soup' from debug_test_state s, debug_test_users u where s.label = 'party' and u.n = 2;
update public.debug_food_intents set request = 'Vegetable soup';
select pg_temp.assert_true((select revision = 2 from public.debug_food_intents), 'own intent increments revision');
select pg_temp.expect_error('update public.debug_food_intents set revision = 99', '42501');
insert into public.debug_chat_messages(party_id, participant_id, role, content)
  select s.id, u.id, 'user', 'Find cheaper cheese' from debug_test_state s, debug_test_users u where s.label = 'party' and u.n = 2;
select pg_temp.assert_true((select revision = 3 and request = 'Find cheaper cheese' from public.debug_food_intents), 'chat atomically advances participant intent');
select pg_temp.expect_error('insert into public.debug_chat_messages(party_id,participant_id,role,content) select s.id,u.id,''assistant'',''Forged'' from debug_test_state s,debug_test_users u where s.label=''party'' and u.n=2', '42501');
select pg_temp.expect_error('insert into public.debug_product_evidence default values', '42501');

select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 1), true);
update public.debug_food_intents set request = 'Someone else';
select pg_temp.assert_true((select request = 'Find cheaper cheese' from public.debug_food_intents), 'other member intent is not writable');
insert into public.debug_food_intents(party_id, participant_id, request)
  select s.id, u.id, 'Pasta' from debug_test_state s, debug_test_users u where s.label = 'party' and u.n = 1;
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', 'P0001', 'new build');

reset role;
set local role service_role;
insert into public.debug_agent_runs(party_id, actor_id, mode, status)
  select s.id, u.id, 'build', 'completed' from debug_test_state s, debug_test_users u where s.label = 'party' and u.n = 1;
insert into debug_test_state(label, id) select 'run', id from public.debug_agent_runs;
select pg_temp.expect_error('update public.debug_chat_messages set content = ''Rewritten''', 'P0001', 'immutable');
select pg_temp.expect_error('insert into public.debug_participant_contexts(party_id,participant_id,intent_revision,context_status,purchase_history_status,summary,collected_at) select party_id,participant_id,revision+1,''ready'',''unavailable'',''Stale'',now() from public.debug_food_intents', 'P0001', 'revision');
insert into public.debug_product_evidence(party_id, run_id, source, product_id, company_id, branch_id, name, unit, unit_price_cents, available, observed_at)
  select p.id, r.id, 'catalog_search', '123', 'company', 'branch', 'Cheese', 'kg', 1251, true, now()
  from debug_test_state p, debug_test_state r where p.label = 'party' and r.label = 'run';
insert into debug_test_state(label, id) select 'evidence', id from public.debug_product_evidence;
select pg_temp.expect_error('insert into public.debug_cart_items default values', '42501');
select pg_temp.expect_error('select public.advance_debug_cart_revision((select id from debug_test_state where label=''party''),(select id from debug_test_users where n=12),0,''{"type":"add"}'')', '42501', 'membership');
select pg_temp.expect_error('select public.advance_debug_cart_revision((select id from debug_test_state where label=''party''),(select id from debug_test_users where n=1),0,''{"type":"add","quantity":0}'')', 'P0001', 'Invalid quantity');
select pg_temp.assert_true(public.advance_debug_cart_revision(p.id, u.id, 0,
  jsonb_build_object('type', 'add', 'quantity', 1.5, 'evidenceId', e.id))->>'status' = 'applied', 'evidence-backed add succeeds')
  from debug_test_state p, debug_test_state e, debug_test_users u where p.label = 'party' and e.label = 'evidence' and u.n = 1;
insert into debug_test_state(label, id) select 'item', id from public.debug_cart_items;
select pg_temp.assert_true(public.advance_debug_cart_revision(p.id, u.id, 0,
  jsonb_build_object('type', 'quantity', 'quantity', 2, 'itemId', i.id)) = '{"status":"stale","currentRevision":1}'::jsonb, 'stale revision returns current revision')
  from debug_test_state p, debug_test_state i, debug_test_users u where p.label = 'party' and i.label = 'item' and u.n = 1;
select pg_temp.assert_true((select quantity = 1.5 from public.debug_cart_items), 'stale write leaves cart unchanged');
select pg_temp.assert_true(public.advance_debug_cart_revision(p.id, u.id, 1,
  jsonb_build_object('type', 'quantity', 'quantity', 2.5, 'itemId', i.id))->>'currentRevision' = '2', 'quantity write increments once')
  from debug_test_state p, debug_test_state i, debug_test_users u where p.label = 'party' and i.label = 'item' and u.n = 1;

update public.debug_parties set cart_stale = false, status = 'ready';
reset role;
set local role authenticated;
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', 'P0001', 'contexts are stale');
reset role;
set local role service_role;
insert into public.debug_participant_contexts(party_id, participant_id, intent_revision, context_status, purchase_history_status, summary, collected_at)
  select party_id, participant_id, revision, 'ready', 'unavailable', 'Validated compact context', now() from public.debug_food_intents;
update public.debug_party_members set context_status = 'ready';
-- A delayed personal result cannot overwrite current context.
select pg_temp.expect_error('update public.debug_participant_contexts set intent_revision = intent_revision + 1', 'P0001', 'revision');
update public.debug_party_members set context_status = 'pending';
reset role;
set local role authenticated;
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', 'P0001', 'contexts are stale');
reset role;
set local role service_role;
update public.debug_party_members set context_status = 'ready';
update public.debug_agent_runs set status = 'running';
reset role;
set local role authenticated;
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', 'P0001', 'run is active');
reset role;
set local role service_role;
update public.debug_agent_runs set status = 'completed';

-- Remove/replace and rollback of invalid mutations use the same revision lock.
select pg_temp.assert_true(public.advance_debug_cart_revision(p.id, u.id, 2,
  jsonb_build_object('type', 'replace', 'quantity', 2.5, 'itemId', i.id, 'evidenceId', e.id))->>'currentRevision' = '3', 'replace increments once')
  from debug_test_state p, debug_test_state i, debug_test_state e, debug_test_users u
  where p.label = 'party' and i.label = 'item' and e.label = 'evidence' and u.n = 1;
update debug_test_state set id = (select id from public.debug_cart_items) where label = 'item';
select pg_temp.expect_error('select public.advance_debug_cart_revision((select id from debug_test_state where label=''party''),(select id from debug_test_users where n=1),3,jsonb_build_object(''type'',''replace'',''quantity'',2,''itemId'',(select id from debug_test_state where label=''item''),''evidenceId'',gen_random_uuid()))', 'P0001', 'evidence required');
select pg_temp.assert_true((select cart_revision = 3 from public.debug_parties), 'failed mutation does not increment');
select pg_temp.assert_true((select count(*) = 1 from public.debug_cart_items), 'failed replacement keeps original item');
select pg_temp.assert_true(public.advance_debug_cart_revision(p.id, u.id, 3,
  jsonb_build_object('type', 'remove', 'itemId', i.id))->>'currentRevision' = '4', 'remove increments once')
  from debug_test_state p, debug_test_state i, debug_test_users u where p.label = 'party' and i.label = 'item' and u.n = 1;
reset role;
set local role authenticated;
select pg_temp.expect_error('select public.finalize_debug_party((select id from debug_test_state where label=''party''))', 'P0001', '1 to 100 items');
reset role;
set local role service_role;
select public.advance_debug_cart_revision(p.id, u.id, 4, jsonb_build_object('type', 'add', 'quantity', 2.5, 'evidenceId', e.id))
  from debug_test_state p, debug_test_state e, debug_test_users u where p.label = 'party' and e.label = 'evidence' and u.n = 1;

-- A successful finalization freezes recomputed per-line cents and is idempotent.
reset role;
set local role authenticated;
insert into debug_test_state(label, id) values ('snapshot', public.finalize_debug_party((select id from debug_test_state where label = 'party')));
select pg_temp.assert_true((select total_cents = 3128 and cart_revision = 5 from public.debug_cart_snapshots), 'snapshot totals use rounded quantity times current price');
select pg_temp.assert_true((select count(*) = 1 from public.debug_cart_snapshot_items), 'snapshot contains cart line');
select pg_temp.assert_true(public.finalize_debug_party((select id from debug_test_state where label = 'party')) =
  (select id from debug_test_state where label = 'snapshot'), 'finalize retry returns same snapshot');
select pg_temp.expect_error('update public.debug_food_intents set request = ''Changed''', 'P0001', 'finalized');
select pg_temp.expect_error('insert into public.debug_chat_messages(party_id,participant_id,role,content) select s.id,u.id,''user'',''Late'' from debug_test_state s,debug_test_users u where s.label=''party'' and u.n=1', 'P0001', 'finalized');
select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 3), true);
select pg_temp.expect_error('select public.join_debug_party((select code from debug_test_state where label=''party''))', 'P0001', 'finalized');
reset role;
set local role service_role;
select pg_temp.expect_error('update public.debug_cart_snapshot_items set quantity = 99', '42501');
select pg_temp.expect_error('delete from public.debug_cart_snapshots', '42501');
select pg_temp.expect_error('select public.advance_debug_cart_revision((select id from debug_test_state where label=''party''),(select id from debug_test_users where n=1),2,''{"type":"remove"}'')', 'P0001', 'unavailable');

-- Capacity and late-join invalidation on a separate party.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 1), true);
insert into debug_test_state(label, code) values ('capacity', public.create_debug_party());
update debug_test_state set id = (select id from public.debug_parties where code = debug_test_state.code) where label = 'capacity';
reset role;
set local role service_role;
update public.debug_parties set cart_stale = false, status = 'ready' where id = (select id from debug_test_state where label = 'capacity');
reset role;
set local role authenticated;
do $$
declare participant record;
begin
  for participant in select * from debug_test_users where n between 2 and 10 loop
    perform set_config('request.jwt.claim.sub', participant.id::text, true);
    perform public.join_debug_party((select code from debug_test_state where label = 'capacity'));
  end loop;
end $$;
select pg_temp.assert_true((select cart_stale and status = 'collecting' from public.debug_parties where id = (select id from debug_test_state where label = 'capacity')), 'late join invalidates built cart');
select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 11), true);
select pg_temp.expect_error('select public.join_debug_party((select code from debug_test_state where label=''capacity''))', 'P0001', 'full');
reset role;
select pg_temp.assert_true((select count(*) = 10 from public.debug_party_members where party_id = (select id from debug_test_state where label = 'capacity')), 'ten-member cap holds');
-- Cross-party provenance cannot be attached to a cart even by the server RPC.
set local role service_role;
select pg_temp.expect_error('select public.advance_debug_cart_revision((select id from debug_test_state where label=''capacity''),(select id from debug_test_users where n=1),0,jsonb_build_object(''type'',''add'',''quantity'',1,''evidenceId'',(select id from debug_test_state where label=''evidence'')))', 'P0001', 'evidence required');
reset role;
-- Repeat isolation checks now that every core lifecycle table contains data.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from debug_test_users where n = 12), true);
do $$
declare table_name text; row_count bigint;
begin
  foreach table_name in array array['debug_parties', 'debug_party_members', 'debug_food_intents', 'debug_participant_contexts', 'debug_chat_messages',
    'debug_agent_runs', 'debug_tool_events', 'debug_product_evidence', 'debug_cart_items', 'debug_cart_snapshots', 'debug_cart_snapshot_items', 'debug_send_runs'] loop
    execute format('select count(*) from public.%I', table_name) into row_count;
    perform pg_temp.assert_true(row_count = 0, 'nonmember cannot read populated ' || table_name);
  end loop;
end $$;
reset role;
set local role anon;
select pg_temp.expect_error('select * from public.debug_parties', '42501');
reset role;

-- Successful incremental turns clear staleness without requiring silent members.
set local role service_role;
insert into public.debug_agent_runs(party_id,actor_id,mode,status)
  select s.id,u.id,'chat','running' from debug_test_state s,debug_test_users u where s.label='capacity' and u.n=1;
update public.debug_agent_runs set status='completed' where party_id=(select id from debug_test_state where label='capacity');
select pg_temp.assert_true((select not cart_stale from public.debug_parties where id=(select id from debug_test_state where label='capacity')), 'successful chat clears stale state with silent members');
-- A new intent during an active run must survive that run's completion.
insert into public.debug_agent_runs(party_id,actor_id,mode,status)
  select s.id,u.id,'chat','running' from debug_test_state s,debug_test_users u where s.label='capacity' and u.n=1;
insert into public.debug_chat_messages(party_id,participant_id,role,content)
  select s.id,u.id,'user','Add water' from debug_test_state s,debug_test_users u where s.label='capacity' and u.n=2;
update public.debug_agent_runs set status='completed' where party_id=(select id from debug_test_state where label='capacity') and status='running';
select pg_temp.assert_true((select cart_stale from public.debug_parties where id=(select id from debug_test_state where label='capacity')), 'new intent remains stale after older run');
reset role;
