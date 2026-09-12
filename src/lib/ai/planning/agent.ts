import type {
  ParticipantContextLoader,
  ParticipantContextTraceEntry,
} from "./context";
import {
  createPlanningTraceEmitter,
  type PlanningTraceEventSink,
} from "./trace-stream";
import {
  isPlanningGenerationError,
  PlanningProviderError,
  PlanningSchemaValidationError,
} from "./errors";
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
import { generateValidatedJson } from "./structured-output";

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
  onTraceEvent?: PlanningTraceEventSink;
};

export type PlanningResult = {
  plan: EventPlan;
  contextTrace: ParticipantContextTraceEntry[];
};

function createDefaultNormalizer(
  provider: PlanningModelProvider,
): ParticipantNormalizationAdapter {
  return async ({ participantId, signals }) => {
    return generateValidatedJson({
      generateJsonText:
        provider.participantNormalizerModel().generateJsonText,
      system:
        "Normalize only the supplied bounded food signals. Do not invent allergies or treat missing data as unrestricted. Return concise Ukrainian summaries.",
      prompt: `Return a normalized food context for ${participantId} as JSON: ${JSON.stringify(signals)}`,
      schema: UserFoodContextSchema,
    });
  };
}

function createDefaultPlanner(
  provider: PlanningModelProvider,
): PlanGenerationAdapter {
  return async ({ system, prompt }) => {
    return generateValidatedJson({
      generateJsonText: provider.groupPlannerModel().generateJsonText,
      system,
      prompt,
      schema: EventPlanSchema,
    });
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
  const events = createPlanningTraceEmitter(options.onTraceEvent);
  events.started("input", { raw: rawInput });
  let input: EventPlanningInput;
  try {
    input = EventPlanningInputSchema.parse(rawInput);
    events.completed("input", { input });
  } catch (error) {
    events.failed("input", error);
    throw error;
  }
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
      let contextFailed = false;
      events.started(
        "context",
        { source: supplied ? "supplied" : "silpo-mcp" },
        participant.id,
      );
      if (supplied) {
        loaded = { status: "available", data: supplied };
      } else {
        try {
          loaded = await loadParticipantContext(participant.id);
        } catch (error) {
          contextFailed = true;
          events.failed("context", error, participant.id);
          loaded = {
            status: "unavailable",
            reason: "Silpo context collection failed.",
          };
        }
      }
      if (!contextFailed) {
        events.completed(
          "context",
          loaded.status === "available"
            ? { status: loaded.status, raw: loaded.data }
            : loaded,
          participant.id,
        );
      }
      events.started("signals", undefined, participant.id);
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
      events.completed("signals", { signals }, participant.id);
      const normalizeAmbiguous =
        options.normalizeParticipantContext ??
        (signals.ambiguousFragments.length > 0
          ? createDefaultNormalizer(getProvider())
          : undefined);
      let foodContext: UserFoodContext;
      events.started(
        "normalization",
        { mode: normalizeAmbiguous ? "model-assisted" : "deterministic" },
        participant.id,
      );
      try {
        foodContext = await normalizeParticipantFoodContext({
          participant,
          signals,
          normalizeAmbiguous,
        });
        events.completed("normalization", { foodContext }, participant.id);
      } catch (error) {
        events.failed("normalization", error, participant.id);
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

  events.started("prompt");
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
  const system = PLANNING_SYSTEM_PROMPT;
  const prompt = buildPlanningPrompt(groupInput);
  events.completed("prompt", { input: groupInput, system, prompt });
  const generatePlan =
    options.generatePlan ?? createDefaultPlanner(getProvider());
  let rawPlan: unknown;
  events.started("model");
  try {
    rawPlan = await generatePlan({
      input: groupInput,
      system,
      prompt,
    });
    events.completed("model", { rawOutput: rawPlan });
  } catch (error) {
    events.failed("model", error);
    if (isPlanningGenerationError(error)) throw error;
    throw new PlanningProviderError(error);
  }
  events.started("contract");
  let plan: EventPlan;
  try {
    const validation = EventPlanSchema.safeParse(rawPlan);
    if (!validation.success) {
      throw new PlanningSchemaValidationError(validation.error);
    }
    plan = validation.data;
    events.completed("contract", { plan });
  } catch (error) {
    events.failed("contract", error);
    throw error;
  }
  events.started("safety");
  try {
    assertEventPlanSafety(groupInput, plan);
    events.completed("safety", { checks: plan.hardConstraintChecks });
  } catch (error) {
    events.failed("safety", error);
    throw error;
  }

  return { plan, contextTrace: preprocessed.map(({ trace }) => trace) };
}
