import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createConfiguredPlanningProvider,
  resolvePlanningProviderConfig,
} from "./provider";

const validEnvironment = {
  AI_PROVIDER: "alibaba",
  AI_API_KEY: "test-key",
  AI_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};

describe("resolvePlanningProviderConfig", () => {
  it("defaults both roles to qwen3.8-flash", () => {
    expect(resolvePlanningProviderConfig(validEnvironment)).toEqual({
      provider: "alibaba",
      apiKey: "test-key",
      baseUrl: validEnvironment.AI_BASE_URL,
      normalizerModel: "qwen3.8-flash",
      plannerModel: "qwen3.8-flash",
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
      resolvePlanningProviderConfig({ AI_PROVIDER: "alibaba" }),
    ).toThrow(/AI_API_KEY/i);
  });
});

describe("createConfiguredPlanningProvider", () => {
  it("creates independently selectable models behind one provider", () => {
    const provider = createConfiguredPlanningProvider({
      ...validEnvironment,
      AI_NORMALIZER_MODEL: "qwen-normalizer-test",
      AI_PLANNER_MODEL: "qwen-planner-test",
    });

    expect(provider.participantNormalizerModel().modelId).toBe(
      "qwen-normalizer-test",
    );
    expect(provider.groupPlannerModel().modelId).toBe("qwen-planner-test");
  });
});
