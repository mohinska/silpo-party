import { describe, expect, it } from "vitest";

import { selectPartyTab } from "./party-tabs-state";

describe("selectPartyTab", () => {
  it("keeps the party workspace on one of the two product tabs", () => {
    expect(selectPartyTab("chat", "basket")).toBe("basket");
    expect(selectPartyTab("basket", "chat")).toBe("chat");
  });

  it("ignores removed removed-only tabs", () => {
    expect(selectPartyTab("chat", "log")).toBe("chat");
  });
});
