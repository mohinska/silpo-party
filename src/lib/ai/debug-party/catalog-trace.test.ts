import { describe, expect, it } from "vitest";
import { catalogSearchTrace } from "./catalog-trace";

describe("catalog trace", () => {
  it("keeps only safe candidate-preselection verdicts", () => {
    const trace = catalogSearchTrace({
      mcpTool: "silpo_find_products_batch",
      queries: ["молоко"],
      candidates: [{
        productId: "milk", name: "Молоко", unit: "900 г", unitPriceCents: 5699, discountCents: null, available: true, evidenceId: "evidence",
        preselection: { evidenceId: "evidence", verdict: "match", reason: "Звичайне молоко.", hiddenThought: "private" },
      }],
      preselection: {
        status: "completed",
        normalizedIntent: { productKind: "молоко", requestedAttributes: [], exclusions: ["вершки"], rawModelResponse: "private" },
      },
    });

    expect(trace).toMatchObject({
      preselection: { status: "completed", normalizedIntent: { productKind: "молоко", exclusions: ["вершки"] } },
      candidates: [{ preselection: { evidenceId: "evidence", verdict: "match", reason: "Звичайне молоко." } }],
    });
    expect(JSON.stringify(trace)).not.toMatch(/private|rawModelResponse/i);
  });

  it("keeps compact catalog candidates while stripping secrets and raw transport fields", () => {
    const trace = catalogSearchTrace({
      mcpTool: "silpo_find_products_batch",
      queries: ["Lacmi кокос"],
      candidates: [{ productId: "lacmi", name: "Lacmi кокос", unit: "80 г", unitPriceCents: 5500, discountCents: 500, available: true, evidenceId: "evidence" }],
      accessToken: "secret-token",
      address: { street: "private street" },
      raw: { authorization: "Bearer secret-token" },
    });

    expect(trace).toEqual({ type: "catalog.response", mcpTool: "silpo_find_products_batch", queries: ["Lacmi кокос"], candidates: [
      { productId: "lacmi", name: "Lacmi кокос", unit: "80 г", unitPriceCents: 5500, discountCents: 500, available: true, evidenceId: "evidence" },
    ] });
    expect(JSON.stringify(trace)).not.toMatch(/secret|private|authorization/i);
  });
});
