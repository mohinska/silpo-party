import { describe, expect, it, vi } from "vitest";

import { planEvent } from "./agent";
import { PlanningProviderError, PlanningSafetyError } from "./errors";
import type { PlanningTraceEvent } from "./trace-stream";
import { createConfiguredPlanningProvider } from "./provider";
import type { EventPlan, GroupPlanningInput } from "./schemas";

const validInput = {
  event: {
    id: "event-1",
    title: "Тестова вечеря",
    startsAt: "2026-09-12T18:00:00.000Z",
    locale: "uk-UA",
  },
  host: { participantId: "p1", displayName: "Олена" },
  budget: { amount: 900, currency: "UAH" },
  participants: [
    {
      id: "p1",
      displayName: "Олена",
      preferences: {
        allergies: [{ id: "allergy:peanut", label: "Арахіс" }],
        dietaryRestrictions: [],
        likes: [],
        dislikes: [],
        cuisines: [],
      },
      foodIntent: { kind: "dish", dishName: "Овочеве рагу" },
      contextCompleteness: "partial",
    },
  ],
};

const safePlan: EventPlan = {
  status: "ready",
  participantInsights: [
    {
      participantId: "p1",
      contextStatus: "loaded",
      allergies: [],
      hardRestrictions: [],
      preferences: [],
      summary: "Контекст Сільпо отримано.",
    },
  ],
  dishes: [
    {
      id: "dish-1",
      name: "Овочеве рагу",
      requestedByParticipantIds: ["p1"],
      eaterParticipantIds: ["p1"],
      servings: 1,
      ingredients: [{ name: "Кабачок" }],
      reasoningSummary: "Без арахісу.",
    },
  ],
  conflicts: [],
  proposedResolutions: [],
  hardConstraintChecks: [
    {
      dishId: "dish-1",
      participantId: "p1",
      constraintId: "allergy:peanut",
      constraintKind: "allergy",
      status: "safe",
      explanation: "Арахіс відсутній.",
    },
  ],
  reasoningSummary: "Один глобальний план для тестової події.",
};

