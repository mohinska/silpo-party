import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
vi.mock("server-only", () => ({}));
import { runHarnessAgentTurn } from "./harness-runtime";

const response = (toolName: string, input: Record<string, unknown>) => ({
  content: [{ type: "tool-call" as const, toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  warnings: [],
});

describe("agent v2 local harness", () => {
  it("runs the same one-step runtime repeatedly and exposes checkpoint outcomes", async () => {
    const outputs = [
      response("edit_request", { edit: { kind: "add", requestId: "r1", text: "Rice", requestKind: "product" } }),
      response("calculate_validate_draft", {}),
      response("publish_draft", {}),
    ];
    const model = new MockLanguageModelV4({ doGenerate: async () => outputs.shift()! });
    const result = await runHarnessAgentTurn(null, "Add rice", { model });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(result.state.workspace.requests).toMatchObject([{ id: "r1", text: "Rice" }]);
    expect(result.state.workspace.draftRevision).toBe(1);
    expect(result.trace.map(item => item.outcome)).toEqual(["completed", "completed", "completed"]);
    expect(result.trace.at(-1)?.status).toBe("completed");
    expect(result.reply).toMatch(/чернетк/i);
  });
});
