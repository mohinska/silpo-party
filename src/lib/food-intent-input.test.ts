import { describe, expect, it } from "vitest";
import { parseFoodIntentInput } from "./food-intent-input";

describe("parseFoodIntentInput", () => {
  it("treats a URL as a recipe input", () => {
    expect(parseFoodIntentInput(" https://example.com/recipe ")).toEqual({ dishName: "", description: "", contentUrl: "https://example.com/recipe", indifferent: false });
  });

  it("treats ordinary text as a dish wish", () => {
    expect(parseFoodIntentInput("Паста без грибів")).toEqual({ dishName: "Паста без грибів", description: "", contentUrl: "", indifferent: false });
  });
});
