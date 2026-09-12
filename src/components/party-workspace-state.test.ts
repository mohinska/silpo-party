import { describe, expect, it } from "vitest";
import { getPartyChatPresentation, getPartyWorkspaceState } from "./party-workspace-state";

describe("chat-led party workspace", () => {
  it("keeps the basket visible while chat is the primary control surface", () => {
    expect(getPartyChatPresentation({ chatOpen: false, chatFullscreen: false })).toEqual({
      basketVisible: true,
      chatVisible: true,
      actionsInChat: true,
      hideWorkspaceActions: false,
    });
  });

  it("hides workspace actions in mobile full-screen chat mode", () => {
    expect(getPartyChatPresentation({ chatOpen: true, chatFullscreen: true })).toEqual({
      basketVisible: false,
      chatVisible: true,
      actionsInChat: true,
      hideWorkspaceActions: true,
    });
  });
});

describe("party workspace state", () => {
  it("allows the Host to build without a budget once everyone has submitted intent", () => {
    expect(getPartyWorkspaceState({
      partyStatus: "collecting",
      isHost: true,
      memberCount: 3,
      intentCount: 3,
      itemCount: 0,
      budgetCents: null,
      proposalStatus: null,
      syncStatus: "pending",
    }).build).toEqual({ enabled: true, reason: null });
  });

  it("requires a new finalization after returning to editing", () => {
    expect(getPartyWorkspaceState({
      partyStatus: "collecting",
      isHost: true,
      memberCount: 2,
      intentCount: 2,
      itemCount: 4,
      budgetCents: null,
      proposalStatus: "applied",
      syncStatus: "synced",
    }).send).toEqual({ enabled: false, label: "Фіналізуйте кошик" });
  });

  it("does not call a pre-send sync a sent state", () => {
    expect(getPartyWorkspaceState({
      partyStatus: "finalized",
      isHost: true,
      memberCount: 2,
      intentCount: 2,
      itemCount: 4,
      budgetCents: null,
      proposalStatus: "applied",
      syncStatus: "synced",
    }).send).toEqual({ enabled: true, label: "Відправити до «Сільпо»" });
  });
});
