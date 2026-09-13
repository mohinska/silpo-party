-- Private durable state. These objects are additive; historical baskets/proposals remain.
create extension if not exists pgmq;
select pgmq.create('party_agent_v2');

drop policy if exists "Party members read shared food profiles" on public.profiles;
update public.ai_meal_proposals set proposal = proposal - 'inputFingerprint' where proposal ? 'inputFingerprint';

alter table public.party_chat_messages add column recipient_id uuid references auth.users(id) on delete cascade;
create index party_chat_messages_recipient_idx on public.party_chat_messages(recipient_id) where recipient_id is not null;
drop policy "Members read party chat" on public.party_chat_messages;
create policy "Members read shared or own assistant chat" on public.party_chat_messages for select to authenticated
 using (public.is_party_member(party_id) and (recipient_id is null or recipient_id=(select auth.uid())));
drop policy "Members add their own party chat" on public.party_chat_messages;
create policy "Members add their own shared chat" on public.party_chat_messages for insert to authenticated
 with check (role='user' and participant_id=(select auth.uid()) and recipient_id is null and public.is_party_member(party_id));
alter table public.party_chat_messages add constraint assistant_recipient_only check (recipient_id is null or role='assistant');
alter table public.party_chat_messages drop constraint party_chat_messages_status_check;
alter table public.party_chat_messages add constraint party_chat_messages_status_check check (status in ('queued','running','completed','failed','waiting_for_input','blocked','cancelled','superseded'));
alter table public.agent_runs drop constraint agent_runs_status_check;
alter table public.agent_runs add constraint agent_runs_status_check check (status in ('queued','running','completed','completed_with_warnings','failed','waiting_for_input','blocked','cancelled','superseded'));

