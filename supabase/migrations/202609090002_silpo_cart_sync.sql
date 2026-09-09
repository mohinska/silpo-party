alter table public.parties
  add column silpo_cart_id text,
  add column silpo_sync_status text not null default 'pending'
    check (silpo_sync_status in ('pending', 'synced', 'error')),
  add column silpo_sync_error text,
  add column silpo_synced_at timestamptz,
  add column silpo_checkout_url text;

alter table public.basket_items
  add column silpo_product_id text,
  add column silpo_company_id text,
  add column silpo_branch_id text,
  add column silpo_product_slug text,
  add column silpo_image_url text,
  add column silpo_sync_status text not null default 'pending'
    check (silpo_sync_status in ('pending', 'synced', 'error')),
  add column silpo_sync_error text;

create index basket_items_silpo_product_idx
  on public.basket_items(party_id, silpo_product_id)
  where silpo_product_id is not null;

-- Integration metadata is maintained only by server code using the service role.
-- App users keep access to the collaborative fields granted by the first migration.
revoke update on public.parties from authenticated;
grant update (budget_cents, status, finalized_at, updated_at)
  on public.parties to authenticated;

revoke update on public.basket_items from authenticated;
grant update (name, quantity, unit, unit_price_cents, updated_at)
  on public.basket_items to authenticated;

revoke insert on public.basket_items from authenticated;
grant insert (party_id, name, quantity, unit, unit_price_cents, added_by)
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
    if old.silpo_product_id is not null then
      new.name := old.name;
      new.unit := old.unit;
      new.unit_price_cents := old.unit_price_cents;
    end if;
  end if;
  return new;
end $$;

create trigger protect_silpo_basket_fields_before_update
before update on public.basket_items
for each row execute function public.protect_silpo_basket_fields();
