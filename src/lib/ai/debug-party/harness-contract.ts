import { z } from "zod";
import { CatalogTraceSchema } from "./catalog-trace";

export const DebugHarnessTraceSchema = z.strictObject({
  toolName: z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/),
  status: z.enum(["completed", "failed"]),
  durationMs: z.number().int().nonnegative(),
  trace: CatalogTraceSchema.nullable(),
  selectedEvidenceId: z.string().trim().min(1).max(200).nullable(),
  errorCode: z.string().regex(/^[A-Z0-9_-]{1,80}$/).nullable(),
  recipe: z.object({
    title: z.string().trim().min(1).max(300),
    sourceUrl: z.url().nullable(),
    servings: z.number().int().positive(),
    ingredients: z.array(z.strictObject({
      name: z.string().trim().min(1).max(160), quantity: z.number().finite().positive(), unit: z.enum(["g", "kg", "ml", "l", "piece", "tbsp", "tsp"]), optional: z.boolean(),
    })).min(1).max(100),
  }).nullable(),
});

export type DebugHarnessTrace = z.infer<typeof DebugHarnessTraceSchema>;
