"use server";

import { requireUser } from "@/lib/auth";
import {
  createSingleParticipantDebugInput,
  serializeDebugError,
  type SerializedDebugError,
} from "@/lib/ai/planning/debug";
import { planEvent, type PlanningResult } from "@/lib/ai/planning";
import type { EventPlanningInput } from "@/lib/ai/planning/schemas";
import { getPersonalSilpoContext } from "@/lib/silpo/mcp";

type DebugTrace = PlanningResult["contextTrace"];

export type DebugPlanningState =
  | { status: "idle" }
  | {
      status: "success";
      input: EventPlanningInput;
      result: PlanningResult;
    }
  | {
      status: "error";
      error: SerializedDebugError;
      contextTrace: DebugTrace;
    };

export async function runDebugPlanning(
  _previousState: DebugPlanningState,
  _formData: FormData,
): Promise<DebugPlanningState> {
  void _previousState;
  void _formData;

  const user = await requireUser();
  const displayName =
    user.user_metadata.full_name ??
    user.user_metadata.name ??
    user.email ??
    "Користувач";
  const input = createSingleParticipantDebugInput({
    userId: user.id,
    displayName,
  });
  const contextTrace: DebugTrace = [];

  try {
    const result = await planEvent(input, {
      loadParticipantContext: async (participantId) => {
        if (participantId !== user.id) {
          throw new Error("Debug context access is limited to the current user.");
        }

        const context = await getPersonalSilpoContext(user.id);
        if (!context) {
          const unavailable = {
            participantId,
            status: "unavailable" as const,
            reason: "Silpo account is not connected or context is unavailable.",
          };
          contextTrace.push(unavailable);
          return {
            status: unavailable.status,
            reason: unavailable.reason,
          };
        }

        return { status: "available", data: context };
      },
    });

    return { status: "success", input, result };
  } catch (error) {
    return {
      status: "error",
      error: serializeDebugError(error),
      contextTrace,
    };
  }
}
