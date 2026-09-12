import { describe, expect, it } from "vitest";

import { groupProposalWarnings } from "./proposal-ui";

describe("proposal warnings", () => {
  it("groups repeated catalog failures into one readable warning", () => {
    expect(groupProposalWarnings([
      { requirementKey: "a", reason: "No verified product." },
      { requirementKey: "b", reason: "No verified product." },
      { requirementKey: "c", reason: "Recipe missing." },
    ])).toEqual([
      { requirementKey: "a", reason: "No verified product.", count: 2 },
      { requirementKey: "c", reason: "Recipe missing.", count: 1 },
    ]);
  });
});