create table public.party_agent_workspaces (
 party_id uuid primary key references public.parties(id) on delete cascade,
 schema_version integer not null default 2 check (schema_version=2),
 input_revision bigint not null default 0 check (input_revision>=0),
 draft_revision bigint not null default 0 check (draft_revision>=0),
 workspace jsonb not null check (jsonb_typeof(workspace)='object'),
 checkpoint jsonb not null default '{}',
 step_sequence bigint not null default 0 check (step_sequence>=0),
 fence bigint not null default 0 check (fence>=0),
 lease_owner text, lease_until timestamptz,
 updated_at timestamptz not null default now()
);
create table public.party_agent_events (
 id uuid primary key default gen_random_uuid(),
 party_id uuid not null references public.parties(id) on delete cascade,
 actor_id uuid not null references auth.users(id),
 idempotency_key text not null,
 kind text not null check (kind in ('chat','request_edit','context_refresh','manual_edit','approval','resume')),
 payload jsonb not null,
 input_revision bigint not null,
 created_at timestamptz not null default now(),
 unique(party_id,idempotency_key)
);
create index party_agent_events_actor_idx on public.party_agent_events(actor_id);
create table public.party_agent_queue (
 id uuid primary key default gen_random_uuid(),
 party_id uuid not null references public.parties(id) on delete cascade,
 event_id uuid not null unique references public.party_agent_events(id) on delete cascade,
 message_id bigint not null unique,
 status text not null default 'queued' check (status in ('queued','running','completed','failed','waiting_for_input','blocked','cancelled','superseded')),
 attempts integer not null default 0,
 fence bigint, worker_id text,
 persisted_step bigint,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index party_agent_queue_claim_idx on public.party_agent_queue(created_at) where status in ('queued','running');
create index party_agent_queue_party_idx on public.party_agent_queue(party_id);
create table public.party_agent_steps (
 party_id uuid not null references public.parties(id) on delete cascade,
 step_sequence bigint not null,
 job_id uuid not null references public.party_agent_queue(id),
 fence bigint not null,
 input_revision bigint not null,
 messages jsonb not null,
 checkpoint jsonb not null,
 created_at timestamptz not null default now(),
 primary key(party_id,step_sequence)
);
create index party_agent_steps_job_idx on public.party_agent_steps(job_id);
create table public.party_agent_drafts (
 party_id uuid not null references public.parties(id) on delete cascade,
 draft_revision bigint not null check (draft_revision>0),
 input_revision bigint not null,
 ready boolean not null,
 projection jsonb not null,
 created_at timestamptz not null default now(),
 primary key(party_id,draft_revision)
);
create table public.party_agent_activity (
 id bigint generated always as identity primary key,
 party_id uuid not null references public.parties(id) on delete cascade,
 input_revision bigint not null,
 draft_revision bigint not null,
 code text not null check (code in ('queued','working','draft_updated','waiting_for_input','blocked','completed','failed','cancelled','superseded')),
 created_at timestamptz not null default now()
);
create index party_agent_activity_party_idx on public.party_agent_activity(party_id,id);
create table public.party_cart_operations (
 id uuid primary key default gen_random_uuid(),
 party_id uuid not null references public.parties(id) on delete cascade,
 draft_revision bigint not null,
 approved_by uuid not null references auth.users(id),
 idempotency_key text not null,
 approved_snapshot jsonb not null,
 status text not null default 'approved' check (status in ('approved','applying','verified','failed','unknown','cancelled')),
 baseline jsonb, expected_cart jsonb, readback jsonb, private_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(party_id,draft_revision) references public.party_agent_drafts(party_id,draft_revision),
 unique(party_id,idempotency_key)
);
create index party_cart_operations_approver_idx on public.party_cart_operations(approved_by);

do $$ declare target text; begin
 foreach target in array array['party_agent_workspaces','party_agent_events','party_agent_queue','party_agent_steps','party_agent_drafts','party_agent_activity','party_cart_operations'] loop
  execute format('alter table public.%I enable row level security',target);
  execute format('revoke all on public.%I from public, anon, authenticated',target);
  execute format('grant select, insert, update, delete on public.%I to service_role',target);
 end loop;
end $$;
grant usage, select on sequence public.party_agent_activity_id_seq to service_role;
grant select on public.party_agent_drafts, public.party_agent_activity to authenticated;
create policy "Members read safe draft revisions" on public.party_agent_drafts for select to authenticated using(public.is_party_member(party_id));
create policy "Members read safe activity" on public.party_agent_activity for select to authenticated using(public.is_party_member(party_id));

-- Every RPC is SECURITY INVOKER, service-role only, and uses a per-party row lock.
create function public.agent_v2_enqueue(p_party_id uuid,p_actor_id uuid,p_idempotency_key text,p_kind text,p_payload jsonb,p_changes_input boolean,p_initial_workspace jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; existing uuid; event_id uuid; job_id uuid; queue_message bigint;
begin
 if not exists(select 1 from public.party_members where party_id=p_party_id and user_id=p_actor_id) then raise exception 'Party membership required'; end if;
 insert into public.party_agent_workspaces(party_id,workspace) values(p_party_id,p_initial_workspace) on conflict do nothing;
 select * into w from public.party_agent_workspaces where party_id=p_party_id for update;
 select q.id into existing from public.party_agent_events e join public.party_agent_queue q on q.event_id=e.id where e.party_id=p_party_id and e.idempotency_key=p_idempotency_key;
 if existing is not null then return existing; end if;
 if p_changes_input then
  update public.party_agent_workspaces set input_revision=input_revision+1,workspace=jsonb_set(workspace,'{inputRevision}',to_jsonb(input_revision+1)),updated_at=now() where party_id=p_party_id returning * into w;
 end if;
 insert into public.party_agent_events(party_id,actor_id,idempotency_key,kind,payload,input_revision) values(p_party_id,p_actor_id,p_idempotency_key,p_kind,p_payload,w.input_revision) returning id into event_id;
 select pgmq.send('party_agent_v2',jsonb_build_object('event_id',event_id,'party_id',p_party_id)) into queue_message;
 insert into public.party_agent_queue(party_id,event_id,message_id) values(p_party_id,event_id,queue_message) returning id into job_id;
 insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(p_party_id,w.input_revision,w.draft_revision,'queued');
 return job_id;
end $$;

create function public.agent_v2_claim(p_worker_id text,p_lease_seconds integer default 60)
returns table(job_id uuid,party_id uuid,event_id uuid,fence bigint,input_revision bigint,draft_revision bigint,step_sequence bigint,workspace jsonb,checkpoint jsonb)
language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue;
begin
 if length(trim(p_worker_id))=0 or p_lease_seconds not between 1 and 60 then raise exception 'Invalid lease'; end if;
 select s.* into w from public.party_agent_workspaces s
 where (s.lease_until is null or s.lease_until<=clock_timestamp()) and exists(select 1 from public.party_agent_queue j where j.party_id=s.party_id and j.status in ('queued','running'))
 order by s.updated_at for update skip locked limit 1;
 if not found then return; end if;
 select j.* into q from public.party_agent_queue j where j.party_id=w.party_id and j.status in ('queued','running') order by j.created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.party_agent_workspaces s set fence=s.fence+1,lease_owner=p_worker_id,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where s.party_id=w.party_id returning s.* into w;
 update public.party_agent_queue set status='running',attempts=attempts+1,fence=w.fence,worker_id=p_worker_id,updated_at=now() where id=q.id;
 return query select q.id,w.party_id,q.event_id,w.fence,w.input_revision,w.draft_revision,w.step_sequence,w.workspace,w.checkpoint;
end $$;

create function public.agent_v2_checkpoint(p_job_id uuid,p_worker_id text,p_fence bigint,p_expected_input bigint,p_expected_draft bigint,p_step bigint,p_workspace jsonb,p_messages jsonb,p_checkpoint jsonb,p_projection jsonb default null,p_activity_code text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue; next_input bigint; next_draft bigint;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.status<>'running' or q.fence<>p_fence or w.input_revision<>p_expected_input or w.draft_revision<>p_expected_draft then raise exception 'Stale worker or revision'; end if;
 if p_step<>w.step_sequence+1 then raise exception 'Invalid step sequence'; end if;
 next_input := (p_workspace->>'inputRevision')::bigint;
 next_draft := (p_workspace->>'draftRevision')::bigint;
 if next_input is null or next_input not between w.input_revision and w.input_revision+1 or next_draft is null or next_draft<>w.draft_revision+(case when p_projection is null then 0 else 1 end) or p_workspace->>'partyId' is distinct from w.party_id::text or (p_workspace->>'schemaVersion')::integer is distinct from 2 then raise exception 'Invalid workspace revisions'; end if;
 if p_projection is not null then
  if (p_projection->>'inputRevision')::bigint is distinct from next_input or (p_projection->>'draftRevision')::bigint is distinct from next_draft or p_projection->>'partyId' is distinct from w.party_id::text or p_projection ?| array['contexts','evidence','privateReason','participants','outcomes','requests'] then raise exception 'Invalid public projection'; end if;
  insert into public.party_agent_drafts(party_id,draft_revision,input_revision,ready,projection) values(w.party_id,next_draft,next_input,(p_projection->>'ready')::boolean,p_projection);
 end if;
 insert into public.party_agent_steps(party_id,step_sequence,job_id,fence,input_revision,messages,checkpoint) values(w.party_id,p_step,q.id,p_fence,next_input,p_messages,p_checkpoint);
 update public.party_agent_workspaces set workspace=p_workspace,checkpoint=p_checkpoint,input_revision=next_input,draft_revision=next_draft,step_sequence=p_step,updated_at=now() where party_id=w.party_id;
 update public.party_agent_queue set persisted_step=p_step,updated_at=now() where id=q.id;
 if p_activity_code is not null then insert into public.party_agent_activity(party_id,input_revision,draft_revision,code) values(w.party_id,next_input,next_draft,p_activity_code); end if;
end $$;

create function public.agent_v2_ack(p_job_id uuid,p_worker_id text,p_fence bigint,p_step bigint,p_status text)
returns void language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; q public.party_agent_queue;
begin
 select * into q from public.party_agent_queue where id=p_job_id;
 select * into w from public.party_agent_workspaces where party_id=q.party_id for update;
 if w.party_id is null or w.lease_owner is distinct from p_worker_id or w.fence<>p_fence or w.lease_until<=clock_timestamp() or q.fence<>p_fence or q.status<>'running' then raise exception 'Stale worker or revision'; end if;
 if q.persisted_step is null or q.persisted_step<>p_step or not exists(select 1 from public.party_agent_steps where job_id=q.id and step_sequence=p_step and fence=p_fence) then raise exception 'Persist a step before acknowledging'; end if;
 if p_status not in ('queued','completed','failed','waiting_for_input','blocked','cancelled','superseded') then raise exception 'Invalid acknowledgement status'; end if;
 update public.party_agent_queue set status=p_status,worker_id=null,updated_at=now() where id=q.id;
 update public.party_agent_workspaces set lease_owner=null,lease_until=null,updated_at=now() where party_id=w.party_id;
 if p_status<>'queued' then perform pgmq.delete('party_agent_v2',q.message_id); end if;
end $$;

create function public.agent_v2_approve(p_party_id uuid,p_actor_id uuid,p_draft_revision bigint,p_idempotency_key text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare w public.party_agent_workspaces; d public.party_agent_drafts; result uuid;
begin
 if not exists(select 1 from public.parties where id=p_party_id and host_id=p_actor_id) then raise exception 'Host approval required'; end if;
 select * into w from public.party_agent_workspaces where party_id=p_party_id for update;
 select id into result from public.party_cart_operations where party_id=p_party_id and idempotency_key=p_idempotency_key and draft_revision=p_draft_revision;
 if result is not null then return result; end if;
 select * into d from public.party_agent_drafts where party_id=p_party_id and draft_revision=p_draft_revision;
 if d.party_id is null or not d.ready or d.input_revision<>w.input_revision or d.draft_revision<>w.draft_revision then raise exception 'Exact current ready draft required'; end if;
 insert into public.party_cart_operations(party_id,draft_revision,approved_by,idempotency_key,approved_snapshot) values(p_party_id,p_draft_revision,p_actor_id,p_idempotency_key,d.projection) returning id into result;
 return result;
end $$;

-- Approval and published snapshots are immutable even to ordinary service updates.
create function public.agent_v2_immutable_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='party_agent_drafts' or new.approved_snapshot is distinct from old.approved_snapshot or new.party_id<>old.party_id or new.draft_revision<>old.draft_revision or new.approved_by<>old.approved_by then raise exception 'Approved snapshot is immutable'; end if;
 return new;
end $$;
create trigger immutable_approved_snapshot before update on public.party_cart_operations for each row execute function public.agent_v2_immutable_snapshot();
-- Published drafts have no UPDATE grant; a trigger also protects service code.
create function public.agent_v2_immutable_draft() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Published draft is immutable'; end $$;
create trigger immutable_published_draft before update on public.party_agent_drafts for each row execute function public.agent_v2_immutable_draft();
revoke update,delete on public.party_agent_drafts from service_role;

do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'agent_v2_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
grant usage on schema pgmq to service_role;
grant execute on function pgmq.send(text,jsonb,integer), pgmq.delete(text,bigint) to service_role;
grant select,insert,update,delete on pgmq.q_party_agent_v2 to service_role;
grant usage,select on sequence pgmq.q_party_agent_v2_msg_id_seq to service_role;

do $$ declare target text; begin
 foreach target in array array['party_agent_drafts','party_agent_activity'] loop
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=target) then execute format('alter publication supabase_realtime add table public.%I',target); end if;
 end loop;
end $$;
