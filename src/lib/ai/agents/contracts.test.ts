import { describe, expect, it } from "vitest";

import {
  AgentEvidenceSchema,
  IntentDeltaSchema,
  ProductCandidateSchema,
  SupervisorDecisionSchema,
} from "./contracts";

describe("agent contracts", () => {
  it("keeps intent changes explicit and bounded", () => {
    expect(IntentDeltaSchema.parse({
      kind: "change",
      additions: ["молоко"],
      removals: ["вершки"],
      confidence: 0.9,
    })).toMatchObject({ kind: "change", removals: ["вершки"] });
  });

  it("requires evidence before a product can be selected", () => {
    expect(() => ProductCandidateSchema.parse({
      productId: "sku-1",
      companyId: "company-1",
      branchId: "branch-1",
      name: "Молоко 2.5%",
      packageQuantity: 900,
      packageUnit: "ml",
      priceCents: 4299,
      available: true,
      match: "exact",
      confidence: 0.98,
      evidence: [],
    })).toThrow();
  });

  it("accepts a supervisor decision only with known typed actions", () => {
    const decision = SupervisorDecisionSchema.parse({
      actions: [{ type: "search_products", requirementIds: ["ingredient-1"] }],
      reply: "Шукаю потрібні товари в магазині організатора.",
    });
    expect(decision.actions[0]).toEqual({ type: "search_products", requirementIds: ["ingredient-1"] });
  });

  it("bounds evidence metadata", () => {
    expect(() => AgentEvidenceSchema.parse({
      id: "evidence-1",
      source: "silpo_mcp",
      tool: "silpo_find_products_batch",
      payload: "x".repeat(5001),
    })).toThrow();
  });
});
