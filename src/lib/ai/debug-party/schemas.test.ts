import { describe, expect, it } from "vitest";

import {
  DebugCartItemSchema,
  DebugParticipantContextSchema,
  DebugPartySchema,
  FoodRequestSchema,
  SupervisorRequestSchema,
} from "./schemas";

const party = {
  id: "party-1",
  code: "ABCDEFGH",
  hostId: "user-host",
  budgetCents: 250000,
  status: "collecting" as const,
  cartRevision: 0,
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
};

const line = {
  id: "cart-item-1",
  partyId: "party-1",
  productId: "product-1",
  companyId: "company-1",
  branchId: "branch-1",
  name: "Сир",
  quantity: 1,
  unit: "шт",
  unitPriceCents: 8999,
  discountCents: null,
  imageUrl: null,
  evidenceId: "evidence-1",
  observedAt: "2026-09-10T09:00:00.000Z",
  introducedRevision: 1,
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
};

const context = {
  id: "context-1",
  partyId: "party-1",
  participantId: "user-member",
  intentRevision: 1,
  contextStatus: "ready" as const,
  purchaseHistoryStatus: "available" as const,
  dietaryRestrictions: [],
  favorites: [],
  recentProducts: [
    {
      productId: "product-1",
      name: "Сир",
      evidenceId: "evidence-1",
    },
  ],
  summary: "Любить сир.",
  collectedAt: "2026-09-10T09:00:00.000Z",
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
};

describe("debug-party schemas", () => {
  it("accepts a null budget when the Host has not supplied one", () => {
    expect(DebugPartySchema.parse({ ...party, budgetCents: null }).budgetCents).toBeNull();
  });

  it("rejects a negative party budget", () => {
    expect(() => DebugPartySchema.parse({ ...party, budgetCents: -1 })).toThrow();
  });

  it("requires verified evidence for each local-cart line", () => {
    expect(() => DebugCartItemSchema.parse({ ...line, evidenceId: undefined })).toThrow();
  });

  it("limits a participant's recent products to five", () => {
    const six = Array.from({ length: 6 }, (_, index) => ({
      productId: `product-${index}`,
      name: `Продукт ${index}`,
      evidenceId: `evidence-${index}`,
    }));

    expect(() => DebugParticipantContextSchema.parse({ ...context, recentProducts: six })).toThrow();
  });

  it("limits food requests to a compact supervisor-safe length", () => {
    expect(() => FoodRequestSchema.parse("x".repeat(2001))).toThrow();
  });

  it("rejects unknown keys at the party boundary", () => {
    expect(() => DebugPartySchema.parse({ ...party, injected: true })).toThrow();
  });

  it("accepts only strict supervisor request variants", () => {
    expect(
      SupervisorRequestSchema.parse({
        mode: "preprocess",
        partyId: "party-1",
        participantId: "user-member",
        intentRevision: 1,
      }),
    ).toMatchObject({ mode: "preprocess" });

    expect(() =>
      SupervisorRequestSchema.parse({
        mode: "build",
        partyId: "party-1",
        actorId: "user-host",
        unexpected: true,
      }),
    ).toThrow();
  });
});
