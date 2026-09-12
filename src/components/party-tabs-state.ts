export const PARTY_TAB_IDS = ["chat", "basket"] as const;

export type PartyTabId = (typeof PARTY_TAB_IDS)[number];

export function selectPartyTab(current: PartyTabId, requested: string): PartyTabId {
  return PARTY_TAB_IDS.includes(requested as PartyTabId)
    ? (requested as PartyTabId)
    : current;
}
