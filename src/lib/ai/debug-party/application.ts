import "server-only";

import { createDebugPartyRepository, type DebugPartyRepository } from "./repository";
import { runDebugPartySupervisor } from "./supervisor";
import { createSilpoFrozenCartAdapter, sendFrozenDebugCart, type SendResult } from "./send-to-silpo";

type ApplicationDependencies = {
  repository: DebugPartyRepository;
  supervise: typeof runDebugPartySupervisor;
  send: (code: string, actorId: string, confirmChanges: boolean) => Promise<SendResult>;
};

/** Coordinates application services; authorization and atomic writes also remain in the repository. */
export function assembleDebugPartyApplication({ repository, supervise, send }: ApplicationDependencies) {
  async function requireHost(code: string, actorId: string) {
    const workspace = await repository.loadWorkspace(code, actorId);
    if (workspace.member.role !== "host" || workspace.party.hostId !== actorId) {
      throw new Error("Лише Host може виконати цю дію.");
    }
    return workspace;
  }

  return {
    async createParty(actorId: string, budgetCents: number | null) {
      const code = await repository.createParty(actorId);
      if (budgetCents !== null) await repository.saveBudget(code, actorId, budgetCents);
      return code;
    },
    joinParty: (code: string, actorId: string) => repository.joinParty(code, actorId),
    loadWorkspace: (code: string, actorId: string) => repository.loadWorkspace(code, actorId),
    saveBudget: (code: string, actorId: string, budgetCents: number | null) => repository.saveBudget(code, actorId, budgetCents),

    async sendMessage(code: string, actorId: string, content: string) {
      const message = await repository.appendChatMessage(code, actorId, content);
      const result = await supervise({ mode: "chat", partyId: message.partyId, actorId, messageId: message.id }, {
        code, actorId, repository,
        loadMessage: async (messageId) => messageId === message.id
          ? { partyId: message.partyId, actorId: message.participantId!, content: message.content }
          : null,
      });
      await repository.persistAssistantReply(code, actorId, result.runId, result.reply);
      return result;
    },

    async buildBasket(code: string, actorId: string) {
      const workspace = await requireHost(code, actorId);
      const result = await supervise({ mode: "build", partyId: workspace.party.id, actorId }, { code, actorId, repository });
      await repository.persistAssistantReply(code, actorId, result.runId, result.reply);
      return result;
    },

    async finalizeParty(code: string, actorId: string) {
      await requireHost(code, actorId);
      return repository.finalizeParty(code, actorId);
    },

    async sendCart(code: string, actorId: string, confirmChanges: boolean) {
      await requireHost(code, actorId);
      return send(code, actorId, confirmChanges);
    },
  };
}

export async function createDebugPartyApplication() {
  const repository = await createDebugPartyRepository();
  return assembleDebugPartyApplication({
    repository,
    supervise: runDebugPartySupervisor,
    send: async (code, actorId, confirmChanges) => {
      const { createFrozenDebugCartSendRepository } = await import("./send-repository");
      return sendFrozenDebugCart({ code, actorId, confirmChanges }, {
        repository: await createFrozenDebugCartSendRepository(),
        cart: createSilpoFrozenCartAdapter(),
      });
    },
  });
}
