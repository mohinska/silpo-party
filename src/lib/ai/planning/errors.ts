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
  constructor() {
    super("AI planning provider request failed.");
    this.name = "PlanningProviderError";
  }
}
