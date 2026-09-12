import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createConfiguredPlanningProvider } from "@/lib/ai/planning/provider";
import { createPlanningFingerprint, shouldBuildMealProposal } from "@/lib/ai/planning/proposal-state";
import { createMealProposal, latestMealProposal } from "@/lib/ai/planning/proposals";
import { runSupervisorDecision } from "./supervisor";
import { canRetryAgentRun } from "./agent-run";
import { claimAgentRun, readAgentRun, updateAgentRun, type AgentRunRecord } from "./agent-runs";
import type { FoodIntent, FoodProfile, Party, PartyMember } from "@/lib/parties";

type AgentWorkspace = {
  party: Party;
  members: PartyMember[];
  profiles: FoodProfile[];
  intents: FoodIntent[];
};

async function loadWorkspace(partyId: string): Promise<AgentWorkspace> {
  const admin = createAdminClient();
  const { data: party, error: partyError } = await admin
    .from("parties")
    .select("id, code, title, host_id, budget_cents, status, finalized_at, silpo_cart_id, silpo_sync_status, silpo_sync_error, silpo_synced_at, silpo_checkout_url, created_at")
    .eq("id", partyId)
    .single();
  if (partyError || !party) throw partyError ?? new Error("Подію не знайдено.");

  const [membersResult, intentsResult] = await Promise.all([
    admin.from("party_members").select("party_id, user_id, role, display_name, email, avatar_url").eq("party_id", partyId).order("joined_at"),
    admin.from("food_intents").select("party_id, user_id, dish_name, description, content_url, indifferent").eq("party_id", partyId),
  ]);
  if (membersResult.error) throw membersResult.error;
  if (intentsResult.error) throw intentsResult.error;

  const members = (membersResult.data ?? []) as PartyMember[];
  const { data: profiles, error: profilesError } = await admin
    .from("profiles")
    .select("id, allergies, dietary_restrictions, dislikes, preferences")
    .in("id", members.map((member) => member.user_id));
  if (profilesError) throw profilesError;

  return {
    party: party as Party,
    members,
    profiles: (profiles ?? []) as FoodProfile[],
    intents: (intentsResult.data ?? []) as FoodIntent[],
  };
}

async function messageForRun(run: AgentRunRecord) {
  const { data, error } = await createAdminClient()
    .from("party_chat_messages")
    .select("content")
    .eq("id", run.input_message_id)
    .single();
  if (error || !data) throw error ?? new Error("Вхідне повідомлення агента не знайдено.");
  return data.content as string;
}

async function writeAssistantMessage(run: AgentRunRecord, content: string) {
  const admin = createAdminClient();
  const { data: existing, error: existingError } = await admin
    .from("party_chat_messages")
    .select("id")
    .eq("agent_run_id", run.id)
    .eq("role", "assistant")
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return;
  const { error } = await admin.from("party_chat_messages").insert({
    party_id: run.party_id,
    participant_id: null,
    agent_run_id: run.id,
    role: "assistant",
    content: content.slice(0, 2_000),
    status: "completed",
  });
  if (error) throw error;
}

async function executeClaimedRun(run: AgentRunRecord) {
  const workspace = await loadWorkspace(run.party_id);
  const message = await messageForRun(run);
  let provider: ReturnType<typeof createConfiguredPlanningProvider> | undefined;
  try {
    provider = createConfiguredPlanningProvider();
  } catch {
    // Deterministic supervisor fallback keeps the queue useful without AI keys.
  }

  await updateAgentRun(run.id, { stage: "supervisor" });
  const latestProposal = await latestMealProposal(workspace.party.id);
  const allIntentsSubmitted = workspace.intents.length === workspace.members.length;
  const decision = await runSupervisorDecision({
    partyState: {
      hasIntent: allIntentsSubmitted,
      hasBudget: workspace.party.budget_cents !== null,
      hasProposal: Boolean(latestProposal),
    },
    message,
    generate: provider?.supervisorModel().generateJsonText,
  });
  const workflowRequested = decision.actions.some((action) => [
    "resolve_recipe",
    "normalize_ingredients",
    "search_products",
    "build_basket",
    "review_constraints",
    "publish_proposal",
  ].includes(action.type));
  const shouldBuild = shouldBuildMealProposal({
    allIntentsSubmitted,
    proposal: latestProposal,
    fingerprint: createPlanningFingerprint(workspace),
  }) && workflowRequested;

  if (shouldBuild) {
    await updateAgentRun(run.id, { stage: "recipe" });
    await updateAgentRun(run.id, { stage: "ingredients" });
    await updateAgentRun(run.id, { stage: "product_search" });
    await updateAgentRun(run.id, { stage: "proposal" });
    await createMealProposal(workspace);
  }

  const assistantContent = shouldBuild
    ? "Оновлюю спільний кошик на основі запитів усіх учасників."
    : allIntentsSubmitted
    ? decision.reply
    : "Запит збережено. Щойно всі учасники додадуть побажання, агент підбере рецепти й товари.";
  await writeAssistantMessage(run, assistantContent);
  await updateAgentRun(run.id, { status: "completed", stage: "done", finished_at: new Date().toISOString() });
}

async function failRun(run: AgentRunRecord, error: unknown) {
  const errorCode = error instanceof Error && /MCP|Silpo/i.test(error.message)
    ? "MCP_OPERATION_FAILED"
    : "AGENT_OPERATION_FAILED";
  if (canRetryAgentRun(run.attempt)) {
    await updateAgentRun(run.id, { status: "queued", error_code: errorCode, finished_at: null });
    return;
  }
  await updateAgentRun(run.id, { status: "failed", error_code: errorCode, finished_at: new Date().toISOString() });
  await writeAssistantMessage(run, "Не вдалося завершити запит агента. Спробуйте ще раз.");
}

export async function runPartyAgentRun(runId?: string) {
  const run = await claimAgentRun(runId);
  if (!run) return null;
  try {
    await executeClaimedRun(run);
  } catch (error) {
    await failRun(run, error);
  }
  return run.id;
}

export async function dispatchPartyAgentRun(runId: string) {
  const dispatcherUrl = process.env.AGENT_DISPATCHER_URL?.trim();
  const workerSecret = process.env.AGENT_WORKER_SECRET?.trim();
  if (!dispatcherUrl || !workerSecret) {
    for (;;) {
      const processed = await runPartyAgentRun(runId);
      if (!processed) return;
      const run = await readAgentRun(runId);
      if (run.status !== "queued") return;
    }
  }
  const dispatcherSecret = process.env.AGENT_DISPATCHER_SECRET?.trim() ?? workerSecret;
  const response = await fetch(dispatcherUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${dispatcherSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) throw new Error(`Agent dispatcher returned ${response.status}.`);
}
