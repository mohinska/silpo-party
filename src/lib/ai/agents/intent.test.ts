import { describe, expect, it } from "vitest";

import { applyIntentDelta, parseIntentDelta } from "./intent";

describe("party intent agent", () => {
  it("falls back to a product request for a short grocery message", async () => {
    await expect(parseIntentDelta("додай молоко і яйця", { generate: async () => "{}" })).resolves.toMatchObject({
      kind: "product_request",
      additions: ["молоко", "яйця"],
    });
  });

  it("applies removals without deleting unrelated intent", () => {
    expect(applyIntentDelta({
      kind: "change", additions: [], removals: ["вершки"], modifications: [], confidence: 1,
    }, { dishName: "карбонара", description: "паста з вершками", contentUrl: "", indifferent: false })).toEqual({
      dishName: "карбонара",
      description: "паста з вершками\nВиключити: вершки",
      contentUrl: "",
      indifferent: false,
    });
  });
});
