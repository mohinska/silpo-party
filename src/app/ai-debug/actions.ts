"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createDebugPartyApplication } from "@/lib/ai/debug-party/application";
import { DebugCodeSchema, DebugBudgetSchema } from "./form-schemas";

const PartyFormSchema = z.object({ code: DebugCodeSchema });

export async function createDebugParty(formData: FormData) {
  const user = await requireUser();
  const budgetCents = DebugBudgetSchema.parse(formData.get("budget"));
  const code = await (await createDebugPartyApplication()).createParty(user.id, budgetCents);
  redirect(`/ai-debug/party/${code}`);
}

export async function joinDebugParty(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  const joinedCode = await (await createDebugPartyApplication()).joinParty(code, user.id);
  redirect(`/ai-debug/party/${joinedCode}`);
}

export async function saveDebugBudget(formData: FormData) {
  const user = await requireUser();
  const { code, budget } = PartyFormSchema.extend({ budget: DebugBudgetSchema }).parse(Object.fromEntries(formData));
  await (await createDebugPartyApplication()).saveBudget(code, user.id, budget);
  revalidatePath(`/ai-debug/party/${code}`);
}

export async function sendDebugMessage(formData: FormData) {
  const user = await requireUser();
  const { code, content } = PartyFormSchema.extend({ content: z.string().trim().min(1).max(2000) }).parse(Object.fromEntries(formData));
  const result = await (await createDebugPartyApplication()).sendMessage(code, user.id, content);
  revalidatePath(`/ai-debug/party/${code}`);
  return result;
}

export async function buildDebugBasket(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  const result = await (await createDebugPartyApplication()).buildBasket(code, user.id);
  revalidatePath(`/ai-debug/party/${code}`);
  return result;
}

export async function finalizeDebugParty(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  await (await createDebugPartyApplication()).finalizeParty(code, user.id);
  revalidatePath(`/ai-debug/party/${code}`);
}

export async function sendDebugCartToSilpo(formData: FormData) {
  const user = await requireUser();
  const { code, confirmChanges } = PartyFormSchema.extend({
    confirmChanges: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
  }).parse(Object.fromEntries(formData));
  const result = await (await createDebugPartyApplication()).sendCart(code, user.id, confirmChanges);
  revalidatePath(`/ai-debug/party/${code}`);
  return result;
}