describe("planEvent", () => {
  it("uses DeepSeek JSON-object mode and retries one schema-invalid plan", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(input), body });
        const content = requests.length === 1 ? { status: "ready" } : safePlan;

        return new Response(
          JSON.stringify({
            id: `completion-${requests.length}`,
            object: "chat.completion",
            created: 1,
            model: "deepseek-v4-flash",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify(content),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 10,
              total_tokens: 20,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    try {
      const result = await planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        modelProvider: createConfiguredPlanningProvider({
          AI_PROVIDER: "deepseek",
          AI_API_KEY: "test-key",
          AI_BASE_URL: "https://api.deepseek.com",
          AI_NORMALIZER_MODEL: "deepseek-v4-flash",
          AI_PLANNER_MODEL: "deepseek-v4-flash",
        }),
      });

      expect(result.plan).toEqual(safePlan);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.deepseek.com/chat/completions",
      "https://api.deepseek.com/chat/completions",
    ]);
    expect(
      requests.map(({ body }) => ({
        model: body.model,
        response_format: body.response_format,
      })),
    ).toEqual([
      {
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
      },
      {
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
      },
    ]);
    const firstMessages = requests[0].body.messages as Array<{
      content: string;
    }>;
    const retryMessages = requests[1].body.messages as Array<{
      content: string;
    }>;
    expect(firstMessages.map(({ content }) => content).join("\n")).toContain(
      '"hardConstraintChecks"',
    );
    expect(retryMessages.map(({ content }) => content).join("\n")).toContain(
      '"participantInsights"',
    );
    expect(retryMessages.map(({ content }) => content).join("\n")).toContain(
      '"path"',
    );
  });

  it("emits inspectable stages in execution order", async () => {
    const events: PlanningTraceEvent[] = [];

    await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "available",
        data: {
          silpo_get_my_favorites: {
            structuredContent: { items: [{ name: "Тофу" }] },
          },
        },
      }),
      generatePlan: async () => safePlan,
      onTraceEvent: (event) => events.push(event),
    });

    expect(events.map(({ stage, status }) => `${stage}:${status}`)).toEqual([
      "input:started",
      "input:completed",
      "context:started",
      "context:completed",
      "signals:started",
      "signals:completed",
      "normalization:started",
      "normalization:completed",
      "prompt:started",
      "prompt:completed",
      "model:started",
      "model:completed",
      "contract:started",
      "contract:completed",
      "safety:started",
      "safety:completed",
    ]);
    expect(events.find(({ stage, status }) =>
      stage === "context" && status === "completed",
    )?.data).toMatchObject({ status: "available" });
    expect(events.find(({ stage, status }) =>
      stage === "prompt" && status === "completed",
    )?.data).toEqual({ status: "completed" });
  });

  it("emits the original provider failure at the model stage", async () => {
    const events: PlanningTraceEvent[] = [];

    const request = expect(
      planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        generatePlan: async () => {
          throw new Error("upstream status 429");
        },
        onTraceEvent: (event) => events.push(event),
      }),
    ).rejects;

    await request.toBeInstanceOf(PlanningProviderError);
    await request.toMatchObject({
      cause: expect.objectContaining({ message: "upstream status 429" }),
    });

    expect(events.at(-1)).toMatchObject({
      stage: "model",
      status: "failed",
      error: { name: "Error", message: "upstream status 429" },
    });
  });

  it("returns a typed invalid-JSON error after one repair attempt", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          id: `completion-${requests}`,
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "not valid JSON" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            total_tokens: 20,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      await expect(
        planEvent(validInput, {
          loadParticipantContext: async () => ({ status: "available", data: {} }),
          modelProvider: createConfiguredPlanningProvider({
            AI_PROVIDER: "deepseek",
            AI_API_KEY: "test-key",
            AI_BASE_URL: "https://api.deepseek.com",
          }),
        }),
      ).rejects.toMatchObject({ name: "PlanningInvalidJsonError" });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toBe(2);
  });

  it("returns a typed schema error after one repair attempt", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          id: `completion-${requests}`,
          object: "chat.completion",
          created: 1,
          model: "deepseek-v4-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ status: "ready" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            total_tokens: 20,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      await expect(
        planEvent(validInput, {
          loadParticipantContext: async () => ({ status: "available", data: {} }),
          modelProvider: createConfiguredPlanningProvider({
            AI_PROVIDER: "deepseek",
            AI_API_KEY: "test-key",
            AI_BASE_URL: "https://api.deepseek.com",
          }),
        }),
      ).rejects.toMatchObject({
        name: "PlanningSchemaValidationError",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["participantInsights"] }),
        ]),
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toBe(2);
  });

  it("validates input before invoking model generation", async () => {
    let generationCalls = 0;

    await expect(
      planEvent(
        { ...validInput, participants: [] },
        {
          loadParticipantContext: async () => ({ status: "available", data: {} }),
          generatePlan: async () => {
            generationCalls += 1;
            return safePlan;
          },
        },
      ),
    ).rejects.toThrow();

    expect(generationCalls).toBe(0);
  });

  it("returns a typed schema error for an invalid adapter result", async () => {
    await expect(
      planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        generatePlan: async () => ({ status: "ready" }),
      }),
    ).rejects.toMatchObject({
      name: "PlanningSchemaValidationError",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["participantInsights"] }),
      ]),
    });
  });

  it("passes only normalized participant context to the group planner", async () => {
    let plannerInput: unknown;
    const result = await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "available",
        data: {
          silpo_get_my_favorites: {
            structuredContent: { items: [{ name: "Тофу" }] },
          },
          accessToken: "hidden",
        },
      }),
      generatePlan: async ({ input }) => {
        plannerInput = input;
        return safePlan;
      },
    });

    expect(result.plan).toEqual(safePlan);
    expect(JSON.stringify(plannerInput)).toContain("foodContext");
    expect(JSON.stringify(plannerInput)).not.toMatch(/accessToken|structuredContent/);
    expect(result.contextTrace[0]).toMatchObject({
      participantId: "p1",
      status: "available",
      favoriteCount: 1,
    });
  });

  it("allows planning when MCP is unavailable and no restrictions are declared", async () => {
    let normalizedCompleteness: string | undefined;
    let missingInformation: string[] | undefined;
    const result = await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "unavailable",
        reason: "not connected",
      }),
      generatePlan: async ({ input }) => {
        normalizedCompleteness = input.participants[0].foodContext.completeness;
        missingInformation = input.participants[0].foodContext.missingInformation;
        return {
          ...safePlan,
          participantInsights: [
            { ...safePlan.participantInsights[0], contextStatus: "unavailable" },
          ],
        };
      },
    });

    expect(normalizedCompleteness).toBe("complete");
    expect(missingInformation).toEqual([]);
    expect(result.plan.status).toBe("ready");
    expect(result.contextTrace[0]).toMatchObject({
      status: "unavailable",
      reason: "not connected",
    });
  });

  it("rejects a structured plan with an unsafe eater assignment", async () => {
    await expect(
      planEvent(validInput, {
        loadParticipantContext: async () => ({ status: "available", data: {} }),
        generatePlan: async () => {
          return {
            ...safePlan,
            hardConstraintChecks: [
              { ...safePlan.hardConstraintChecks[0], status: "conflict" },
            ],
          };
        },
      }),
    ).rejects.toBeInstanceOf(PlanningSafetyError);
  });

  it("preprocesses at most three participants concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    const participants = Array.from({ length: 5 }, (_, index) => ({
      ...validInput.participants[0],
      id: `p${index + 1}`,
      displayName: `Учасник ${index + 1}`,
      preferences: {
        ...validInput.participants[0].preferences,
        allergies: [],
      },
    }));
    const input = {
      ...validInput,
      participants,
      host: { participantId: "p1", displayName: "Учасник 1" },
    };

    await planEvent(input, {
      loadParticipantContext: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: "available", data: {} };
      },
      generatePlan: async () => ({
        status: "ready",
        participantInsights: participants.map(({ id }) => ({
          participantId: id,
          contextStatus: "loaded",
          allergies: [],
          hardRestrictions: [],
          preferences: [],
          summary: "Контекст перевірено.",
        })),
        dishes: participants.map(({ id }, index) => ({
          id: `dish-${index + 1}`,
          name: "Спільна страва",
          requestedByParticipantIds: [id],
          eaterParticipantIds: [id],
          servings: 1,
          ingredients: [{ name: "Овочі" }],
          reasoningSummary: "Підходить учаснику.",
        })),
        conflicts: [],
        proposedResolutions: [],
        hardConstraintChecks: [],
        reasoningSummary: "Один глобальний план.",
      }),
    });

    expect(maximumActive).toBe(3);
  });

  it("isolates one participant MCP failure without leaking its error", async () => {
    const participants = [
      validInput.participants[0],
      {
        ...validInput.participants[0],
        id: "p2",
        displayName: "Тарас",
        preferences: {
          ...validInput.participants[0].preferences,
          allergies: [],
        },
      },
    ];
    let plannerInput: unknown;

    const result = await planEvent(
      { ...validInput, participants },
      {
        loadParticipantContext: async (participantId) => {
          if (participantId === "p2") throw new Error("secret upstream body");
          return { status: "available", data: {} };
        },
        generatePlan: async ({ input }) => {
          plannerInput = input;
          return {
            status: "needs_input",
            participantInsights: participants.map(({ id }) => ({
              participantId: id,
              contextStatus: id === "p2" ? "unavailable" : "loaded",
              allergies: [],
              hardRestrictions: [],
              preferences: [],
              summary: "Потрібне уточнення.",
            })),
            dishes: [],
            conflicts: [],
            proposedResolutions: [],
            hardConstraintChecks: [],
            reasoningSummary: "Потрібен контекст другого учасника.",
          };
        },
      },
    );

    expect(JSON.stringify(plannerInput)).not.toContain("secret upstream body");
    expect(result.contextTrace[1]).toEqual({
      participantId: "p2",
      status: "unavailable",
      reason: "Silpo context collection failed.",
    });
  });

  it("falls back to deterministic context when semantic normalization fails", async () => {
    let plannerInput: GroupPlanningInput | undefined;

    await planEvent(validInput, {
      loadParticipantContext: async () => ({
        status: "available",
        data: {
          silpo_get_my_food_restrictions: {
            content: [{ type: "text", text: "Не їм невідомий інгредієнт" }],
          },
        },
      }),
      normalizeParticipantContext: async () => {
        throw new Error("raw provider response");
      },
      generatePlan: async ({ input }) => {
        plannerInput = input;
        return {
          ...safePlan,
          status: "needs_input",
          dishes: [],
          hardConstraintChecks: [],
        };
      },
    });

    expect(plannerInput?.participants[0].foodContext.hardConstraints).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Арахіс" })]),
    );
    expect(plannerInput?.participants[0].foodContext.missingInformation).toContain(
      "Не вдалося семантично нормалізувати частину контексту Сільпо.",
    );
    expect(JSON.stringify(plannerInput)).not.toContain("raw provider response");
  });

  it("does not expose raw provider failures", async () => {
    const promise = planEvent(validInput, {
      loadParticipantContext: async () => ({ status: "available", data: {} }),
      generatePlan: async () => {
        throw new Error("upstream response with private prompt");
      },
    });

    await expect(promise).rejects.toBeInstanceOf(PlanningProviderError);
    await expect(promise).rejects.not.toThrow(/private prompt/);
  });
});
