import type { MealProposal } from "./proposal-schemas";

type PlanningFingerprintInput = {
  party: { id: string; budget_cents: number | null };
  members: Array<{ user_id: string; display_name: string }>;
  profiles: Array<{
    id: string;
    allergies: string;
    dietary_restrictions: string;
    dislikes: string;
    preferences: string;
  }>;
  intents: Array<{
    user_id: string;
    dish_name: string;
    description: string;
    content_url: string;
    indifferent: boolean;
  }>;
};

export function createPlanningFingerprint(input: PlanningFingerprintInput) {
  return JSON.stringify({
    party: input.party,
    members: input.members.map(({ user_id, display_name }) => ({ user_id, display_name })),
    profiles: [...input.profiles].sort((a, b) => a.id.localeCompare(b.id)),
    intents: [...input.intents].sort((a, b) => a.user_id.localeCompare(b.user_id)),
  });
}

export function isCurrentMealProposal(
  proposal: Pick<MealProposal, "status" | "inputFingerprint"> | null,
  fingerprint: string,
) {
  return Boolean(
    proposal &&
      ["pending", "applying", "applied"].includes(proposal.status) &&
      proposal.inputFingerprint === fingerprint,
  );
}

export function shouldBuildMealProposal({
  allIntentsSubmitted,
  proposal,
  fingerprint,
}: {
  allIntentsSubmitted: boolean;
  proposal: Pick<MealProposal, "status" | "inputFingerprint"> | null;
  fingerprint: string;
}) {
  return Boolean(
    allIntentsSubmitted &&
      !isCurrentMealProposal(proposal, fingerprint),
  );
}
