import type { DebugPartyWorkspace } from "@/lib/ai/debug-party/repository";

export function participantName(workspace: DebugPartyWorkspace, id: string | null) {
  if (!id) return "Помічник Сільпо";
  if (id === workspace.member.participantId) return "Ви";
  if (id === workspace.party.hostId) return "Організатор";
  const members = [...workspace.members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.participantId.localeCompare(b.participantId));
  const index = members.findIndex((member) => member.participantId === id);
  return index === -1 ? "Учасник" : `Учасник ${index + 1}`;
}
