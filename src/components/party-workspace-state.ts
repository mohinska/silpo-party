export type WorkspaceStateInput = {
  partyStatus: "collecting" | "finalized";
  isHost: boolean;
  memberCount: number;
  intentCount: number;
  itemCount: number;
  budgetCents: number | null;
  proposalStatus: "pending" | "rejected" | "applying" | "applied" | "failed" | null;
  syncStatus: "pending" | "synced" | "error";
};

export function getPartyChatPresentation(input: { chatOpen: boolean; chatFullscreen: boolean }) {
  return {
    basketVisible: !input.chatFullscreen,
    chatVisible: true,
    actionsInChat: true,
    hideWorkspaceActions: input.chatOpen && input.chatFullscreen,
  };
}

export function getPartyWorkspaceState(input: WorkspaceStateInput) {
  const everyoneReady = input.memberCount > 0 && input.intentCount >= input.memberCount;
  const build = input.partyStatus !== "collecting" || !input.isHost
    ? { enabled: false, reason: "Лише Організатор може зібрати кошик." }
    : input.proposalStatus === "pending" || input.proposalStatus === "applying"
      ? { enabled: false, reason: "Агент уже працює над кошиком." }
      : !everyoneReady
        ? { enabled: false, reason: "Дочекайтеся побажань усіх учасників." }
        : { enabled: true, reason: null };
  const send = input.partyStatus !== "finalized" || !input.isHost
    ? { enabled: false, label: input.partyStatus === "finalized" ? "Лише Організатор" : "Фіналізуйте кошик" }
    : input.syncStatus === "error"
      ? { enabled: true, label: "Спробувати ще раз" }
      : { enabled: true, label: "Відправити до «Сільпо»" };
  return { everyoneReady, build, send };
}
