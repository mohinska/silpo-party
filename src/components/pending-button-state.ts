export function pendingButtonState({
  pending,
  disabled,
  label,
  pendingLabel,
}: {
  pending: boolean;
  disabled?: boolean;
  label: string;
  pendingLabel: string;
}) {
  return {
    disabled: Boolean(disabled || pending),
    label: pending ? pendingLabel : label,
  };
}
