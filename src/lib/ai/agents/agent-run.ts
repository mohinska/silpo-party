export const AgentRunStatuses = ["queued", "running", "completed", "failed"] as const;
export type AgentRunStatus = (typeof AgentRunStatuses)[number];

export const AgentRunStages = [
  "intent",
  "supervisor",
  "recipe",
  "ingredients",
  "product_search",
  "proposal",
  "done",
] as const;
export type AgentRunStage = (typeof AgentRunStages)[number];

export const AgentRunProgress: Record<AgentRunStage, string> = {
  intent: "Розбираю запит",
  supervisor: "Планую наступні дії",
  recipe: "Шукаю рецепт",
  ingredients: "Нормалізую інгредієнти",
  product_search: "Підбираю товари у «Сільпо»",
  proposal: "Оновлюю спільний кошик",
  done: "Готово",
};

export const MaxAgentRunAttempts = 3;

export function canRetryAgentRun(attempt: number) {
  return attempt < MaxAgentRunAttempts;
}

export function nextAgentRunStatus(
  status: AgentRunStatus,
  next: AgentRunStatus,
) {
  const allowed: Record<AgentRunStatus, AgentRunStatus[]> = {
    queued: ["running", "failed"],
    running: ["completed", "failed"],
    completed: [],
    failed: ["queued"],
  };
  if (!allowed[status].includes(next)) {
    throw new Error(`Invalid agent run transition: ${status} → ${next}`);
  }
  return next;
}
