-- Hotfix for databases where 202609090001_party_prototype.sql was already applied.
-- gen_random_bytes belongs to pgcrypto's extension schema, which is intentionally
-- excluded from this security-definer function's search_path. PostgreSQL's built-in
-- UUID generator is explicitly schema-qualified instead.
create or replace function public.create_party(
  party_title text,
  member_name text,
  member_email text default null,
  member_avatar text default null
) returns text language plpgsql security definer set search_path = public as $$
declare new_party_id uuid; new_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(party_title)) not between 1 and 80 then raise exception 'Invalid party title'; end if;
  loop
    new_code := upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from parties where code = new_code);
  end loop;
  insert into parties(code, title, host_id)
  values(new_code, trim(party_title), auth.uid())
  returning id into new_party_id;
  insert into party_members(party_id, user_id, role, display_name, email, avatar_url)
  values(
    new_party_id,
    auth.uid(),
    'host',
    left(coalesce(nullif(trim(member_name), ''), 'Host'), 100),
    member_email,
    member_avatar
  );
  return new_code;
end $$;

revoke all on function public.create_party(text, text, text, text) from public;
grant execute on function public.create_party(text, text, text, text) to authenticated;
