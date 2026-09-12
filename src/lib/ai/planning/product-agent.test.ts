import { describe, expect, it } from "vitest";

import { rankCatalogCandidates } from "./product-agent";

describe("Silpo product agent ranking", () => {
  it("prefers an exact available variant over the first partial result", () => {
    const result = rankCatalogCandidates({ name: "молоко", variant: "2.5%" }, [
      { productId: "partial", companyId: "c", branchId: "b", name: "Напій молочний 1.5%", packageQuantity: 900, packageUnit: "ml", priceCents: 3000, available: true, dietarySafety: "safe" },
      { productId: "exact", companyId: "c", branchId: "b", name: "Молоко 2.5% пастеризоване", packageQuantity: 900, packageUnit: "ml", priceCents: 4200, available: true, dietarySafety: "safe" },
    ]);
    expect(result[0].productId).toBe("exact");
  });

  it("rejects unavailable and unsafe candidates", () => {
    const result = rankCatalogCandidates({ name: "йогурт" }, [
      { productId: "out", companyId: "c", branchId: "b", name: "Йогурт", packageQuantity: 400, packageUnit: "g", priceCents: 1000, available: false, dietarySafety: "safe" },
      { productId: "unsafe", companyId: "c", branchId: "b", name: "Йогурт", packageQuantity: 400, packageUnit: "g", priceCents: 1000, available: true, dietarySafety: "unsafe" },
    ]);
    expect(result).toEqual([]);
  });
});
