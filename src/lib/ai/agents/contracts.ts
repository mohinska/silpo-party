import { z } from "zod";

const Text = z.string().trim().min(1).max(500);
const Id = z.string().trim().min(1).max(200);

export const AgentEvidenceSchema = z.object({
  id: Id,
  source: z.enum(["declared", "silpo_mcp", "recipe_source", "agent"]),
  tool: Text.optional(),
  payload: z.string().max(5_000).optional(),
}).strict();

export const IntentDeltaSchema = z.object({
  kind: z.enum(["dish", "recipe", "product_request", "change", "remove", "question", "none"]),
  dishName: Text.optional(),
  recipeUrl: z.url().optional(),
  additions: z.array(Text).max(30).default([]),
  removals: z.array(Text).max(30).default([]),
  modifications: z.array(Text).max(30).default([]),
  servings: z.number().int().positive().max(100).optional(),
  confidence: z.number().min(0).max(1),
  clarification: Text.optional(),
}).strict();

export const ProductCandidateSchema = z.object({
  productId: Id,
  companyId: Id,
  branchId: Id,
  name: Text,
  packageQuantity: z.number().positive(),
  packageUnit: z.enum(["g", "ml", "piece"]),
  priceCents: z.number().int().nonnegative(),
  available: z.literal(true),
  match: z.enum(["exact", "variant", "partial"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(AgentEvidenceSchema).min(1).max(10),
}).strict();

export const SupervisorActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("parse_intent") }).strict(),
  z.object({ type: z.literal("load_context"), participantIds: z.array(Id).min(1).max(10) }).strict(),
  z.object({ type: z.literal("resolve_recipe"), dishName: Text, recipeUrl: z.url().optional() }).strict(),
  z.object({ type: z.literal("normalize_ingredients") }).strict(),
  z.object({ type: z.literal("search_products"), requirementIds: z.array(Id).min(1).max(100) }).strict(),
  z.object({ type: z.literal("build_basket") }).strict(),
  z.object({ type: z.literal("review_constraints") }).strict(),
  z.object({ type: z.literal("ask_user"), question: Text }).strict(),
  z.object({ type: z.literal("publish_proposal") }).strict(),
]);

export const SupervisorDecisionSchema = z.object({
  actions: z.array(SupervisorActionSchema).min(1).max(12),
  reply: Text.max(1_000),
}).strict();

export type AgentEvidence = z.infer<typeof AgentEvidenceSchema>;
export type IntentDelta = z.infer<typeof IntentDeltaSchema>;
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;
export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;
