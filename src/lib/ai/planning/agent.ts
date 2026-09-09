import { generateText, Output } from "ai";

import type {
  ParticipantContextLoader,
  ParticipantContextTraceEntry,
} from "./context";
import { PlanningProviderError } from "./errors";
import {
  extractParticipantFoodSignals,
  normalizeParticipantFoodContext,
  type ParticipantNormalizationAdapter,
} from "./normalization";
import { buildPlanningPrompt, PLANNING_SYSTEM_PROMPT } from "./prompt";
import {
  createConfiguredPlanningProvider,
  type PlanningModelProvider,
} from "./provider";
import {
  EventPlanSchema,
  EventPlanningInputSchema,
  GroupPlanningInputSchema,
  ParticipantFoodSignalsSchema,
  UserFoodContextSchema,
  type EventPlan,
  type EventPlanningInput,
  type GroupPlanningInput,
  type UserFoodContext,
} from "./schemas";
import { assertEventPlanSafety } from "./safety";

export type PlanGenerationAdapter = (request: {
  input: GroupPlanningInput;
  system: string;
  prompt: string;
}) => Promise<unknown>;

export type PlanEventOptions = {
  loadParticipantContext?: ParticipantContextLoader;
  normalizeParticipantContext?: ParticipantNormalizationAdapter;
  generatePlan?: PlanGenerationAdapter;
  modelProvider?: PlanningModelProvider;
};

export type PlanningResult = {
  plan: EventPlan;
  contextTrace: ParticipantContextTraceEntry[];
};

function createDefaultNormalizer(
  provider: PlanningModelProvider,
): ParticipantNormalizationAdapter {
  return async ({ participantId, signals }) => {
    const result = await generateText({
      model: provider.participantNormalizerModel(),
      system:
        "Normalize only the supplied bounded food signals. Do not invent allergies or treat missing data as unrestricted. Return concise Ukrainian summaries.",
      prompt: `Return a normalized food context for ${participantId} as JSON: ${JSON.stringify(signals)}`,
      output: Output.object({ schema: UserFoodContextSchema }),
    });
    return result.output;
  };
}

function createDefaultPlanner(
  provider: PlanningModelProvider,
): PlanGenerationAdapter {
  return async ({ system, prompt }) => {
    const result = await generateText({
      model: provider.groupPlannerModel(),
      system,
      prompt,
      output: Output.object({ schema: EventPlanSchema }),
    });
    return result.output;
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function suppliedContextAsRaw(
  participant: EventPlanningInput["participants"][number],
) {
  if (!participant.silpoContext) return undefined;
  return {
    silpo_get_my_food_restrictions: {
      structuredContent: {
        restrictions: participant.silpoContext.foodRestrictions.map((item) => ({
          ...item,
          type: "restriction",
          name: item.label,
        })),
      },
    },
    silpo_get_my_favorites: {
      structuredContent: { items: participant.silpoContext.favorites },
    },
  };
}

export async function planEvent(
  rawInput: unknown,
  options: PlanEventOptions = {},
): Promise<PlanningResult> {
  const input = EventPlanningInputSchema.parse(rawInput);
  let configuredProvider = options.modelProvider;
  const getProvider = () => {
    configuredProvider ??= createConfiguredPlanningProvider();
    return configuredProvider;
  };
  const loadParticipantContext =
    options.loadParticipantContext ??
    (async () => ({
      status: "unavailable" as const,
      reason: "No participant context loader was provided.",
    }));

  const preprocessed = await mapWithConcurrency(
    input.participants,
    3,
    async (participant) => {
      const supplied = suppliedContextAsRaw(participant);
      let loaded: Awaited<ReturnType<ParticipantContextLoader>>;
      if (supplied) {
        loaded = { status: "available", data: supplied };
      } else {
        try {
          loaded = await loadParticipantContext(participant.id);
        } catch {
          loaded = {
            status: "unavailable",
            reason: "Silpo context collection failed.",
          };
        }
      }
      const signals =
        loaded.status === "available"
          ? extractParticipantFoodSignals(participant.id, loaded.data)
          : ParticipantFoodSignalsSchema.parse({
              participantId: participant.id,
              restrictions: [],
              favorites: [],
              ambiguousFragments: [],
              evidence: [],
              completeness: "unavailable",
            });
      const normalizeAmbiguous =
        options.normalizeParticipantContext ??
        (signals.ambiguousFragments.length > 0
          ? createDefaultNormalizer(getProvider())
          : undefined);
      let foodContext: UserFoodContext;
      try {
        foodContext = await normalizeParticipantFoodContext({
          participant,
          signals,
          normalizeAmbiguous,
        });
      } catch {
        const fallback = await normalizeParticipantFoodContext({
          participant,
          signals: {
            ...signals,
            ambiguousFragments: [],
            completeness: "partial",
          },
        });
        foodContext = UserFoodContextSchema.parse({
          ...fallback,
          completeness: "partial",
          missingInformation: [
            ...fallback.missingInformation,
            "Не вдалося семантично нормалізувати частину контексту Сільпо.",
          ].slice(0, 20),
        });
      }
      const contextStatus = supplied
        ? ("provided" as const)
        : loaded.status === "available"
          ? ("loaded" as const)
          : ("unavailable" as const);
      const trace: ParticipantContextTraceEntry =
        loaded.status === "unavailable"
          ? {
              participantId: participant.id,
              status: "unavailable",
              reason: loaded.reason,
            }
          : {
              participantId: participant.id,
              status: "available",
              sources: [...new Set(signals.evidence.map(({ source }) => source))],
              restrictionCount: signals.restrictions.length,
              favoriteCount: signals.favorites.length,
              ambiguousFragmentCount: signals.ambiguousFragments.length,
            };
      return { participant, foodContext, contextStatus, trace };
    },
  );

  const groupInput = GroupPlanningInputSchema.parse({
    event: input.event,
    host: input.host,
    budget: input.budget,
    participants: preprocessed.map(
      ({ participant, foodContext, contextStatus }) => ({
        id: participant.id,
        displayName: participant.displayName,
        foodIntent: participant.foodIntent,
        contextStatus,
        foodContext,
      }),
    ),
  });
  const generatePlan =
    options.generatePlan ?? createDefaultPlanner(getProvider());
  let rawPlan: unknown;
  try {
    rawPlan = await generatePlan({
      input: groupInput,
      system: PLANNING_SYSTEM_PROMPT,
      prompt: buildPlanningPrompt(groupInput),
    });
  } catch {
    throw new PlanningProviderError();
  }
  const plan = EventPlanSchema.parse(rawPlan);
  assertEventPlanSafety(groupInput, plan);

  return { plan, contextTrace: preprocessed.map(({ trace }) => trace) };
}
