import "server-only";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPersonalSilpoContext } from "@/lib/silpo/mcp";
import { readSilpoCartSnapshot, resolveSilpoProposalProducts, writeSilpoProposalLines } from "@/lib/silpo/cart";
import type { FoodIntent, FoodProfile, Party, PartyMember } from "@/lib/parties";
import { planEvent } from "./agent";
import { aggregateIngredients, chooseProducts, scaleRecipe } from "./meal-proposal";
import { confirmMealProposal } from "./proposal-lifecycle";
import { MealProposalSchema, type MealProposal, type ProductLine, type Recipe } from "./proposal-schemas";
import { retrieveRecipeForRequest } from "./recipe-retrieval";

function list(value: string) { return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean); }
function key(prefix: string, value: string, index: number) { return `${prefix}:${index}:${value.toLocaleLowerCase("uk-UA")}`.slice(0, 200); }

export function partyPlanningInput(input: { party: Party; members: PartyMember[]; profiles: FoodProfile[]; intents: FoodIntent[] }) {
  const participants = input.members.map((member) => {
    const profile = input.profiles.find(({ id }) => id === member.user_id);
    const intent = input.intents.find(({ user_id }) => user_id === member.user_id);
    const allergies = list(profile?.allergies ?? "");
    const restrictions = list(profile?.dietary_restrictions ?? "");
    const foodIntent = !intent || intent.indifferent ? { kind: "none" as const } : intent.content_url ? { kind: "recipe" as const, recipeUrl: intent.content_url, requestedDishName: intent.dish_name || undefined, notes: intent.description || undefined } : { kind: "dish" as const, dishName: intent.dish_name || intent.description, notes: intent.description || undefined };
    return { id: member.user_id, displayName: member.display_name, preferences: { allergies: allergies.map((label, index) => ({ id: key("allergy", label, index), label })), dietaryRestrictions: restrictions.map((label, index) => ({ id: key("restriction", label, index), label, strength: "hard" as const })), likes: list(profile?.preferences ?? ""), dislikes: list(profile?.dislikes ?? ""), cuisines: [] }, foodIntent, contextCompleteness: "complete" as const };
  });
  return { event: { id: input.party.id, title: input.party.title, startsAt: input.party.created_at, locale: "uk-UA" }, host: { participantId: input.party.host_id, displayName: input.members.find(({ user_id }) => user_id === input.party.host_id)?.display_name ?? "Host" }, budget: { amount: input.party.budget_cents / 100, currency: "UAH" }, participants };
}

export async function createMealProposal(input: { party: Party; members: PartyMember[]; profiles: FoodProfile[]; intents: FoodIntent[] }): Promise<MealProposal> {
  const planningInput = partyPlanningInput(input);
  const { plan } = await planEvent(planningInput, { loadParticipantContext: async (participantId) => {
    const context = await getPersonalSilpoContext(participantId);
    return context ? { status: "available", data: context } : { status: "unavailable", reason: "Silpo is not connected for this participant." };
  }});
  const recipes: Recipe[] = [];
  const unresolved: MealProposal["unresolved"] = [];
  const dishRows: MealProposal["dishes"] = [];
  const rawIngredients: Parameters<typeof aggregateIngredients>[0] = [];
  for (const dish of plan.dishes) {
    if (dish.readyMealQuery) {
      dishRows.push({ id: dish.id, name: dish.name, eaterParticipantIds: dish.eaterParticipantIds, servings: dish.servings, readyMeal: true });
      rawIngredients.push({ dishId: dish.id, name: dish.readyMealQuery, quantity: dish.servings, unit: "piece", variant: "standard", optional: false, readyMeal: true });
      continue;
    }
    const requesterId = dish.requestedByParticipantIds?.[0];
    const requested = planningInput.participants.find(({ id }) => id === requesterId)?.foodIntent;
    const requestedUrl = requested?.kind === "recipe" ? requested.recipeUrl : undefined;
    const details = requested?.kind === "recipe" || requested?.kind === "dish" ? requested.notes : undefined;
    try {
      const scaled = scaleRecipe(await retrieveRecipeForRequest({ dishName: dish.name, requestedUrl, details, targetServings: dish.servings }), dish.servings);
      recipes.push(scaled);
      dishRows.push({ id: dish.id, name: dish.name, eaterParticipantIds: dish.eaterParticipantIds, servings: dish.servings, recipeId: scaled.id, readyMeal: false });
      scaled.ingredients.forEach((ingredient) => rawIngredients.push({ dishId: dish.id, ...ingredient }));
    } catch {
      dishRows.push({ id: dish.id, name: dish.name, eaterParticipantIds: dish.eaterParticipantIds, servings: dish.servings, readyMeal: false });
      unresolved.push({ requirementKey: `recipe:${dish.id}`, reason: `No complete sourced recipe could be retrieved for ${dish.name}.` });
    }
  }
  const mergedIngredients = aggregateIngredients(rawIngredients);
  let selection: { lines: ProductLine[]; totalCents: number; unresolved: MealProposal["unresolved"]; budgetStatus: MealProposal["budgetStatus"]; alternatives: MealProposal["alternatives"] } = { lines: [], totalCents: 0, unresolved: [], budgetStatus: "unresolved", alternatives: [] };
  if (mergedIngredients.length) {
    try { selection = chooseProducts(mergedIngredients, await resolveSilpoProposalProducts(input.party.host_id, mergedIngredients), input.party.budget_cents); }
    catch { unresolved.push({ requirementKey: "silpo-catalog", reason: "Silpo product resolution failed. The Host can retry." }); }
  }
  const allUnresolved = [...unresolved, ...selection.unresolved];
  const id = randomUUID();
  const proposal = MealProposalSchema.parse({ id, partyId: input.party.id, status: "pending", currency: "UAH", budgetCents: input.party.budget_cents, dishes: dishRows, recipes, mergedIngredients, productLines: selection.lines, estimatedTotalCents: selection.totalCents, budgetStatus: allUnresolved.length ? "unresolved" : selection.budgetStatus, alternatives: selection.alternatives, unresolved: allUnresolved, createdAt: new Date().toISOString() });
  const admin = createAdminClient();
  const { error } = await admin.from("ai_meal_proposals").insert({ id, party_id: input.party.id, created_by: input.party.host_id, status: "pending", proposal });
  if (error) throw error;
  return proposal;
}

