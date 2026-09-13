import { describe, expect, it } from "vitest";
import { agentV2Enabled } from "./agent-version";

describe("party agent version cutover", () => {
  it("uses v2 by default and keeps v1 only as an explicit rollback", () => {
    expect(agentV2Enabled({})).toBe(true);
    expect(agentV2Enabled({ PARTY_AGENT_VERSION: "v2" })).toBe(true);
    expect(agentV2Enabled({ PARTY_AGENT_VERSION: "v1" })).toBe(false);
  });
});
