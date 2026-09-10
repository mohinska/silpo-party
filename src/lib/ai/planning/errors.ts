import type { ZodError } from "zod";

export type PlanningSafetyIssue = {
  code:
    | "duplicate_id"
    | "invalid_reference"
    | "insufficient_servings"
    | "missing_context"
    | "missing_check"
    | "unsafe_check"
    | "constraint_mismatch";
  message: string;
  participantId?: string;
  dishId?: string;
  constraintId?: string;
};

export class PlanningSafetyError extends Error {
  readonly issues: PlanningSafetyIssue[];

  constructor(issues: PlanningSafetyIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "PlanningSafetyError";
    this.issues = issues;
  }
}

export class PlanningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningConfigurationError";
  }
}

export class PlanningProviderError extends Error {
  override readonly cause: unknown;

  constructor(cause?: unknown) {
    super("AI planning provider request failed.");
    this.name = "PlanningProviderError";
    this.cause = cause;
  }
}

export class PlanningInvalidJsonError extends Error {
  override readonly cause: unknown;
  readonly responseText: string;

  constructor(responseText: string, cause: unknown) {
    super("AI planning provider returned invalid JSON.");
    this.name = "PlanningInvalidJsonError";
    this.responseText = responseText;
    this.cause = cause;
  }
}

export class PlanningSchemaValidationError extends Error {
  override readonly cause: ZodError;
  readonly issues: ZodError["issues"];

  constructor(cause: ZodError) {
    super("AI planning response did not match the required schema.");
    this.name = "PlanningSchemaValidationError";
    this.issues = cause.issues;
    this.cause = cause;
  }
}

export function isPlanningGenerationError(
  error: unknown,
): error is
  | PlanningProviderError
  | PlanningInvalidJsonError
  | PlanningSchemaValidationError {
  return (
    error instanceof PlanningProviderError ||
    error instanceof PlanningInvalidJsonError ||
    error instanceof PlanningSchemaValidationError
  );
}
