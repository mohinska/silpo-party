import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { parseParticipantRecipeDetails, parseRecipeDocument, retrieveRecipe, retrieveRecipeForRequest } from "./recipe-retrieval";

describe("recipe provenance", () => {
  it("uses a complete ingredient list from participant details without requiring a URL", () => {
    const recipe = parseParticipantRecipeDetails({
      dishName: "Hawaiian pizza",
      details: "Ingredients:\nFlour 500 g\nCheese 200 g\nPineapple 150 g",
    });

    expect(recipe).toMatchObject({
      title: "Hawaiian pizza",
      baseServings: 1,
      source: {
        provider: "participant",
        title: "Ingredients supplied in participant request details",
      },
    });
    expect(recipe.source.url).toBeUndefined();
    expect(recipe.ingredients).toEqual([
      { name: "Flour", quantity: 500, unit: "g", variant: "standard", optional: false },
      { name: "Cheese", quantity: 200, unit: "g", variant: "standard", optional: false },
      { name: "Pineapple", quantity: 150, unit: "g", variant: "standard", optional: false },
    ]);
  });

  it("retains an explicitly supplied serving count from participant details", () => {
    const recipe = parseParticipantRecipeDetails({
      dishName: "Caesar salad",
      details: "For 2 servings; Lettuce 300 g; Chicken 400 g; Dressing 100 ml",
    });

    expect(recipe.baseServings).toBe(2);
    expect(recipe.ingredients).toHaveLength(3);
  });

  it("parses Ukrainian ingredient units from request details", () => {
    const recipe = parseParticipantRecipeDetails({
      dishName: "Pizza",
      details: "\u041d\u0430 2 \u043f\u043e\u0440\u0446\u0456\u0457; \u0411\u043e\u0440\u043e\u0448\u043d\u043e 500 \u0433; \u041c\u043e\u043b\u043e\u043a\u043e 400 \u043c\u043b",
    });

    expect(recipe.baseServings).toBe(2);
    expect(recipe.ingredients).toEqual([
      { name: "\u0411\u043e\u0440\u043e\u0448\u043d\u043e", quantity: 500, unit: "g", variant: "standard", optional: false },
      { name: "\u041c\u043e\u043b\u043e\u043a\u043e", quantity: 400, unit: "ml", variant: "standard", optional: false },
    ]);
  });

  it("prefers complete request details over an external recipe lookup", async () => {
    const fetcher = vi.fn(() => { throw new Error("external lookup must not run"); });
    const recipe = await retrieveRecipeForRequest({
      dishName: "Hawaiian pizza",
      details: "Flour 500 g; Cheese 200 g; Pineapple 150 g",
    }, fetcher as typeof fetch);

    expect(recipe.source.provider).toBe("participant");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats quantities without a serving label as totals for the planned servings", async () => {
    const recipe = await retrieveRecipeForRequest({
      dishName: "Hawaiian pizza",
      details: "Flour 500 g; Cheese 200 g",
      targetServings: 2,
    });

    expect(recipe.baseServings).toBe(2);
  });

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

  it("keeps quantified source ingredients while skipping taste-only notes", () => {
    const html = `<h1>Карбонара</h1><p>на 2 порції</p><ul>
      <li data-autotestid="recipes-ingredient-item-0">Спагеті <span>100 г</span></li>
      <li data-autotestid="recipes-ingredient-item-1">Яйця <span>3 шт</span></li>
      <li data-autotestid="recipes-ingredient-item-2">Сіль <span>за смаком</span></li>
      <li data-autotestid="recipes-ingredient-item-3">Перець чорний мелений <span>за смаком</span></li>
    </ul>`;

    expect(parseRecipeDocument(html, "https://silpo.ua/recipes/karbonara")).toMatchObject({
      title: "Карбонара", ingredients: [
        { name: "Спагеті", quantity: 100, unit: "g" },
        { name: "Яйця", quantity: 3, unit: "piece" },
      ],
    });
  });

  it("deduplicates quantified source facts repeated in recipe steps", () => {
    const html = `<h1>Карбонара</h1><p>на 2 порції</p><ul>
      <li data-autotestid="recipes-ingredient-item-0">Спагеті <span>100 г</span></li>
      <li data-autotestid="recipes-ingredient-item-1">Яйця <span>3 шт</span></li>
      <li data-autotestid="recipes-ingredient-item-2">Спагеті <span>100 г</span></li>
      <li data-autotestid="recipes-ingredient-item-3">Яйця <span>3 шт</span></li>
    </ul>`;

    expect(parseRecipeDocument(html, "https://silpo.ua/recipes/karbonara").ingredients).toEqual([
      { name: "Спагеті", quantity: 100, unit: "g", variant: "standard", optional: false },
      { name: "Яйця", quantity: 3, unit: "piece", variant: "standard", optional: false },
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
      if (url === "https://silpo.ua/recipes") return new Response('<a href="/recipes/pica"><span>Шкільна піца</span></a><a href="/recipes/pasta"><span>Паста болоньєзе</span></a>', { status: 200 });
      return new Response('<h1>Паста болоньєзе</h1><p>на 2 порції</p><li data-autotestid="recipes-ingredient-item-0">Паста <span>300 г</span></li>', { status: 200, headers: { "Content-Type": "text/html" } });
    });
    const recipe = await retrieveRecipe({ dishName: "паста" }, fetcher as typeof fetch);
    expect(recipe.title).toBe("Паста болоньєзе");
    expect(fetched[1]).toBe("https://silpo.ua/recipes/pasta");
  });

  it("tries the next relevant source card when the first one has no complete recipe", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://silpo.ua/recipes") return new Response('<a href="/recipes/first"><span>Паста карбонара</span></a><a href="/recipes/second"><span>Паста карбонара класична</span></a>', { status: 200 });
      if (url.endsWith("/first")) return new Response("<h1>Паста карбонара</h1>", { status: 200 });
      return new Response('<h1>Паста карбонара класична</h1><p>на 2 порції</p><li data-autotestid="recipes-ingredient-item-0">Паста <span>300 г</span></li>', { status: 200 });
    });

    await expect(retrieveRecipe({ dishName: "паста карбонара" }, fetcher as typeof fetch)).resolves.toMatchObject({ title: "Паста карбонара класична" });
    expect(fetcher).toHaveBeenCalledWith("https://silpo.ua/recipes/second", expect.objectContaining({
      cache: "no-store", headers: expect.objectContaining({ "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8" }),
    }));
  });
});
