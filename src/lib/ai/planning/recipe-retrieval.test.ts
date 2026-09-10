import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { parseRecipeDocument, retrieveRecipe } from "./recipe-retrieval";

describe("recipe provenance", () => {
  it("extracts a complete sourced recipe without inventing fields", () => {
    const html = `<h1>Паста</h1><p>на 4 порції</p><ul>
      <li data-autotestid="recipes-ingredient-item-0">Молоко <span>500 мл</span></li>
      <li data-autotestid="recipes-ingredient-item-1">Паста <span>300 г</span></li>
    </ul>`;
    const recipe = parseRecipeDocument(html, "https://silpo.ua/recipes/pasta");
    expect(recipe).toMatchObject({ title: "Паста", baseServings: 4, source: { provider: "silpo", url: "https://silpo.ua/recipes/pasta" } });
    expect(recipe.ingredients).toEqual([
      { name: "Молоко", quantity: 500, unit: "ml", variant: "standard", optional: false },
      { name: "Паста", quantity: 300, unit: "g", variant: "standard", optional: false },
    ]);
  });

  it("rejects incomplete pages instead of inferring recipe contents", () => {
    expect(() => parseRecipeDocument("<h1>Паста</h1>", "https://silpo.ua/recipes/pasta")).toThrow(/no recipe contents were inferred/i);
  });

  it("selects a relevant Silpo result instead of the first recipe link", async () => {
    const fetched: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("?search=")) return new Response('<a href="/recipes/pica"><span>Шкільна піца</span></a><a href="/recipes/pasta"><span>Паста болоньєзе</span></a>', { status: 200 });
      return new Response('<h1>Паста болоньєзе</h1><p>на 2 порції</p><li data-autotestid="recipes-ingredient-item-0">Паста <span>300 г</span></li>', { status: 200, headers: { "Content-Type": "text/html" } });
    });
    const recipe = await retrieveRecipe({ dishName: "паста" }, fetcher as typeof fetch);
    expect(recipe.title).toBe("Паста болоньєзе");
    expect(fetched[1]).toBe("https://silpo.ua/recipes/pasta");
  });
});
