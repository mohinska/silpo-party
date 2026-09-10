"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  findSilpoProducts,
  removePartyItemFromSilpo,
  syncPartyBasketToSilpo,
  type SilpoProductOption,
} from "@/lib/silpo/cart";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyMealProposal, createMealProposal, rejectMealProposal } from "@/lib/ai/planning/proposals";
import { getPartyWorkspace } from "@/lib/parties";

function clean(value: FormDataEntryValue | null, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function userIdentity(user: Awaited<ReturnType<typeof requireUser>>) {
  return {
    member_name: clean(user.user_metadata.full_name ?? user.user_metadata.name ?? "Учасник", 100),
    member_email: user.email ?? null,
    member_avatar: typeof user.user_metadata.avatar_url === "string" ? user.user_metadata.avatar_url : null,
  };
}

async function partyForMember(code: string) {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: party, error } = await supabase
    .from("parties")
    .select("id, code, host_id, status, budget_cents")
    .eq("code", code.trim().toUpperCase())
    .single();
  if (error || !party) throw new Error("Подію не знайдено або ви не є її учасником.");
  return { user, supabase, party };
}

export async function createParty(formData: FormData) {
  const user = await requireUser();
  const title = clean(formData.get("title"), 80);
  if (!title) throw new Error("Вкажіть назву події.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_party", {
    party_title: title,
    ...userIdentity(user),
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Не вдалося створити подію.");
  redirect(`/party/${data}`);
}

export async function joinByCode(formData: FormData) {
  const code = clean(formData.get("code"), 8).toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new Error("Код події має містити 8 символів.");
  await joinParty(code);
}

export async function joinParty(code: string) {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("join_party", {
    party_code: code.trim().toUpperCase(),
    ...userIdentity(user),
  });
  if (error || typeof data !== "string") throw new Error(error?.message ?? "Не вдалося приєднатися.");
  redirect(`/party/${data}`);
}

export async function saveBudget(code: string, formData: FormData) {
  const { user, supabase, party } = await partyForMember(code);
  if (party.host_id !== user.id) throw new Error("Лише Організатор може змінювати бюджет.");
  const budget = Number(clean(formData.get("budget"), 20).replace(",", "."));
  if (!Number.isFinite(budget) || budget < 0 || budget > 10_000_000) throw new Error("Вкажіть коректний бюджет.");
  const { error } = await supabase.from("parties").update({
    budget_cents: Math.round(budget * 100),
    updated_at: new Date().toISOString(),
  }).eq("id", party.id);
  if (error) throw error;
  revalidatePath(`/party/${party.code}`);
}

export async function saveIntent(code: string, formData: FormData) {
  const { user, supabase, party } = await partyForMember(code);
  if (party.status !== "collecting") throw new Error("Подію вже фіналізовано.");
  const indifferent = formData.get("indifferent") === "on";
  const { error } = await supabase.from("food_intents").upsert({
    party_id: party.id,
    user_id: user.id,
    dish_name: indifferent ? "" : clean(formData.get("dish_name"), 120),
    description: indifferent ? "" : clean(formData.get("description"), 1000),
    content_url: indifferent ? "" : clean(formData.get("content_url"), 500),
    indifferent,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  revalidatePath(`/party/${party.code}`);
}

export async function addItem(code: string, formData: FormData) {
  const { user, supabase, party } = await partyForMember(code);
  if (party.status !== "collecting") throw new Error("Подію вже фіналізовано.");
  const name = clean(formData.get("name"), 120);
  const productId = clean(formData.get("silpo_product_id"), 120);
  const companyId = clean(formData.get("silpo_company_id"), 120);
  const branchId = clean(formData.get("silpo_branch_id"), 120);
  const quantity = Number(clean(formData.get("quantity"), 20).replace(",", "."));
  if (!name || !productId || !companyId || !branchId || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Оберіть товар зі списку «Сільпо» та вкажіть додатну цілу кількість.");
  }
  const selectedProduct = (await findSilpoProducts(party.host_id, name)).find((product) => (
    product.productId === productId
    && product.companyId === companyId
    && product.branchId === branchId
  ));
  if (!selectedProduct) throw new Error("Обраний товар більше недоступний. Оновіть пошук у «Сільпо».");
  const { data: item, error } = await supabase.from("basket_items").insert({
    party_id: party.id,
    name: selectedProduct.name,
    unit: selectedProduct.displayRatio ?? "шт.",
    quantity,
    unit_price_cents: selectedProduct.priceCents ?? 0,
    added_by: user.id,
  }).select("id").single();
  if (error || !item) throw error ?? new Error("Не вдалося додати товар.");
  // RLS deliberately prevents browser-authenticated users from setting Silpo
  // metadata. This action has already verified the MCP product, so persist its
  // IDs through the server-only service-role client before cart synchronization.
  const { error: metadataError } = await createAdminClient().from("basket_items").update({
    silpo_product_id: selectedProduct.productId,
    silpo_company_id: selectedProduct.companyId,
    silpo_branch_id: selectedProduct.branchId,
    silpo_image_url: selectedProduct.imageUrl ?? null,
    silpo_sync_status: "pending",
    silpo_sync_error: null,
  }).eq("id", item.id).eq("party_id", party.id);
  if (metadataError) {
    await supabase.from("basket_items").delete().eq("id", item.id);
    throw metadataError;
  }
  const { error: shareError } = await supabase.rpc("set_item_shares", {
    target_item_id: item.id,
    owner_ids: [user.id],
  });
  if (shareError) {
    await supabase.from("basket_items").delete().eq("id", item.id);
    throw shareError;
  }
  await syncPartyBasketToSilpo(party.id, party.host_id);
  revalidatePath(`/party/${party.code}`);
}

export async function searchSilpoProducts(code: string, query: string): Promise<SilpoProductOption[]> {
  const { party } = await partyForMember(code);
  if (party.status !== "collecting") throw new Error("Подію вже фіналізовано.");
  const cleanedQuery = clean(query, 120);
  if (cleanedQuery.length < 2) throw new Error("Введіть щонайменше 2 символи для пошуку.");
  return findSilpoProducts(party.host_id, cleanedQuery);
}

export async function updateItem(code: string, itemId: string, formData: FormData) {
  const { supabase, party } = await partyForMember(code);
  if (party.status !== "collecting") throw new Error("Подію вже фіналізовано.");
  const name = clean(formData.get("name"), 120);
  const quantity = Number(clean(formData.get("quantity"), 20).replace(",", "."));
  if (!name || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Вкажіть додатну цілу кількість товару.");
  }
  const { data: current, error: currentError } = await supabase
    .from("basket_items")
    .select("name, unit, unit_price_cents, silpo_product_id")
    .eq("id", itemId)
    .eq("party_id", party.id)
    .single();
  if (currentError || !current) throw currentError ?? new Error("Товар не знайдено.");
  const { error } = await supabase.from("basket_items").update({
    name: current.silpo_product_id ? current.name : name,
    quantity,
    updated_at: new Date().toISOString(),
  }).eq("id", itemId).eq("party_id", party.id);
  if (error) throw error;
  revalidatePath(`/party/${party.code}`);
}

export async function deleteItem(code: string, itemId: string) {
  const { supabase, party } = await partyForMember(code);
  if (party.status !== "collecting") throw new Error("Подію вже фіналізовано.");
  const { data: item, error: itemError } = await supabase
    .from("basket_items")
    .select("id, name, quantity, unit, unit_price_cents, silpo_product_id, silpo_company_id, silpo_branch_id")
    .eq("id", itemId)
    .eq("party_id", party.id)
    .single();
  if (itemError || !item) throw itemError ?? new Error("Товар не знайдено.");
  const removed = await removePartyItemFromSilpo(party.id, party.host_id, item);
  if (!removed.ok) throw new Error(removed.error);
  const { error } = await supabase.from("basket_items").delete().eq("id", itemId).eq("party_id", party.id);
  if (error) throw error;
  revalidatePath(`/party/${party.code}`);
}

export async function syncSilpoBasket(code: string) {
  const { user, party } = await partyForMember(code);
  if (party.host_id !== user.id) throw new Error("Лише Організатор може запускати повну синхронізацію.");
  if (party.status !== "collecting") throw new Error("Поверніть подію до редагування перед синхронізацією.");
  await syncPartyBasketToSilpo(party.id, party.host_id);
  revalidatePath(`/party/${party.code}`);
}

export async function finalizeParty(code: string, formData: FormData) {
  const { user, supabase, party } = await partyForMember(code);
  if (party.host_id !== user.id) throw new Error("Лише Організатор може фіналізувати кошик.");
  if (party.status !== "collecting") throw new Error("Кошик уже фіналізовано.");
  const { data: items, error: itemsError } = await supabase
    .from("basket_items")
    .select("id")
    .eq("party_id", party.id);
  if (itemsError) throw itemsError;
  if (!items.length) throw new Error("Додайте хоча б один товар перед фіналізацією.");

  const { data: members, error: membersError } = await supabase
    .from("party_members")
    .select("user_id")
    .eq("party_id", party.id);
  if (membersError) throw membersError;
  const memberIds = new Set(members.map((member) => member.user_id));
  const shareUpdates = items.map((item) => {
    const ownerIds = [...new Set(formData.getAll(`owner_ids:${item.id}`).map(String))];
    if (!ownerIds.length) throw new Error("Оберіть хоча б одного учасника для кожного товару.");
    if (ownerIds.some((ownerId) => !memberIds.has(ownerId))) {
      throw new Error("Вибрано учасника, якого немає в цій події.");
    }
    return { target_item_id: item.id, owner_ids: ownerIds };
  });
  const shareResults = await Promise.all(
    shareUpdates.map((update) => supabase.rpc("set_item_shares", update)),
  );
  const shareError = shareResults.find((result) => result.error)?.error;
  if (shareError) throw shareError;

  const synchronized = await syncPartyBasketToSilpo(party.id, party.host_id);
  if (!synchronized.ok) throw new Error(synchronized.error);
  const { error } = await supabase.from("parties").update({
    status: "finalized",
    finalized_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", party.id);
  if (error) throw error;
  revalidatePath(`/party/${party.code}`);
}

export async function reopenParty(code: string) {
  const { user, supabase, party } = await partyForMember(code);
  if (party.host_id !== user.id) throw new Error("Лише Організатор може відновити редагування.");
  const { error } = await supabase.from("parties").update({
    status: "collecting",
    finalized_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", party.id);
  if (error) throw error;
  revalidatePath(`/party/${party.code}`);
}

export async function runAiMealPlanner(code: string) {
  const workspace = await getPartyWorkspace(code);
  if (workspace.party.host_id !== workspace.user.id) throw new Error("Only the Host may run AI meal planning.");
  if (workspace.party.status !== "collecting") throw new Error("Reopen the party before planning.");
  if (!workspace.party.budget_cents) throw new Error("Set the shared budget first.");
  if (workspace.members.some((member) => !workspace.intents.some((intent) => intent.user_id === member.user_id))) throw new Error("Every participant must submit a dish or explicitly choose ‘I don’t care’.");
  await createMealProposal(workspace);
  revalidatePath(`/party/${workspace.party.code}`);
}

export async function confirmAiProposal(code: string, proposalId: string) {
  const { user, party } = await partyForMember(code);
  await applyMealProposal({ proposalId, party: party as Parameters<typeof applyMealProposal>[0]["party"], actorId: user.id });
  revalidatePath(`/party/${party.code}`);
}

export async function rejectAiProposal(code: string, proposalId: string) {
  const { user, party } = await partyForMember(code);
  await rejectMealProposal({ proposalId, party: party as Parameters<typeof rejectMealProposal>[0]["party"], actorId: user.id });
  revalidatePath(`/party/${party.code}`);
}
