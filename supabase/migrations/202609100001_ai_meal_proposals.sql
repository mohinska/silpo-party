create table public.ai_meal_proposals (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'rejected', 'applying', 'applied', 'failed')),
  proposal jsonb not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_meal_proposals enable row level security;
create policy "Members read meal proposals" on public.ai_meal_proposals for select to authenticated
using (public.is_party_member(party_id));
grant select on public.ai_meal_proposals to authenticated;
revoke insert, update, delete on public.ai_meal_proposals from anon, authenticated;
create index ai_meal_proposals_party_created_idx on public.ai_meal_proposals(party_id, created_at desc);

alter table public.basket_items
  add column source text not null default 'manual' check (source in ('manual', 'ai')),
  add column ai_proposal_id uuid references public.ai_meal_proposals(id) on delete set null;

create unique index basket_items_ai_product_unique
  on public.basket_items(party_id, silpo_product_id, silpo_company_id, silpo_branch_id)
  where source = 'ai' and silpo_product_id is not null;

revoke insert on public.basket_items from authenticated;
grant insert (party_id, name, quantity, unit, unit_price_cents, added_by, source)
  on public.basket_items to authenticated;

create or replace function public.protect_silpo_basket_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    new.silpo_product_id := old.silpo_product_id;
    new.silpo_company_id := old.silpo_company_id;
    new.silpo_branch_id := old.silpo_branch_id;
    new.silpo_product_slug := old.silpo_product_slug;
    new.silpo_image_url := old.silpo_image_url;
    new.silpo_sync_status := old.silpo_sync_status;
    new.silpo_sync_error := old.silpo_sync_error;
    new.source := old.source;
    new.ai_proposal_id := old.ai_proposal_id;
    if old.silpo_product_id is not null then
      new.name := old.name;
      new.unit := old.unit;
      new.unit_price_cents := old.unit_price_cents;
    end if;
  end if;
  return new;
end $$;
