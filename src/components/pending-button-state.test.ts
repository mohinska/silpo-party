import { describe, expect, it } from "vitest";

import { pendingButtonState } from "./pending-button-state";

describe("pendingButtonState", () => {
  it("disables an action and swaps its label while its form is pending", () => {
    expect(
      pendingButtonState({
        pending: true,
        disabled: false,
        label: "Зберегти",
        pendingLabel: "Зберігаємо…",
      }),
    ).toEqual({ disabled: true, label: "Зберігаємо…" });
  });

  it("preserves business-rule disabled state before submission", () => {
    expect(
      pendingButtonState({
        pending: false,
        disabled: true,
        label: "Фіналізувати",
        pendingLabel: "Фіналізуємо…",
      }),
    ).toEqual({ disabled: true, label: "Фіналізувати" });
  });
});
