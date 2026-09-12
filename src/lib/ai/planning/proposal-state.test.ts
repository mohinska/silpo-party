import { describe, expect, it } from "vitest";

import { createPlanningFingerprint, isCurrentMealProposal, shouldBuildMealProposal } from "./proposal-state";

const input = {
  party: { id: "party-1", budget_cents: 10_000 },
  members: [{ user_id: "user-1", display_name: "Олена" }],
  profiles: [{ id: "user-1", allergies: "арахіс", dietary_restrictions: "", dislikes: "", preferences: "" }],
  intents: [{ user_id: "user-1", dish_name: "Паста", description: "Без грибів", content_url: "", indifferent: false }],
};

describe("meal proposal state", () => {
  it("changes the fingerprint when planning inputs change", () => {
    const original = createPlanningFingerprint(input);
    const changed = createPlanningFingerprint({
      ...input,
      intents: [{ ...input.intents[0], description: "Без молока" }],
    });

    expect(createPlanningFingerprint(input)).toBe(original);
    expect(changed).not.toBe(original);
  });

  it("only treats an active proposal with the same fingerprint as current", () => {
    const fingerprint = createPlanningFingerprint(input);

    expect(isCurrentMealProposal({ status: "pending", inputFingerprint: fingerprint }, fingerprint)).toBe(true);
    expect(isCurrentMealProposal({ status: "applied", inputFingerprint: fingerprint }, fingerprint)).toBe(true);
    expect(isCurrentMealProposal({ status: "failed", inputFingerprint: fingerprint }, fingerprint)).toBe(false);
    expect(isCurrentMealProposal({ status: "pending", inputFingerprint: "old" }, fingerprint)).toBe(false);
  });

  it("does not rebuild an unchanged proposal from every chat message", () => {
    const fingerprint = createPlanningFingerprint(input);

    expect(shouldBuildMealProposal({
      allIntentsSubmitted: true,
      proposal: { status: "pending", inputFingerprint: fingerprint },
      fingerprint,
    })).toBe(false);
    expect(shouldBuildMealProposal({
      allIntentsSubmitted: true,
      proposal: { status: "pending", inputFingerprint: "old" },
      fingerprint,
    })).toBe(true);
    expect(shouldBuildMealProposal({
      allIntentsSubmitted: false,
      proposal: null,
      fingerprint,
    })).toBe(false);
  });

  it("allows a proposal to build without a budget", () => {
    expect(shouldBuildMealProposal({
      allIntentsSubmitted: true,
      proposal: null,
      fingerprint: "new",
    })).toBe(true);
  });
});
