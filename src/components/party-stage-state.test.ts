import { describe, expect, it } from "vitest";

import { selectPartyStage } from "./party-stage-state";

describe("selectPartyStage", () => {
  it("lets participants move freely forward and backward between party stages", () => {
    expect(selectPartyStage("guests", "shopping")).toBe("shopping");
    expect(selectPartyStage("shopping", "preferences")).toBe("preferences");
  });

  it("keeps the current stage when a requested stage is unknown", () => {
    expect(selectPartyStage("preferences", "agent-run")).toBe("preferences");
  });
});
