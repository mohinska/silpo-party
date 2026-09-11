"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { DebugCodeSchema, DebugBudgetSchema } from "./form-schemas";

const PartyFormSchema = z.object({ code: DebugCodeSchema });
const PreinstalledDebugPartyCode = "AIDEBUG1";

/**
 * The party runtime includes MCP and provider adapters. Keep that dependency
 * graph out of the page-render path: a server action needs it only after a
 * user submits a form, not while React serializes the action reference.
 */
async function application() {
  const { createDebugPartyApplication } = await import("@/lib/ai/debug-party/application");
  return createDebugPartyApplication();
}

export async function joinPreinstalledDebugParty() {
  const user = await requireUser();
  const code = await (await application()).joinParty(PreinstalledDebugPartyCode, user.id);
  redirect(`/ai-debug/party/${code}`);
}

export async function joinDebugParty(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  const joinedCode = await (await application()).joinParty(code, user.id);
  redirect(`/ai-debug/party/${joinedCode}`);
}

export async function saveDebugBudget(formData: FormData) {
  const user = await requireUser();
  const { code, budget } = PartyFormSchema.extend({ budget: DebugBudgetSchema }).parse(Object.fromEntries(formData));
  await (await application()).saveBudget(code, user.id, budget);
  revalidatePath(`/ai-debug/party/${code}`);
}

export async function sendDebugMessage(formData: FormData) {
  const user = await requireUser();
  const { code, content } = PartyFormSchema.extend({ content: z.string().trim().min(1).max(2000) }).parse(Object.fromEntries(formData));
  const result = await (await application()).sendMessage(code, user.id, content);
  revalidatePath(`/ai-debug/party/${code}`);
  return result;
}

export async function buildDebugBasket(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  const result = await (await application()).buildBasket(code, user.id);
  revalidatePath(`/ai-debug/party/${code}`);
  return result;
}

export async function finalizeDebugParty(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  await (await application()).finalizeParty(code, user.id);
  revalidatePath(`/ai-debug/party/${code}`);
}

export async function clearDebugParty(formData: FormData) {
  const user = await requireUser();
  const { code } = PartyFormSchema.parse(Object.fromEntries(formData));
  await (await application()).clearParty(code, user.id);
  revalidatePath(`/ai-debug/party/${code}`);
}

export async function sendDebugCartToSilpo(formData: FormData) {
  const user = await requireUser();
  const { code, confirmChanges } = PartyFormSchema.extend({
    confirmChanges: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
  }).parse(Object.fromEntries(formData));
  const result = await (await application()).sendCart(code, user.id, confirmChanges);
  revalidatePath(`/ai-debug/party/${code}`);
  return result;
}
