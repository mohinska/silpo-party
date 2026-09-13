import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";

import {
  PlanningConfigurationError,
  PlanningProviderError,
} from "./errors";
import type {
  JsonTextGenerationRequest,
  JsonTextGenerator,
} from "./structured-output";

type PlanningEnvironment = Record<string, string | undefined>;
export type PlanningJsonModel = {
  readonly modelId: string;
  generateJsonText: JsonTextGenerator;
};

export type PlanningProviderConfig = {
  provider: "deepseek";
  apiKey: string;
  baseUrl: string;
  normalizerModel: string;
  plannerModel: string;
  supervisorModel: string;
};

export type PlanningModelProvider = {
  participantNormalizerModel(): PlanningJsonModel;
  groupPlannerModel(): PlanningJsonModel;
  supervisorModel(): PlanningJsonModel;
};

function createJsonTextModel(
  model: ReturnType<OpenAICompatibleProvider>,
): PlanningJsonModel {
  return {
    modelId: model.modelId,
    async generateJsonText({ system, prompt }: JsonTextGenerationRequest) {
      try {
        const result = await generateText({ model, system, prompt });
        return result.text;
      } catch (error) {
        throw new PlanningProviderError(error);
      }
    },
  };
}

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
  const provider = environment.AI_PROVIDER?.trim() || "deepseek";
  if (provider !== "deepseek") {
    throw new PlanningConfigurationError(
      `Unsupported AI_PROVIDER: ${provider}.`,
    );
  }

  return {
    provider,
    apiKey: required(environment, "AI_API_KEY"),
    baseUrl: required(environment, "AI_BASE_URL"),
    normalizerModel:
      environment.AI_NORMALIZER_MODEL?.trim() || "deepseek-v4-flash",
    plannerModel:
      environment.AI_PLANNER_MODEL?.trim() || "deepseek-v4-flash",
    supervisorModel:
      environment.AI_SUPERVISOR_MODEL?.trim() || "deepseek-v4-flash",
  };
}

export function createConfiguredPlanningProvider(
  environment: PlanningEnvironment = process.env,
): PlanningModelProvider {
  const config = resolvePlanningProviderConfig(environment);
  const deepseek = createOpenAICompatible({
    name: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    supportsStructuredOutputs: false,
    transformRequestBody: (body) => ({
      ...body,
      response_format: { type: "json_object" },
    }),
  });

  return {
    participantNormalizerModel: () =>
      createJsonTextModel(deepseek(config.normalizerModel)),
    groupPlannerModel: () => createJsonTextModel(deepseek(config.plannerModel)),
    supervisorModel: () => createJsonTextModel(deepseek(config.supervisorModel)),
  };
}

/** ToolLoopAgent must use native provider tool-call responses. The legacy JSON
 * helper above deliberately keeps its response_format transform isolated. */
export function createConfiguredAgentModel(
  environment: PlanningEnvironment = process.env,
): LanguageModel {
  const config = resolvePlanningProviderConfig(environment);
  const provider = createOpenAICompatible({
    name: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    supportsStructuredOutputs: false,
  });
  return provider(environment.AI_AGENT_MODEL?.trim() || config.plannerModel);
}
