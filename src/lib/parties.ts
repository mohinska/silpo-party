import "server-only";

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type Party = {
  id: string;
  code: string;
  title: string;
  host_id: string;
  budget_cents: number | null;
  status: "collecting" | "finalized";
  finalized_at: string | null;
  silpo_cart_id: string | null;
  silpo_sync_status: "pending" | "synced" | "error";
  silpo_sync_error: string | null;
  silpo_synced_at: string | null;
  silpo_checkout_url: string | null;
  created_at: string;
};

export type PartyMember = {
  party_id: string;
  user_id: string;
  role: "host" | "member";
  display_name: string;
  email: string | null;
  avatar_url: string | null;
};

export type FoodIntent = {
  party_id: string;
  user_id: string;
  dish_name: string;
  description: string;
  content_url: string;
  indifferent: boolean;
};

export type BasketItem = {
  id: string;
  party_id: string;
  name: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  added_by: string;
  silpo_product_id: string | null;
  silpo_company_id: string | null;
  silpo_branch_id: string | null;
  silpo_product_slug: string | null;
  silpo_image_url: string | null;
  silpo_sync_status: "pending" | "synced" | "error";
  silpo_sync_error: string | null;
  source: "manual" | "ai";
  ai_proposal_id: string | null;
};

export type ItemShare = { item_id: string; user_id: string };

export type FoodProfile = {
  id: string;
  allergies: string;
  dietary_restrictions: string;
  dislikes: string;
  preferences: string;
};

export type PartyChatMessage = {
  id: string;
  party_id: string;
  participant_id: string | null;
  agent_run_id: string | null;
  recipient_id: string | null;
  role: "user" | "assistant";
  content: string;
  status: "queued" | "running" | "completed" | "failed" | "waiting_for_input" | "blocked" | "cancelled" | "superseded";
  created_at: string;
};

export async function listMyParties() {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: memberships, error: membershipError } = await supabase
    .from("party_members")
    .select("party_id, role")
    .eq("user_id", user.id);
  if (membershipError) throw membershipError;
  if (!memberships?.length) return [];
  const { data: parties, error } = await supabase
    .from("parties")
    .select("id, code, title, host_id, budget_cents, status, finalized_at, silpo_cart_id, silpo_sync_status, silpo_sync_error, silpo_synced_at, silpo_checkout_url, created_at")
    .in("id", memberships.map((membership) => membership.party_id))
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (parties as Party[]).map((party) => ({
    ...party,
    role: memberships.find((membership) => membership.party_id === party.id)?.role as "host" | "member",
  }));
}

export async function getPartyWorkspace(code: string) {
  const user = await requireUser();
  const supabase = await createClient();
  const normalizedCode = code.trim().toUpperCase();
  const { data: party, error } = await supabase
    .from("parties")
    .select("id, code, title, host_id, budget_cents, status, finalized_at, silpo_cart_id, silpo_sync_status, silpo_sync_error, silpo_synced_at, silpo_checkout_url, created_at")
    .eq("code", normalizedCode)
    .maybeSingle();
  if (error || !party) notFound();

  const [membersResult, intentsResult, itemsResult, messagesResult] = await Promise.all([
    supabase.from("party_members").select("party_id, user_id, role, display_name, email, avatar_url").eq("party_id", party.id).order("joined_at"),
    supabase.from("food_intents").select("party_id, user_id, dish_name, description, content_url, indifferent").eq("party_id", party.id),
    supabase.from("basket_items").select("id, party_id, name, quantity, unit, unit_price_cents, added_by, silpo_product_id, silpo_company_id, silpo_branch_id, silpo_product_slug, silpo_image_url, silpo_sync_status, silpo_sync_error, source, ai_proposal_id").eq("party_id", party.id).order("created_at"),
    supabase.from("party_chat_messages").select("id, party_id, participant_id, agent_run_id, recipient_id, role, content, status, created_at").eq("party_id", party.id).order("created_at"),
  ]);
  if (membersResult.error) throw membersResult.error;
  if (intentsResult.error) throw intentsResult.error;
  if (itemsResult.error) throw itemsResult.error;
  if (messagesResult.error) throw messagesResult.error;

  const members = (membersResult.data ?? []) as PartyMember[];
  const items = (itemsResult.data ?? []) as BasketItem[];
  const [sharesResult, profilesResult] = await Promise.all([
    items.length
      ? supabase.from("basket_item_shares").select("item_id, user_id").in("item_id", items.map((item) => item.id))
      : Promise.resolve({ data: [], error: null }),
    members.length
      ? supabase.from("profiles").select("id, allergies, dietary_restrictions, dislikes, preferences").in("id", members.map((member) => member.user_id))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sharesResult.error) throw sharesResult.error;
  if (profilesResult.error) throw profilesResult.error;

  return {
    user,
    party: party as Party,
    members,
    profiles: (profilesResult.data ?? []) as FoodProfile[],
    intents: (intentsResult.data ?? []) as FoodIntent[],
    items,
    shares: (sharesResult.data ?? []) as ItemShare[],
    messages: (messagesResult.data ?? []) as PartyChatMessage[],
  };
}

export function lineTotalCents(item: BasketItem) {
  return Math.round(Number(item.quantity) * Number(item.unit_price_cents));
}

export function calculateSplit(members: PartyMember[], items: BasketItem[], shares: ItemShare[]) {
  const totals = new Map(members.map((member) => [member.user_id, 0]));
  for (const item of items) {
    const owners = shares.filter((share) => share.item_id === item.id).map((share) => share.user_id).sort();
    const effectiveOwners = owners.length ? owners : [item.added_by];
    const total = lineTotalCents(item);
    const base = Math.floor(total / effectiveOwners.length);
    let remainder = total - base * effectiveOwners.length;
    for (const owner of effectiveOwners) {
      totals.set(owner, (totals.get(owner) ?? 0) + base + (remainder-- > 0 ? 1 : 0));
    }
  }
  return totals;
}

export function formatMoney(cents: number) {
  return new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH" }).format(cents / 100);
}
