import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
vi.mock("server-only", () => ({}));
import { createWorkspace } from "./state";
import { executeAgentV2Slice } from "./runtime";

const partyId = "10000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000001";

const toolResult = (toolName: string, input: Record<string, unknown>) => ({
  content: [{ type: "tool-call" as const, toolCallId: "call-1", toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } },
  warnings: [],
  providerMetadata: { mock: { request: "native" } },
});

describe("durable v2 ToolLoopAgent slice", () => {
  it("persists one native tool roundtrip with SDK messages and metadata", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolResult("edit_request", {
      edit: { kind: "add", requestId: "r1", text: "Rice", requestKind: "product" },
    }) });
    const result = await executeAgentV2Slice({
      model,
      event: { id: "event-1", actorId, kind: "chat", payload: { text: "Please add rice" }, sourceSequence: 1 },
      workspace: createWorkspace(partyId, [actorId]),
      checkpoint: {},
      messages: [],
      budgetCents: null,
    });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.workspace.requests).toMatchObject([{ id: "r1", participantId: actorId }]);
    expect(result.messages).toHaveLength(3);
    expect(result.checkpoint.lastStep).toMatchObject({ usage: { totalTokens: 18 }, providerMetadata: { mock: { request: "native" } } });
    expect(JSON.stringify(model.doGenerateCalls[0].tools)).toContain("edit_request");
    expect(result.status).toBe("queued");
    expect(result.eventProcessed).toBe(false);
  });

  it("advances a source only through an explicit completion tool", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolResult("complete_event", {}) });
    const result = await executeAgentV2Slice({ model, event: { id: "event-1", actorId, kind: "chat", payload: { text: "Thanks" }, sourceSequence: 1 }, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null });
    expect(result).toMatchObject({ status: "completed", eventProcessed: true });
  });

  it("applies a typed request source once before model planning", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolResult("complete_event", {}) });
    const event = {
      id: "event-typed",
      actorId,
      kind: "request_edit" as const,
      payload: { edit: { kind: "upsert", requestId: "participant-primary", text: "Rice", requestKind: "product" } },
      sourceSequence: 1,
    };
    const first = await executeAgentV2Slice({ model, event, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null });
    expect(first.workspace.requests).toMatchObject([{ id: "participant-primary", participantId: actorId, text: "Rice" }]);
    expect(first.checkpoint.appliedEventIds).toEqual(["event-typed"]);

    const secondModel = new MockLanguageModelV4({ doGenerate: toolResult("complete_event", {}) });
    const second = await executeAgentV2Slice({ model: secondModel, event, workspace: first.workspace, checkpoint: first.checkpoint, messages: first.messages, budgetCents: null });
    expect(second.workspace.requests).toHaveLength(1);
    expect(second.workspace.inputRevision).toBe(1);
  });

  it("refreshes the exact participant context source once before model planning", async () => {
    const loadContext = vi.fn(async () => ({
      source: "profile" as const,
      version: 1,
      status: "success" as const,
      rules: [{ id: "rule-1", kind: "semantic" as const, value: "vegan", source: "profile", evidenceRef: "profile-rule-1" }],
      favorites: [],
      evidenceRefs: ["profile-rule-1"],
    }));
    const model = new MockLanguageModelV4({ doGenerate: toolResult("complete_event", {}) });
    const event = { id: "event-context", actorId, kind: "context_refresh" as const, payload: { participantId: actorId, source: "profile" }, sourceSequence: 1 };
    const first = await executeAgentV2Slice({ model, event, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null, loadContext });
    expect(first.workspace.participants[actorId].contexts.profile).toMatchObject({ status: "success", version: 1 });
    expect(loadContext).toHaveBeenCalledTimes(1);

    const secondModel = new MockLanguageModelV4({ doGenerate: toolResult("complete_event", {}) });
    await executeAgentV2Slice({ model: secondModel, event, workspace: first.workspace, checkpoint: first.checkpoint, messages: first.messages, budgetCents: null, loadContext });
    expect(loadContext).toHaveBeenCalledTimes(1);
  });

  it("rejects and rolls back multiple tool calls in one durable step", async () => {
    const model = new MockLanguageModelV4({ doGenerate: {
      ...toolResult("edit_request", { edit: { kind: "add", requestId: "r1", text: "Rice", requestKind: "product" } }),
      content: [
        { type: "tool-call" as const, toolCallId: "call-1", toolName: "edit_request", input: JSON.stringify({ edit: { kind: "add", requestId: "r1", text: "Rice", requestKind: "product" } }) },
        { type: "tool-call" as const, toolCallId: "call-2", toolName: "complete_event", input: "{}" },
      ],
    } });
    const result = await executeAgentV2Slice({ model, event: { id: "event-1", actorId, kind: "chat", payload: { text: "Rice" }, sourceSequence: 1 }, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null });
    expect(result.workspace.requests).toEqual([]);
    expect(result.eventProcessed).toBe(false);
    expect(result.checkpoint.lastStep?.outcome).toMatchObject({ status: "blocked", code: "contract" });
  });

  it("blocks a missing model instead of synthesizing success", async () => {
    const result = await executeAgentV2Slice({
      model: null,
      event: { id: "event-1", actorId, kind: "chat", payload: { text: "Hello" }, sourceSequence: 1 },
      workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null,
    });
    expect(result.status).toBe("blocked");
    expect(result.checkpoint.lastStep?.outcome).toMatchObject({ status: "blocked", code: "unavailable" });
  });

  it("bounds missing-model retries and stops scheduling after the third attempt", async () => {
    let checkpoint: unknown = {};
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await executeAgentV2Slice({
        model: null,
        event: { id: "event-1", actorId, kind: "chat", payload: { text: "Hello" }, sourceSequence: 1 },
        workspace: createWorkspace(partyId, [actorId]),
        checkpoint,
        messages: [],
        budgetCents: null,
        now: () => new Date("2026-09-13T12:00:00.000Z"),
      });
      checkpoint = result.checkpoint;
      expect(result.checkpoint.transientAttempts.model).toBe(attempt);
      expect(result.checkpoint.nextAttemptAt === null).toBe(attempt === 3);
    }
  });

  it("returns the exact targeted private question for atomic worker persistence", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolResult("ask_targeted_question", { recipientId: actorId, taskId: "diet", question: "Do you eat dairy?" }) });
    const result = await executeAgentV2Slice({ model, event: { id: "event-1", actorId, kind: "chat", payload: { text: "Help" }, sourceSequence: 1 }, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null });
    expect(result.status).toBe("waiting_for_input");
    expect(result.question).toMatchObject({ recipientId: actorId, content: "Do you eat dairy?" });
    expect(result.checkpoint.openQuestions[0]).toMatchObject({ recipientId: actorId, taskId: "diet" });
  });

  it("blocks after two persisted no-progress steps", async () => {
    const textOnly = () => new MockLanguageModelV4({ doGenerate: {
      content: [{ type: "text", text: "I will think about it." }],
      finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
    } });
    const initial = { event: { id: "event-1", actorId, kind: "chat" as const, payload: { text: "Hello" }, sourceSequence: 1 }, workspace: createWorkspace(partyId, [actorId]), messages: [], budgetCents: null };
    const first = await executeAgentV2Slice({ ...initial, model: textOnly(), checkpoint: {} });
    const second = await executeAgentV2Slice({ ...initial, model: textOnly(), checkpoint: first.checkpoint, messages: first.messages });
    expect(second.checkpoint.noProgressSteps).toBe(2);
    expect(second.status).toBe("blocked");
    expect(second.checkpoint.lastStep?.outcome).toMatchObject({ status: "blocked", code: "no_progress" });
  });

  it("does not call a model for a twenty-first logical step", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolResult("edit_request", { edit: { kind: "add", requestId: "r1", text: "Rice", requestKind: "product" } }) });
    const initial = await executeAgentV2Slice({ model: null, event: { id: "event-1", actorId, kind: "chat", payload: { text: "Hello" }, sourceSequence: 1 }, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null });
    const result = await executeAgentV2Slice({ model, event: { id: "event-1", actorId, kind: "chat", payload: { text: "Hello" }, sourceSequence: 1 }, workspace: initial.workspace, checkpoint: { ...initial.checkpoint, modelSteps: 20 }, messages: [], budgetCents: null });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result.checkpoint.lastStep?.outcome).toMatchObject({ status: "blocked", code: "limit" });
  });

  it("starts a fresh bounded logical run for a new source event", async () => {
    const firstModel = new MockLanguageModelV4({ doGenerate: toolResult("edit_request", { edit: { kind: "add", requestId: "r1", text: "Rice", requestKind: "product" } }) });
    const first = await executeAgentV2Slice({ model: firstModel, event: { id: "event-1", actorId, kind: "chat", payload: { text: "Rice" }, sourceSequence: 1 }, workspace: createWorkspace(partyId, [actorId]), checkpoint: {}, messages: [], budgetCents: null });
    const secondModel = new MockLanguageModelV4({ doGenerate: toolResult("edit_request", { edit: { kind: "add", requestId: "r2", text: "Milk", requestKind: "product" } }) });
    const second = await executeAgentV2Slice({ model: secondModel, event: { id: "event-2", actorId, kind: "chat", payload: { text: "Milk" }, sourceSequence: 2 }, workspace: first.workspace, checkpoint: { ...first.checkpoint, modelSteps: 20 }, messages: first.messages, budgetCents: null });
    expect(second.checkpoint.logicalRunId).not.toBe(first.checkpoint.logicalRunId);
    expect(second.checkpoint.modelSteps).toBe(1);
    expect(second.workspace.requests.map(item => item.id)).toEqual(["r1", "r2"]);
    expect(JSON.stringify(secondModel.doGenerateCalls[0].prompt)).toContain("Milk");
  });
});
