import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createParty: vi.fn(), joinParty: vi.fn(), saveBudget: vi.fn(),
  sendMessage: vi.fn(), buildBasket: vi.fn(), finalizeParty: vi.fn(), sendCart: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: dependencies.requireUser }));
vi.mock("@/lib/ai/planning/debug", () => ({}));
vi.mock("@/lib/ai/planning", () => ({}));
vi.mock("@/lib/silpo/mcp", () => ({}));
vi.mock("@/lib/ai/debug-party/application", () => ({ createDebugPartyApplication: async () => dependencies }));
vi.mock("next/cache", () => ({ revalidatePath: dependencies.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));

import * as actions from "./actions";

function form(fields: Record<string, string>) {
  const data = new FormData();
  Object.entries(fields).forEach(([name, value]) => data.set(name, value));
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  dependencies.requireUser.mockResolvedValue({ id: "session-user" });
  dependencies.createParty.mockResolvedValue("AB12CD34");
  dependencies.joinParty.mockResolvedValue("AB12CD34");
});

describe("debug party actions", () => {
  it("creates a persistent invite with an unset optional budget", async () => {
    await expect(actions.createDebugParty(form({ budget: " " }))).rejects.toThrow("redirect:/ai-debug/party/AB12CD34");
    expect(dependencies.createParty).toHaveBeenCalledWith("session-user", null);
  });

  it("normalizes an eight-character invite without losing it in the redirect", async () => {
    await expect(actions.joinDebugParty(form({ code: " ab12cd34 " }))).rejects.toThrow("redirect:/ai-debug/party/AB12CD34");
    expect(dependencies.joinParty).toHaveBeenCalledWith("AB12CD34", "session-user");
  });

  it.each(["short", "ABCDEFGHI", "AB12/CD3"])("rejects invalid invite %s before joining", async (code) => {
    await expect(actions.joinDebugParty(form({ code }))).rejects.toThrow();
    expect(dependencies.joinParty).not.toHaveBeenCalled();
  });

  it("converts a decimal hryvnia budget into exact integer cents", async () => {
    await actions.saveDebugBudget(form({ code: "AB12CD34", budget: "1250.50" }));
    expect(dependencies.saveBudget).toHaveBeenCalledWith("AB12CD34", "session-user", 125050);
  });

  it.each(["-1", "1.001", "Infinity", "12abc"])("rejects invalid budget %s", async (budget) => {
    await expect(actions.createDebugParty(form({ budget }))).rejects.toThrow();
    expect(dependencies.createParty).not.toHaveBeenCalled();
  });

  it("sends trimmed chat as the authenticated user and refreshes the workspace", async () => {
    await actions.sendDebugMessage(form({ code: "ab12cd34", content: "  Хочу піцу без грибів  ", actorId: "forged" }));
    expect(dependencies.sendMessage).toHaveBeenCalledWith("AB12CD34", "session-user", "Хочу піцу без грибів");
    expect(dependencies.revalidatePath).toHaveBeenCalledWith("/ai-debug/party/AB12CD34");
  });

  it.each(["", " ", "x".repeat(2001)])("rejects empty or oversized chat", async (content) => {
    await expect(actions.sendDebugMessage(form({ code: "AB12CD34", content }))).rejects.toThrow();
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
  });

  it("requires authentication before parsing or invoking services", async () => {
    dependencies.requireUser.mockRejectedValue(new Error("unauthorized"));
    await expect(actions.sendDebugMessage(form({}))).rejects.toThrow("unauthorized");
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
  });

  it("does not swallow Host authorization failure or refresh a rejected mutation", async () => {
    dependencies.buildBasket.mockRejectedValue(new Error("Host required"));
    await expect(actions.buildDebugBasket(form({ code: "AB12CD34" }))).rejects.toThrow("Host required");
    expect(dependencies.revalidatePath).not.toHaveBeenCalled();
  });

  it("requires an explicit confirmation field before accepting changed Silpo prices", async () => {
    dependencies.sendCart.mockResolvedValue({ status: "confirmation_required", changes: [] });
    await actions.sendDebugCartToSilpo(form({ code: "AB12CD34" }));
    expect(dependencies.sendCart).toHaveBeenCalledWith("AB12CD34", "session-user", false);
    await actions.sendDebugCartToSilpo(form({ code: "AB12CD34", confirmChanges: "true" }));
    expect(dependencies.sendCart).toHaveBeenLastCalledWith("AB12CD34", "session-user", true);
  });
});
