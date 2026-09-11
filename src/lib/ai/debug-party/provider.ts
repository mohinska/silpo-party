import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { resolvePlanningProviderConfig } from "../planning/provider";
import { CANDIDATE_PRESELECTOR_PROMPT } from "./prompts";
import type { CandidatePreselector } from "./candidate-preselector";

export type DebugPartyEnvironment = Record<string, string | undefined>;

export function createDebugPartyModel(environment: DebugPartyEnvironment = process.env) {
  const config = resolvePlanningProviderConfig(environment);
  return createOpenAICompatible({
    name: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    supportsStructuredOutputs: false,
  })(config.plannerModel);
}

/** The only LLM boundary used by the catalog preselector; its output is still checked by Zod and evidence coverage. */
export function createDebugCandidatePreselector(environment: DebugPartyEnvironment = process.env): CandidatePreselector {
  return async (input) => {
    const config = resolvePlanningProviderConfig(environment);
    const model = createOpenAICompatible({
      name: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      supportsStructuredOutputs: false,
      transformRequestBody: (body) => ({ ...body, response_format: { type: "json_object" } }),
    })(config.plannerModel);
    const result = await generateText({ model, system: CANDIDATE_PRESELECTOR_PROMPT, prompt: JSON.stringify(input) });
    return JSON.parse(result.text) as unknown;
  };
}

export function resolveDebugPartyLimits(environment: DebugPartyEnvironment = process.env) {
  function limit(name: string, fallback: number, maximum = 2_147_483_647) {
    const value = environment[name] === undefined ? fallback : Number(environment[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
    }
    return value;
  }
  const toolMs = limit("AI_DEBUG_TOOL_TIMEOUT_MS", 15_000);
  return {
    maxSteps: limit("AI_DEBUG_MAX_STEPS", 20, 100),
    maxMcpCalls: limit("AI_DEBUG_MAX_MCP_CALLS", 40),
    totalMs: limit("AI_DEBUG_TOTAL_TIMEOUT_MS", 180_000),
    toolMs,
  };
}
