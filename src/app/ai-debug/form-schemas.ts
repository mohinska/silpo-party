import { z } from "zod";

export const DebugCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/);

// Parse decimal text directly so monetary input never rounds a fractional cent.
export const DebugBudgetSchema = z.preprocess(
  (value) => value == null ? "" : value,
  z.string().trim().regex(/^(?:\d+(?:\.\d{1,2})?)?$/).transform((value) => {
    if (!value) return null;
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()),
);
