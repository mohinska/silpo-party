import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";

import { PlanningConfigurationError } from "./errors";

type PlanningEnvironment = Record<string, string | undefined>;
type PlanningLanguageModel = ReturnType<OpenAICompatibleProvider>;

export type PlanningProviderConfig = {
  provider: "alibaba";
  apiKey: string;
  baseUrl: string;
  normalizerModel: string;
  plannerModel: string;
};

export type PlanningModelProvider = {
  participantNormalizerModel(): PlanningLanguageModel;
  groupPlannerModel(): PlanningLanguageModel;
};

function required(environment: PlanningEnvironment, name: keyof PlanningEnvironment) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new PlanningConfigurationError(`${name} is required for AI planning.`);
  }
  return value;
}

export function resolvePlanningProviderConfig(
  environment: PlanningEnvironment,
): PlanningProviderConfig {
  const provider = environment.AI_PROVIDER?.trim() || "alibaba";
  if (provider !== "alibaba") {
    throw new PlanningConfigurationError(
      `Unsupported AI_PROVIDER: ${provider}.`,
    );
  }

  return {
    provider,
    apiKey: required(environment, "AI_API_KEY"),
    baseUrl: required(environment, "AI_BASE_URL"),
    normalizerModel:
      environment.AI_NORMALIZER_MODEL?.trim() || "qwen3.8-flash",
    plannerModel: environment.AI_PLANNER_MODEL?.trim() || "qwen3.8-flash",
  };
}

export function createConfiguredPlanningProvider(
  environment: PlanningEnvironment = process.env,
): PlanningModelProvider {
  const config = resolvePlanningProviderConfig(environment);
  const alibaba = createOpenAICompatible({
    name: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    supportsStructuredOutputs: true,
  });

  return {
    participantNormalizerModel: () => alibaba(config.normalizerModel),
    groupPlannerModel: () => alibaba(config.plannerModel),
  };
}