export async function latestMealProposal(partyId: string): Promise<MealProposal | null> {
  const { data, error } = await createAdminClient().from("ai_meal_proposals").select("proposal, status, error").eq("party_id", partyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? MealProposalSchema.parse({ ...(data.proposal as Record<string, unknown>), status: data.status, error: data.error ?? undefined }) : null;
}

export async function applyMealProposal(input: { proposalId: string; party: Party; actorId: string }) {
  const admin = createAdminClient();
  return confirmMealProposal({ partyId: input.party.id, proposalId: input.proposalId, actorId: input.actorId, hostId: input.party.host_id, confirmed: true }, {
    loadProposal: async (id, partyId) => { const { data, error } = await admin.from("ai_meal_proposals").select("proposal, status, error").eq("id", id).eq("party_id", partyId).single(); if (error || !data) throw error ?? new Error("Proposal not found."); return MealProposalSchema.parse({ ...(data.proposal as Record<string, unknown>), status: data.status, error: data.error ?? undefined }); },
    loadManualLines: async (partyId) => { const { data, error } = await admin.from("basket_items").select("id, name, quantity, silpo_product_id, silpo_company_id, silpo_branch_id").eq("party_id", partyId).eq("source", "manual"); if (error) throw error; return data ?? []; },
    loadAiLines: async (partyId) => { const { data, error } = await admin.from("basket_items").select("name, quantity, silpo_product_id, silpo_company_id, silpo_branch_id").eq("party_id", partyId).eq("source", "ai"); if (error) throw error; return data ?? []; },
    writeCart: async (lines, manual, previousAi) => { await writeSilpoProposalLines(input.party.host_id, lines, manual as Array<{ silpo_product_id?: string | null; silpo_company_id?: string | null; silpo_branch_id?: string | null; quantity?: number | string; name?: string }>, previousAi as Array<{ silpo_product_id?: string | null; silpo_company_id?: string | null; silpo_branch_id?: string | null; quantity?: number | string; name?: string }>); },
    readCart: () => readSilpoCartSnapshot(input.party.host_id),
    replaceAiLines: async (partyId, lines) => { const { error: deleteError } = await admin.from("basket_items").delete().eq("party_id", partyId).eq("source", "ai"); if (deleteError) throw deleteError; if (!lines.length) return; const { error } = await admin.from("basket_items").insert(lines.map((line) => ({ party_id: partyId, name: line.name, quantity: line.packageCount, unit: line.packageUnit, unit_price_cents: line.unitPriceCents, added_by: input.party.host_id, source: "ai", ai_proposal_id: input.proposalId, silpo_product_id: line.productId, silpo_company_id: line.companyId, silpo_branch_id: line.branchId, silpo_sync_status: "synced" }))); if (error) throw error; },
    markProposal: async (id, status, error) => { const { error: updateError } = await admin.from("ai_meal_proposals").update({ status, error: error ?? null, updated_at: new Date().toISOString() }).eq("id", id); if (updateError) throw updateError; },
  });
}

export async function rejectMealProposal(input: { proposalId: string; party: Party; actorId: string }) {
  if (input.actorId !== input.party.host_id) throw new Error("Only the Host may reject a meal proposal.");
  const { error } = await createAdminClient().from("ai_meal_proposals").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", input.proposalId).eq("party_id", input.party.id).in("status", ["pending", "failed"]);
  if (error) throw error;
}
