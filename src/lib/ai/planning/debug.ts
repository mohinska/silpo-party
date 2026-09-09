import { z } from "zod";

import { PlanningSafetyError } from "./errors";
import {
  EventPlanningInputSchema,
  type EventPlanningInput,
} from "./schemas";

export function createSingleParticipantDebugInput({
  userId,
  displayName,
  now = new Date(),
}: {
  userId: string;
  displayName: string;
  now?: Date;
}): EventPlanningInput {
  const startsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return EventPlanningInputSchema.parse({
    event: {
      id: `ai-debug:${userId}`,
      title: "Тест персонального планування",
      description: "Тимчасова подія для перевірки Gemini та Silpo MCP.",
      startsAt: startsAt.toISOString(),
      locale: "uk-UA",
      mealNotes: "Не виконувати покупки; лише показати тестовий план.",
    },
    host: { participantId: userId, displayName },
    budget: { amount: 1000, currency: "UAH" },
    participants: [
      {
        id: userId,
        displayName,
        preferences: {
          allergies: [],
          dietaryRestrictions: [],
          likes: [],
          dislikes: [],
          cuisines: [],
        },
        foodIntent: { kind: "none" },
        contextCompleteness: "unknown",
      },
    ],
  });
}

export type SerializedDebugError = {
  name: string;
  message: string;
  issues?: unknown[];
};

export function serializeDebugError(error: unknown): SerializedDebugError {
  if (error instanceof PlanningSafetyError) {
    return {
      name: error.name,
      message: error.message,
      issues: error.issues,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      name: error.name,
      message: "Gemini or backend data did not match the planning contract.",
      issues: error.issues,
    };
  }

  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: "UnknownError", message: "Unknown planning error." };
}
