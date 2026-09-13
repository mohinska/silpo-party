import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createConfiguredPlanningProvider,
  createConfiguredAgentModel,
  resolvePlanningProviderConfig,
} from "./provider";

const validEnvironment = {
  AI_PROVIDER: "deepseek",
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://api.deepseek.com",
};

describe("resolvePlanningProviderConfig", () => {
  it("defaults both roles to deepseek-v4-flash", () => {
    expect(resolvePlanningProviderConfig(validEnvironment)).toEqual({
      provider: "deepseek",
      apiKey: "test-key",
      baseUrl: validEnvironment.AI_BASE_URL,
      normalizerModel: "deepseek-v4-flash",
      plannerModel: "deepseek-v4-flash",
      supervisorModel: "deepseek-v4-flash",
    });
  });

  it("rejects an unsupported provider", () => {
    expect(() =>
      resolvePlanningProviderConfig({
        ...validEnvironment,
        AI_PROVIDER: "openrouter",
      }),
    ).toThrow(/unsupported AI_PROVIDER/i);
  });

  it("rejects missing server credentials", () => {
    expect(() =>
      resolvePlanningProviderConfig({ AI_PROVIDER: "deepseek" }),
    ).toThrow(/AI_API_KEY/i);
  });
});

describe("createConfiguredPlanningProvider", () => {
  it("creates independently selectable models behind one provider", () => {
    const provider = createConfiguredPlanningProvider({
      ...validEnvironment,
      AI_NORMALIZER_MODEL: "deepseek-normalizer-test",
      AI_PLANNER_MODEL: "deepseek-planner-test",
      AI_SUPERVISOR_MODEL: "deepseek-supervisor-test",
    });

    expect(provider.participantNormalizerModel().modelId).toBe(
      "deepseek-normalizer-test",
    );
    expect(provider.groupPlannerModel().modelId).toBe(
      "deepseek-planner-test",
    );
    expect(provider.supervisorModel().modelId).toBe("deepseek-supervisor-test");
  });
});

describe("createConfiguredAgentModel", () => {
  it("creates a native model without the JSON-only response transform", () => {
    const model = createConfiguredAgentModel({ ...validEnvironment, AI_AGENT_MODEL: "durable-tools" });
    expect((model as { modelId: string }).modelId).toBe("durable-tools");
  });
});
