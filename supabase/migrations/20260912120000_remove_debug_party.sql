-- Remove the temporary AI Debug party schema after the product flow moved to
-- the canonical parties/basket tables. Historical migrations stay immutable.

drop function if exists public.clear_debug_party(uuid);
drop function if exists public.finalize_debug_party(uuid);
drop function if exists public.advance_debug_cart_revision(uuid, uuid, bigint, jsonb);
drop function if exists public.set_debug_party_budget(uuid, bigint);
drop function if exists public.join_debug_party(text);
drop function if exists public.create_debug_party();
drop function if exists public.is_debug_party_member(uuid);

drop table if exists public.debug_send_runs cascade;
drop table if exists public.debug_cart_snapshot_items cascade;
drop table if exists public.debug_cart_snapshots cascade;
drop table if exists public.debug_cart_items cascade;
drop table if exists public.debug_product_evidence cascade;
drop table if exists public.debug_tool_events cascade;
drop table if exists public.debug_agent_runs cascade;
drop table if exists public.debug_chat_messages cascade;
drop table if exists public.debug_participant_contexts cascade;
drop table if exists public.debug_recipe_records cascade;
drop table if exists public.debug_food_intents cascade;
drop table if exists public.debug_party_members cascade;
drop table if exists public.debug_parties cascade;

drop schema if exists debug_party_private cascade;
