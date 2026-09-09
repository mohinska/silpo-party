import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, isStepCount, Output } from "ai";

import {
  createParticipantContextAccess,
  createParticipantContextTool,
  type ParticipantContextLoader,
} from "./context";
import {
  PlanningConfigurationError,
  PlanningSafetyError,
  type PlanningSafetyIssue,
} from "./errors";
import { buildPlanningPrompt, PLANNING_SYSTEM_PROMPT } from "./prompt";
import {
  EventPlanSchema,
  EventPlanningInputSchema,
  type EventPlan,
  type EventPlanningInput,
} from "./schemas";
import { assertEventPlanSafety } from "./safety";

type ParticipantContextAccess = ReturnType<
  typeof createParticipantContextAccess
>;

export type PlanGenerationAdapter = (request: {
  input: EventPlanningInput;
  contextAccess: ParticipantContextAccess;
  system: string;
  prompt: string;
}) => Promise<unknown>;

export type PlanEventOptions = {
  loadParticipantContext?: ParticipantContextLoader;
  generatePlan?: PlanGenerationAdapter;
};

export type PlanningResult = {
  plan: EventPlan;
  contextTrace: ParticipantContextAccess["trace"];
};

async function generatePlanWithGemini({
  contextAccess,
  system,
  prompt,
}: Parameters<PlanGenerationAdapter>[0]): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new PlanningConfigurationError(
      "GEMINI_API_KEY is required to run the Gemini planning agent.",
    );
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const modelId = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const result = await generateText({
    model: google(modelId),
    system,
    prompt,
    tools: {
      get_participant_silpo_context:
        createParticipantContextTool(contextAccess),
    },
    stopWhen: isStepCount(12),
    output: Output.object({ schema: EventPlanSchema }),
  });

  return result.output;
}

function assertContextCollection(
  input: EventPlanningInput,
  plan: EventPlan,
  trace: ParticipantContextAccess["trace"],
) {
  const issues: PlanningSafetyIssue[] = [];
  const insightByParticipant = new Map(
    plan.participantInsights.map((insight) => [insight.participantId, insight]),
  );

  for (const participant of input.participants) {
    const entries = trace.filter(
      (entry) => entry.participantId === participant.id,
    );
    const insight = insightByParticipant.get(participant.id);

    if (participant.silpoContext) {
      if (entries.length > 0 || insight?.contextStatus !== "provided") {
        issues.push({
          code: "constraint_mismatch",
          message: `Participant ${participant.id} has supplied context but the plan did not mark it as provided.`,
          participantId: participant.id,
        });
      }
      continue;
    }

    if (entries.length !== 1) {
      issues.push({
        code: "missing_context",
        message: `Gemini did not request Silpo context exactly once for participant ${participant.id}.`,
        participantId: participant.id,
      });
      continue;
    }

    const expectedStatus =
      entries[0].status === "available" ? "loaded" : "unavailable";
    if (insight?.contextStatus !== expectedStatus) {
      issues.push({
        code: "constraint_mismatch",
        message: `Participant ${participant.id} context status does not match the tool result.`,
        participantId: participant.id,
      });
    }
  }

  if (issues.length > 0) {
    throw new PlanningSafetyError(issues);
  }
}

export async function planEvent(
  rawInput: unknown,
  options: PlanEventOptions = {},
): Promise<PlanningResult> {
  const input = EventPlanningInputSchema.parse(rawInput);
  const contextAccess = createParticipantContextAccess({
    allowedParticipantIds: input.participants.map(({ id }) => id),
    loader:
      options.loadParticipantContext ??
      (async () => ({
        status: "unavailable" as const,
        reason: "No participant context loader was provided.",
      })),
  });
  const generatePlan = options.generatePlan ?? generatePlanWithGemini;

  const rawPlan = await generatePlan({
    input,
    contextAccess,
    system: PLANNING_SYSTEM_PROMPT,
    prompt: buildPlanningPrompt(input),
  });
  const plan = EventPlanSchema.parse(rawPlan);

  assertContextCollection(input, plan, contextAccess.trace);
  assertEventPlanSafety(input, plan);

  return { plan, contextTrace: contextAccess.trace };
}
