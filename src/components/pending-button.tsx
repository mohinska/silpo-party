"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { pendingButtonState } from "./pending-button-state";

type PendingButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  children: ReactNode;
  pendingLabel?: string;
};

export function PendingButton({
  children,
  pendingLabel = "Зачекайте…",
  disabled,
  ...props
}: PendingButtonProps) {
  const { pending } = useFormStatus();
  const label = typeof children === "string" ? children : "Дія";
  const state = pendingButtonState({
    pending,
    disabled,
    label,
    pendingLabel,
  });

  return (
    <button {...props} type={props.type ?? "submit"} disabled={state.disabled}>
      {pending && <span className="button-spinner" aria-hidden="true" />}
      <span>{pending ? state.label : children}</span>
    </button>
  );
}
