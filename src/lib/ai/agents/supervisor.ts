import { generateValidatedJson } from "../planning/structured-output";
import { SupervisorDecisionSchema, type SupervisorDecision } from "./contracts";

export type SupervisorGenerationAdapter = (request: { system: string; prompt: string }) => Promise<string>;

export type SupervisorRequest = {
  partyState: {
    hasIntent: boolean;
    hasBudget: boolean;
    hasProposal: boolean;
  };
  message: string;
  generate?: SupervisorGenerationAdapter;
};

const SYSTEM = `You are the main orchestration agent for a shared Ukrainian grocery party. Choose only typed next actions. Never invent products, prices, MCP data, or completed work. Product search, basket calculation and constraint review are specialist operations. Keep the reply concise.`;

function fallback(request: SupervisorRequest): SupervisorDecision {
  if (!request.partyState.hasIntent) return SupervisorDecisionSchema.parse({ actions: [{ type: "parse_intent" }], reply: "Уточнюю ваш запит." });
  if (!request.partyState.hasBudget) return SupervisorDecisionSchema.parse({ actions: [{ type: "ask_user", question: "Вкажіть спільний бюджет події." }], reply: "Спочатку потрібен спільний бюджет." });
  if (!request.partyState.hasProposal) return SupervisorDecisionSchema.parse({ actions: [{ type: "build_basket" }, { type: "review_constraints" }], reply: "Оновлюю спільний кошик." });
  return SupervisorDecisionSchema.parse({ actions: [{ type: "parse_intent" }], reply: "Оновлюю запит." });
}

export async function runSupervisorDecision(request: SupervisorRequest): Promise<SupervisorDecision> {
  if (!request.generate) return fallback(request);
  try {
    return await generateValidatedJson({
      generateJsonText: request.generate,
      system: SYSTEM,
      prompt: JSON.stringify({ partyState: request.partyState, message: request.message.slice(0, 2_000) }),
      schema: SupervisorDecisionSchema,
    });
  } catch {
    return fallback(request);
  }
}
