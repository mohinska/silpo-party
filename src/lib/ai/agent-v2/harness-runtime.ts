import "server-only";

import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage } from "ai";
import { createWorkspace, type Workspace } from "./state";
import { executeAgentV2Slice, type AgentV2Checkpoint, type AgentV2RuntimeDependencies } from "./runtime";

export type HarnessAgentState = {
  partyId: string;
  actorId: string;
  sourceSequence: number;
  workspace: Workspace;
  checkpoint: AgentV2Checkpoint | Record<string, never>;
  messages: ModelMessage[];
};

export type HarnessTrace = {
  step: number;
  status: "queued" | "completed" | "waiting_for_input" | "blocked";
  outcome: string;
  finishReason: string;
  durationMs: number;
  evidenceIds: string[];
};

type HarnessDependencies = AgentV2RuntimeDependencies & { model: LanguageModel | null };

/** Development-only in-memory driver. It deliberately calls the exact runtime
 * used by the durable worker; only persistence and authorization are injected. */
export async function runHarnessAgentTurn(previous: HarnessAgentState | null, message: string, deps: HarnessDependencies) {
  const partyId = previous?.partyId ?? randomUUID();
  const actorId = previous?.actorId ?? randomUUID();
  const eventId = randomUUID();
  const sourceSequence = (previous?.sourceSequence ?? 0) + 1;
  let workspace = previous?.workspace ?? createWorkspace(partyId, [actorId]);
  let checkpoint: unknown = previous?.checkpoint ?? {};
  let messages = previous?.messages ?? [];
  const trace: HarnessTrace[] = [];
  let published = false;
  let finalStatus: HarnessTrace["status"] = "queued";

  for (let step = 1; step <= 20; step += 1) {
    const startedAt = Date.now();
    const result = await executeAgentV2Slice({
      ...deps,
      event: { id: eventId, actorId, kind: "chat", payload: { text: message }, sourceSequence },
      workspace,
      checkpoint,
      messages,
      budgetCents: null,
    });
    workspace = result.workspace;
    checkpoint = result.checkpoint;
    messages = result.messages;
    published ||= result.publish;
    finalStatus = result.status;
    trace.push({
      step,
      status: result.status,
      outcome: result.checkpoint.lastStep?.outcome.status ?? "unknown",
      finishReason: result.checkpoint.lastStep?.finishReason ?? "unknown",
      durationMs: Math.max(0, Date.now() - startedAt),
      evidenceIds: result.checkpoint.lastStep?.evidenceIds ?? [],
    });
    if (published || result.status !== "queued" || result.checkpoint.nextAttemptAt) break;
  }

  const state: HarnessAgentState = {
    partyId,
    actorId,
    sourceSequence,
    workspace,
    checkpoint: checkpoint as AgentV2Checkpoint,
    messages,
  };
  const reply = published
    ? "Чернетку розраховано й опубліковано тим самим Agent v2 runtime."
    : finalStatus === "waiting_for_input"
      ? "Агент очікує приватну відповідь учасника."
      : finalStatus === "blocked"
        ? "Агент зупинився з явним blocked-результатом; дивись останній trace."
        : "Крок збережено; наступна спроба відкладена."
  return { state, trace, reply };
}
