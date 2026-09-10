import { z } from "zod";

const NonEmptyText = z.string().trim().min(1);
const BoundedText = NonEmptyText.max(500);
const Id = NonEmptyText.max(200);
const Timestamp = z.iso.datetime({ offset: true });
const NonNegativeInteger = z.number().int().nonnegative();
const PositiveInteger = z.number().int().positive();
const NonNegativeCents = NonNegativeInteger;

export const FoodRequestSchema = BoundedText;

export const DebugPartyStatusSchema = z.enum([
  "collecting",
  "ready",
  "running",
  "finalized",
  "sent",
]);

export const DebugContextStatusSchema = z.enum([
  "pending",
  "running",
  "ready",
  "failed",
]);

export const DebugPartySchema = z.strictObject({
  id: Id,
  code: z.string().regex(/^[A-Z0-9]{8}$/),
  hostId: Id,
  budgetCents: NonNegativeCents.nullable(),
  status: DebugPartyStatusSchema,
  cartRevision: NonNegativeInteger,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const DebugPartyMemberSchema = z.strictObject({
  partyId: Id,
  participantId: Id,
  role: z.enum(["host", "member"]),
  contextStatus: DebugContextStatusSchema,
  joinedAt: Timestamp,
  updatedAt: Timestamp,
});

export const DebugFoodIntentSchema = z.strictObject({
  id: Id,
  partyId: Id,
  participantId: Id,
  request: FoodRequestSchema,
  revision: PositiveInteger,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const DebugContextFactSchema = z.strictObject({
  label: BoundedText,
  evidenceId: Id.optional(),
});

export const DebugRecentProductSchema = z.strictObject({
  productId: Id,
  name: BoundedText,
  evidenceId: Id,
});

export const DebugParticipantContextSchema = z.strictObject({
  id: Id,
  partyId: Id,
  participantId: Id,
  intentRevision: PositiveInteger,
  contextStatus: DebugContextStatusSchema,
  purchaseHistoryStatus: z.enum(["available", "unavailable"]),
  dietaryRestrictions: z.array(DebugContextFactSchema).max(30),
  favorites: z.array(DebugContextFactSchema).max(30),
  recentProducts: z.array(DebugRecentProductSchema).max(5),
  summary: BoundedText,
  collectedAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const DebugProductEvidenceSourceSchema = z.enum([
  "recent_purchase",
  "catalog_search",
  "product_detail",
]);

export const DebugProductEvidenceSchema = z.strictObject({
  id: Id,
  partyId: Id,
  runId: Id,
  source: DebugProductEvidenceSourceSchema,
  productId: Id,
  companyId: Id,
  branchId: Id,
  name: BoundedText,
  unit: BoundedText,
  unitPriceCents: NonNegativeCents,
  discountCents: NonNegativeCents.nullable(),
  imageUrl: z.url().nullable(),
  available: z.boolean(),
  observedAt: Timestamp,
  createdAt: Timestamp,
});

export const DebugCartItemSchema = z.strictObject({
  id: Id,
  partyId: Id,
  productId: Id,
  companyId: Id,
  branchId: Id,
  name: BoundedText,
  quantity: z.number().finite().positive(),
  unit: BoundedText,
  unitPriceCents: NonNegativeCents,
  discountCents: NonNegativeCents.nullable(),
  imageUrl: z.url().nullable(),
  evidenceId: Id,
  observedAt: Timestamp,
  introducedRevision: PositiveInteger,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const DebugCartSnapshotItemSchema = z.strictObject({
  id: Id,
  snapshotId: Id,
  productId: Id,
  companyId: Id,
  branchId: Id,
  name: BoundedText,
  quantity: z.number().finite().positive(),
  unit: BoundedText,
  unitPriceCents: NonNegativeCents,
  discountCents: NonNegativeCents.nullable(),
  imageUrl: z.url().nullable(),
  evidenceId: Id,
  observedAt: Timestamp,
  createdAt: Timestamp,
});

export const DebugCartSnapshotSchema = z.strictObject({
  id: Id,
  partyId: Id,
  cartRevision: NonNegativeInteger,
  totalCents: NonNegativeCents,
  finalizedAt: Timestamp,
  items: z.array(DebugCartSnapshotItemSchema).min(1).max(100),
});

export const SupervisorRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("preprocess"),
    partyId: Id,
    participantId: Id,
    intentRevision: PositiveInteger,
  }),
  z.strictObject({
    mode: z.literal("build"),
    partyId: Id,
    actorId: Id,
  }),
  z.strictObject({
    mode: z.literal("chat"),
    partyId: Id,
    actorId: Id,
    messageId: Id,
  }),
]);

export type FoodRequest = z.infer<typeof FoodRequestSchema>;
export type DebugPartyStatus = z.infer<typeof DebugPartyStatusSchema>;
export type DebugContextStatus = z.infer<typeof DebugContextStatusSchema>;
export type DebugParty = z.infer<typeof DebugPartySchema>;
export type DebugPartyMember = z.infer<typeof DebugPartyMemberSchema>;
export type DebugFoodIntent = z.infer<typeof DebugFoodIntentSchema>;
export type DebugParticipantContext = z.infer<typeof DebugParticipantContextSchema>;
export type DebugRecentProduct = z.infer<typeof DebugRecentProductSchema>;
export type DebugProductEvidenceSource = z.infer<
  typeof DebugProductEvidenceSourceSchema
>;
export type DebugProductEvidence = z.infer<typeof DebugProductEvidenceSchema>;
export type DebugCartItem = z.infer<typeof DebugCartItemSchema>;
export type DebugCartSnapshotItem = z.infer<typeof DebugCartSnapshotItemSchema>;
export type DebugCartSnapshot = z.infer<typeof DebugCartSnapshotSchema>;
export type SupervisorRequest = z.infer<typeof SupervisorRequestSchema>;
