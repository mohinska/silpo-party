create table public.party_chat_messages (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  participant_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 2000),
  status text not null default 'completed' check (status in ('queued', 'running', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

create index party_chat_messages_party_time_idx
  on public.party_chat_messages(party_id, created_at);

alter table public.party_chat_messages enable row level security;

create policy "Members read party chat"
  on public.party_chat_messages for select to authenticated
  using (public.is_party_member(party_id));

create policy "Members add their own party chat"
  on public.party_chat_messages for insert to authenticated
  with check (
    role = 'user'
    and participant_id = (select auth.uid())
    and public.is_party_member(party_id)
  );

grant select, insert on public.party_chat_messages to authenticated;
revoke update, delete on public.party_chat_messages from authenticated;
grant select, insert, update on public.party_chat_messages to service_role;
