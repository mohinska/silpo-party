"use client";

import { useState, useTransition } from "react";
import { updateItem } from "@/app/parties/actions";

function formatMoney(cents: number) {
  return new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH" }).format(cents / 100);
}

type QuantityEditorProps = {
  code: string;
  itemId: string;
  name: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  disabled: boolean;
};

export function QuantityEditor({ code, itemId, name, quantity: initialQuantity, unit, unitPriceCents, disabled }: QuantityEditorProps) {
  const [quantity, setQuantity] = useState(String(initialQuantity));
  const [savedQuantity, setSavedQuantity] = useState(initialQuantity);
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();
  const parsedQuantity = Number(quantity);
  const isValid = Number.isInteger(parsedQuantity) && parsedQuantity > 0;
  const totalCents = isValid ? Math.round(unitPriceCents * parsedQuantity) : null;

  function saveQuantity() {
    if (!isValid) {
      setMessage("Вкажіть додатну цілу кількість.");
      return;
    }
    if (parsedQuantity === savedQuantity) return;
    setMessage(null);
    startSaving(async () => {
      try {
        const formData = new FormData();
        formData.set("name", name);
        formData.set("quantity", String(parsedQuantity));
        await updateItem(code, itemId, formData);
        setSavedQuantity(parsedQuantity);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Не вдалося зберегти кількість.");
      }
    });
  }

  return (
    <div className="item-numbers quantity-editor">
      <input
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
        onBlur={saveQuantity}
        type="number"
        min="1"
        step="1"
        inputMode="numeric"
        disabled={disabled}
        aria-label="Кількість"
      />
      <span aria-label="Одиниця">{unit}</span>
      <span>{unitPriceCents ? formatMoney(unitPriceCents) : "Ціну визначить Сільпо"}</span>
      <strong aria-live="polite">{totalCents === null ? "—" : formatMoney(totalCents)}</strong>
      {(isSaving || message) && <small className={message ? "quantity-message error" : "quantity-message"}>{message ?? "Зберігаємо…"}</small>}
    </div>
  );
}
