import { z } from "zod";

export const UnitSchema = z.enum(["g", "ml", "piece"]);
export type Unit = z.infer<typeof UnitSchema>;

export const RecipeIngredientSchema = z.object({
  name: z.string().trim().min(1).max(160),
  quantity: z.number().finite().positive(),
  unit: z.enum(["g", "kg", "ml", "l", "piece", "tbsp", "tsp"]),
  variant: z.string().trim().min(1).max(100).default("standard"),
  optional: z.boolean().default(false),
}).strict();

export const RecipeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  source: z.object({
    provider: z.enum(["silpo", "participant", "publisher"]),
    url: z.url(),
    title: z.string().min(1),
    retrievedAt: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
  baseServings: z.number().int().positive(),
  ingredients: z.array(RecipeIngredientSchema).min(1),
}).strict();

export const MergedIngredientSchema = z.object({
  key: z.string().min(1), name: z.string().min(1), canonicalName: z.string().min(1),
  variant: z.string().min(1), quantity: z.number().positive(), unit: UnitSchema,
  optional: z.boolean(), dishIds: z.array(z.string().min(1)).min(1), readyMeal: z.boolean().optional(),
}).strict();

export const CatalogProductSchema = z.object({
  productId: z.string().min(1), companyId: z.string().min(1), branchId: z.string().min(1),
  name: z.string().min(1), packageQuantity: z.number().positive(), packageUnit: UnitSchema,
  priceCents: z.number().int().nonnegative(), available: z.boolean(),
  dietarySafety: z.enum(["safe", "uncertain", "unsafe"]), readyMeal: z.boolean().optional(),
  productUrl: z.url().optional(), imageUrl: z.url().optional(),
}).strict();

export const ProductLineSchema = z.object({
  requirementKeys: z.array(z.string().min(1)).min(1), productId: z.string().min(1),
  companyId: z.string().min(1), branchId: z.string().min(1), name: z.string().min(1),
  packageCount: z.number().int().positive(), packageQuantity: z.number().positive(), packageUnit: UnitSchema,
  unitPriceCents: z.number().int().nonnegative(), lineTotalCents: z.number().int().nonnegative(),
}).strict();

export const MealProposalSchema = z.object({
  id: z.string().min(1), partyId: z.string().min(1),
  status: z.enum(["pending", "rejected", "applying", "applied", "failed"]),
  currency: z.literal("UAH"), budgetCents: z.number().int().nonnegative(),
  dishes: z.array(z.object({ id: z.string(), name: z.string(), eaterParticipantIds: z.array(z.string()), servings: z.number().int().positive(), recipeId: z.string().optional(), readyMeal: z.boolean().default(false) }).strict()),
  recipes: z.array(RecipeSchema), mergedIngredients: z.array(MergedIngredientSchema), productLines: z.array(ProductLineSchema),
  estimatedTotalCents: z.number().int().nonnegative(), budgetStatus: z.enum(["within", "over", "unresolved"]),
  alternatives: z.array(z.object({ kind: z.enum(["increase_budget", "replace_sku", "remove_optional", "adjust_portions"]), description: z.string().min(1), amountCents: z.number().int().nonnegative().optional() }).strict()),
  unresolved: z.array(z.object({ requirementKey: z.string(), reason: z.string() }).strict()),
  createdAt: z.iso.datetime({ offset: true }), error: z.string().optional(),
}).strict();

export type Recipe = z.infer<typeof RecipeSchema>;
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;
export type MergedIngredient = z.infer<typeof MergedIngredientSchema>;
export type ProductLine = z.infer<typeof ProductLineSchema>;
export type MealProposal = z.infer<typeof MealProposalSchema>;
