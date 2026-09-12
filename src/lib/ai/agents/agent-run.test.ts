import { describe, expect, it } from "vitest";

import {
  AgentRunProgress,
  MaxAgentRunAttempts,
  canRetryAgentRun,
  nextAgentRunStatus,
} from "./agent-run";

describe("agent run state", () => {
  it("allows the initial run and two retries only", () => {
    expect(canRetryAgentRun(1)).toBe(true);
    expect(canRetryAgentRun(2)).toBe(true);
    expect(canRetryAgentRun(MaxAgentRunAttempts)).toBe(false);
  });

  it("rejects terminal state transitions", () => {
    expect(() => nextAgentRunStatus("completed", "running")).toThrow("Invalid agent run transition");
  });

  it("provides safe Ukrainian progress copy for every stage", () => {
    expect(AgentRunProgress.product_search).toContain("товари");
    expect(Object.keys(AgentRunProgress)).toHaveLength(7);
  });
});
