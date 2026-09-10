import type { DebugContextStatus, DebugPartyStatus } from "./schemas";

export type WorkspaceUiInput = {
  partyStatus: DebugPartyStatus;
  role: "host" | "member";
  contextStatus: DebugContextStatus;
  hasCartItems: boolean;
  cartStale: boolean;
  hasSubmittedIntents: boolean;
  contextsReady: boolean;
  runStatus: "queued" | "running" | "completed" | "failed" | null;
  sendStatus: "pending" | "running" | "confirmation_required" | "partial" | "completed" | "failed" | null;
};

export const contextLabels: Record<DebugContextStatus, string> = {
  pending: "Очікує повідомлення",
  running: "Готуємо контекст",
  ready: "Контекст готовий",
  failed: "Потрібна повторна спроба",
};

export function deriveSendUi(input: Pick<WorkspaceUiInput, "partyStatus" | "role" | "sendStatus"> & { changesVisible: boolean }) {
  const sent = input.partyStatus === "sent" || input.sendStatus === "completed";
  const frozen = input.partyStatus === "finalized" || sent;
  const confirmChanges = input.sendStatus === "confirmation_required" && input.changesVisible;
  return {
    sent, confirmChanges,
    disabled: input.role !== "host" || !frozen || sent || input.sendStatus === "running",
    label: sent ? "Надіслано до Сільпо"
      : input.sendStatus === "confirmation_required" ? confirmChanges ? "Підтвердити зміни й надіслати" : "Перевірити зміни"
      : input.sendStatus === "partial" || input.sendStatus === "failed" ? "Повторити надсилання" : "Надіслати до Сільпо",
  };
}

export function deriveWorkspaceUi(input: WorkspaceUiInput) {
  const sent = input.partyStatus === "sent" || input.sendStatus === "completed";
  const frozen = input.partyStatus === "finalized" || sent;
  const busy = input.partyStatus === "running" || input.runStatus === "queued" || input.runStatus === "running" || input.contextStatus === "running";
  const host = input.role === "host";
  const send = deriveSendUi({ ...input, changesVisible: true });
  return {
    contextLabel: contextLabels[input.contextStatus],
    chatDisabled: frozen || busy,
    buildDisabled: !host || frozen || busy || !input.hasSubmittedIntents || !input.contextsReady,
    finalizeDisabled: !host || frozen || busy || !input.hasCartItems || input.cartStale || !input.contextsReady,
    sendDisabled: send.disabled,
    sendLabel: send.label,
    cartLabel: sent ? "Надіслано до Сільпо" : frozen ? "Фінальний кошик"
      : input.cartStale ? "Потребує оновлення" : "Спільний кошик",
    shouldPoll: !frozen,
    frozen,
    busy,
  };
}
