alter table public.parties
  alter column budget_cents drop not null,
  alter column budget_cents drop default;

update public.parties
set budget_cents = null
where budget_cents = 0;

comment on column public.parties.budget_cents is
  'Optional shared budget in kopecks. NULL means no hard budget constraint.';
