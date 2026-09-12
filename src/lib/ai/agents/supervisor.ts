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

const SYSTEM = `You are the main orchestration agent for a shared Ukrainian grocery party. Choose only typed next actions. Never invent products, prices, MCP data, or completed work. Product search, basket calculation and constraint review are specialist operations. The shared budget is optional: never block an actionable request or ask for a budget before executing the available workflow. Keep the reply concise.`;

function fallback(request: SupervisorRequest): SupervisorDecision {
  if (!request.partyState.hasIntent) return SupervisorDecisionSchema.parse({ actions: [{ type: "parse_intent" }], reply: "Уточнюю ваш запит." });
  if (!request.partyState.hasProposal) return SupervisorDecisionSchema.parse({ actions: [{ type: "build_basket" }, { type: "review_constraints" }], reply: "Оновлюю спільний кошик." });
  return SupervisorDecisionSchema.parse({ actions: [{ type: "parse_intent" }], reply: "Оновлюю запит." });
}

export async function runSupervisorDecision(request: SupervisorRequest): Promise<SupervisorDecision> {
  if (!request.generate) return fallback(request);
  try {
    const decision = await generateValidatedJson({
      generateJsonText: request.generate,
      system: SYSTEM,
      prompt: JSON.stringify({ partyState: request.partyState, message: request.message.slice(0, 2_000) }),
      schema: SupervisorDecisionSchema,
    });
    const onlyAsksForBudget = decision.actions.every((action) => action.type === "ask_user")
      && !request.partyState.hasBudget
      && request.partyState.hasIntent
      && !request.partyState.hasProposal;
    return onlyAsksForBudget
      ? SupervisorDecisionSchema.parse({ actions: [{ type: "build_basket" }, { type: "review_constraints" }], reply: "Оновлюю спільний кошик без бюджетного обмеження." })
      : decision;
  } catch {
    return fallback(request);
  }
}
