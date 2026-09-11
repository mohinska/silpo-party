import { describe, expect, it } from "vitest";
import { preselectCandidates } from "./candidate-preselector";

const input = {
  request: "додай звичайне молоко в кошик",
  queries: ["молоко"],
  constraints: { dietaryRestrictions: [], favorites: [], recentProductNames: [] },
  candidates: [
    { evidenceId: "ordinary", productId: "ordinary", name: "Молоко «Галичина» ультрапастеризоване 3,2%", unit: "900 г", unitPriceCents: 5699, discountCents: 1100, available: true, source: "catalog_search" as const },
    { evidenceId: "cream", productId: "cream", name: "Вершки «Галичина» ультрапастеризовані 10%", unit: "500 г", unitPriceCents: 8999, discountCents: null, available: true, source: "catalog_search" as const },
  ],
};

describe("candidate preselector", () => {
  it("keeps ordinary milk while excluding incompatible milk forms", async () => {
    const result = await preselectCandidates(input, async () => ({
      normalizedIntent: { productKind: "молоко", requestedAttributes: [], exclusions: ["вершки", "дитяче"] },
      verdicts: [
        { evidenceId: "ordinary", verdict: "match", reason: "Звичайне питне молоко." },
        { evidenceId: "cream", verdict: "exclude", reason: "Це вершки, а не молоко." },
      ],
    }));

    expect(result.status).toBe("completed");
    expect(result.verdicts).toEqual([
      { evidenceId: "ordinary", verdict: "match", reason: "Звичайне питне молоко." },
      { evidenceId: "cream", verdict: "exclude", reason: "Це вершки, а не молоко." },
    ]);
  });

  it.each([
    [{ evidenceId: "unknown", verdict: "match", reason: "Помилковий id." }],
    [
      { evidenceId: "ordinary", verdict: "match", reason: "Перше." },
      { evidenceId: "ordinary", verdict: "match", reason: "Повтор." },
    ],
    [{ evidenceId: "ordinary", verdict: "match", reason: "Немає другого." }],
  ])("fails open for invalid verdict coverage", async (verdicts) => {
    const result = await preselectCandidates(input, async () => ({
      normalizedIntent: { productKind: "молоко", requestedAttributes: [], exclusions: [] },
      verdicts,
    }));

    expect(result.status).toBe("invalid");
    expect(result.verdicts).toEqual([
      { evidenceId: "ordinary", verdict: "unclassified", reason: "Попередній відбір недоступний." },
      { evidenceId: "cream", verdict: "unclassified", reason: "Попередній відбір недоступний." },
    ]);
  });

  it("keeps an explicitly requested lactose-free form", async () => {
    const result = await preselectCandidates({
      ...input,
      request: "додай безлактозне молоко",
      candidates: [{ ...input.candidates[0], evidenceId: "lactose-free", name: "Молоко безлактозне «На здоров'я» 2,5%" }],
    }, async () => ({
      normalizedIntent: { productKind: "молоко", requestedAttributes: ["безлактозне"], exclusions: [] },
      verdicts: [{ evidenceId: "lactose-free", verdict: "match", reason: "Запитано безлактозний варіант." }],
    }));

    expect(result).toMatchObject({ status: "completed", verdicts: [{ evidenceId: "lactose-free", verdict: "match" }] });
  });

  it("normalizes the legacy classification contract returned by the provider", async () => {
    const result = await preselectCandidates(input, async () => ({
      primaryProductType: "молоко",
      requestedForm: "звичайне",
      classifications: [
        { evidenceId: "ordinary", class: "match", reason: "Питне молоко." },
        { evidenceId: "cream", class: "exclude", reason: "Це вершки." },
      ],
    }));

    expect(result).toEqual({
      status: "completed",
      normalizedIntent: { productKind: "молоко", requestedAttributes: ["звичайне"], exclusions: [] },
      verdicts: [
        { evidenceId: "ordinary", verdict: "match", reason: "Питне молоко." },
        { evidenceId: "cream", verdict: "exclude", reason: "Це вершки." },
      ],
    });
  });
});
