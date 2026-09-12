import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  AgentRunProgress,
  type AgentRunStage,
  type AgentRunStatus,
} from "./agent-run";

export type AgentRunRecord = {
  id: string;
  party_id: string;
  input_message_id: string;
  status: AgentRunStatus;
  stage: AgentRunStage;
  progress_message: string;
  attempt: number;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function createAgentRun(input: {
  partyId: string;
  inputMessageId: string;
}) {
  const { data, error } = await createAdminClient()
    .from("agent_runs")
    .insert({
      party_id: input.partyId,
      input_message_id: input.inputMessageId,
      progress_message: "Запит у черзі",
    })
    .select("*")
    .single();
  if (error || !data) throw error ?? new Error("Не вдалося поставити запит у чергу.");
  return data as AgentRunRecord;
}

export async function linkAgentRunToMessage(runId: string, messageId: string) {
  const { error } = await createAdminClient()
    .from("party_chat_messages")
    .update({ agent_run_id: runId })
    .eq("id", messageId);
  if (error) throw error;
}

export async function claimAgentRun(runId?: string) {
  const { data, error } = await createAdminClient()
    .rpc("claim_next_agent_run", { target_run_id: runId ?? null })
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRunRecord | null) ?? null;
}

export async function updateAgentRun(
  runId: string,
  patch: Partial<Pick<AgentRunRecord, "status" | "stage" | "progress_message" | "error_code" | "finished_at">>,
) {
  const stage = patch.stage;
  const values = {
    ...patch,
    ...(stage ? { progress_message: AgentRunProgress[stage] } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await createAdminClient()
    .from("agent_runs")
    .update(values)
    .eq("id", runId);
  if (error) throw error;
}

export async function readAgentRun(runId: string) {
  const { data, error } = await createAdminClient()
    .from("agent_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (error || !data) throw error ?? new Error("Agent run не знайдено.");
  return data as AgentRunRecord;
}

export async function latestActiveAgentRun(partyId: string) {
  const { data, error } = await createAdminClient()
    .from("agent_runs")
    .select("*")
    .eq("party_id", partyId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentRunRecord | null) ?? null;
}
