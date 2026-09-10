export const PARTY_STAGE_IDS = [
  "guests",
  "preferences",
  "shopping",
  "split",
] as const;

export type PartyStageId = (typeof PARTY_STAGE_IDS)[number];

export function selectPartyStage(
  current: PartyStageId,
  requested: string,
): PartyStageId {
  return PARTY_STAGE_IDS.includes(requested as PartyStageId)
    ? (requested as PartyStageId)
    : current;
}
