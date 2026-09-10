import { describe, expect, it } from "vitest";
import { deriveSendUi, deriveWorkspaceUi, type WorkspaceUiInput } from "./ui-state";

const active: WorkspaceUiInput = {
  partyStatus: "collecting", role: "host", contextStatus: "pending",
  hasCartItems: false, cartStale: false, hasSubmittedIntents: false,
  contextsReady: false, runStatus: null, sendStatus: null,
};

describe("workspace controls", () => {
  it("lets the first chat message start preparation without an intake gate", () => {
    const ui = deriveWorkspaceUi(active);
    expect(ui.chatDisabled).toBe(false);
    expect(ui.contextLabel).toBe("Очікує повідомлення");
    expect(ui.buildDisabled).toBe(true);
    expect(ui.shouldPoll).toBe(true);
  });

  it.each([
    ["running", "Готуємо контекст", true],
    ["failed", "Потрібна повторна спроба", false],
    ["ready", "Контекст готовий", false],
  ] as const)("maps %s context and preserves retry access", (contextStatus, contextLabel, chatDisabled) => {
    expect(deriveWorkspaceUi({ ...active, contextStatus })).toMatchObject({ contextLabel, chatDisabled });
  });

  it.each(["queued", "running"] as const)("prevents competing actions while a turn is %s", (runStatus) => {
    expect(deriveWorkspaceUi({ ...active, runStatus, hasCartItems: true, contextsReady: true, hasSubmittedIntents: true }))
      .toMatchObject({ chatDisabled: true, buildDisabled: true, finalizeDisabled: true, shouldPoll: true });
  });

  it("allows an optional host rebuild once submitted contexts are ready", () => {
    expect(deriveWorkspaceUi({ ...active, hasSubmittedIntents: true, contextsReady: true, hasCartItems: true }))
      .toMatchObject({ buildDisabled: false, finalizeDisabled: false });
  });

  it("blocks finalization of a stale basket while allowing rebuild", () => {
    expect(deriveWorkspaceUi({ ...active, hasSubmittedIntents: true, contextsReady: true, hasCartItems: true, cartStale: true }))
      .toMatchObject({ buildDisabled: false, finalizeDisabled: true, cartLabel: "Потребує оновлення" });
  });

  it("makes final baskets read only and enables host send", () => {
    expect(deriveWorkspaceUi({ ...active, partyStatus: "finalized", hasCartItems: true }))
      .toMatchObject({ chatDisabled: true, buildDisabled: true, finalizeDisabled: true, sendDisabled: false, shouldPoll: false, cartLabel: "Фінальний кошик" });
  });

  it("requires explicit confirmation after changed prices or availability", () => {
    expect(deriveWorkspaceUi({ ...active, partyStatus: "finalized", sendStatus: "confirmation_required" }))
      .toMatchObject({ sendLabel: "Підтвердити зміни й надіслати", sendDisabled: false });
  });

  it("allows a partial send retry and disables a completed send", () => {
    expect(deriveWorkspaceUi({ ...active, partyStatus: "finalized", sendStatus: "partial" }))
      .toMatchObject({ sendLabel: "Повторити надсилання", sendDisabled: false });
    expect(deriveWorkspaceUi({ ...active, partyStatus: "sent", sendStatus: "completed" }))
      .toMatchObject({ sendLabel: "Надіслано до Сільпо", sendDisabled: true, shouldPoll: false });
  });

  it("keeps host-only actions unavailable for participants", () => {
    expect(deriveWorkspaceUi({ ...active, role: "member", hasSubmittedIntents: true, contextsReady: true, hasCartItems: true }))
      .toMatchObject({ chatDisabled: false, buildDisabled: true, finalizeDisabled: true, sendDisabled: true });
  });

  it("revalidates persisted confirmation before asking the host to confirm unseen changes", () => {
    expect(deriveSendUi({ partyStatus: "finalized", role: "host", sendStatus: "confirmation_required", changesVisible: false }))
      .toMatchObject({ label: "Перевірити зміни", confirmChanges: false, disabled: false });
    expect(deriveSendUi({ partyStatus: "finalized", role: "host", sendStatus: "confirmation_required", changesVisible: true }))
      .toMatchObject({ label: "Підтвердити зміни й надіслати", confirmChanges: true });
  });
});
