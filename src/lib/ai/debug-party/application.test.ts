import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./supervisor", () => ({ runDebugPartySupervisor: vi.fn() }));
vi.mock("./send-to-silpo", () => ({ sendFrozenDebugCart: vi.fn(), createSilpoFrozenCartAdapter: vi.fn() }));
import { assembleDebugPartyApplication } from "./application";
import type { DebugPartyRepository, DebugPartyWorkspace } from "./repository";
import type { runDebugPartySupervisor } from "./supervisor";

function setup(actor = "host") {
  const state = { party: { id: "party", code: "AB12CD34", hostId: "host", status: "collecting" },
    member: { participantId: actor, role: actor === "host" ? "host" : "member" },
    chatMessages: [] } as unknown as DebugPartyWorkspace;
  const events: string[] = [];
  const repository = {
    loadWorkspace: async () => state,
    createParty: async () => { events.push("create"); return "AB12CD34"; },
    saveBudget: async (_code: string, _actor: string, cents: number | null) => { events.push(`budget:${cents}`); },
    appendChatMessage: async (_code: string, actorId: string, content: string) => {
      events.push(`message:${actorId}:${content}`);
      return { id: "message", partyId: "party", participantId: actorId, content, role: "user" };
    },
    finalizeParty: async () => { events.push("finalize"); return "snapshot"; },
    persistAssistantReply: async () => { events.push("reply"); },
  } as unknown as DebugPartyRepository;
  const supervise = vi.fn<typeof runDebugPartySupervisor>(async () => { events.push("supervise"); return { runId: "run", reply: "Готово", status: "completed" as const }; });
  const send = vi.fn(async () => { events.push("send"); return { status: "completed" as const, lineResults: [], idempotent: false }; });
  return { application: assembleDebugPartyApplication({ repository, supervise, send }), events, supervise, send };
}

describe("debug party application", () => {
  it("creates a stable party before applying an optional Host budget", async () => {
    const { application, events } = setup();
    expect(await application.createParty("host", 10050)).toBe("AB12CD34");
    expect(events).toEqual(["create", "budget:10050"]);
  });

  it("persists the user's first message before starting the chat supervisor", async () => {
    const { application, events, supervise } = setup("guest");
    await application.sendMessage("AB12CD34", "guest", "Хочу піцу");
    expect(events).toEqual(["message:guest:Хочу піцу", "supervise", "reply"]);
    expect(supervise.mock.calls[0]?.[0]).toEqual({ mode: "chat", partyId: "party", actorId: "guest", messageId: "message" });
  });

  it.each(["buildBasket", "finalizeParty", "sendCart"] as const)("rejects guest %s before starting privileged work", async (method) => {
    const { application, events } = setup("guest");
    await expect(application[method]("AB12CD34", "guest", false)).rejects.toThrow(/Host/);
    expect(events).toEqual([]);
  });
});
