import { IntentDeltaSchema, type IntentDelta } from "./contracts";
import { generateValidatedJson } from "../planning/structured-output";

export type IntentGenerationAdapter = (request: {
  system: string;
  prompt: string;
}) => Promise<string>;

const INTENT_SYSTEM = `You are a Ukrainian grocery-party intent parser. Extract only what the participant explicitly says. Never invent quantities, allergies, products, or recipes. A removal is not an addition. Return a concise structured intent delta.`;

function fallbackIntent(message: string): IntentDelta {
  const text = message.trim();
  const lower = text.toLocaleLowerCase("uk-UA");
  const removals = [...text.matchAll(/(?:без|прибери|прибрати|не додавай|не хочу)\s+([^,.;\n]+)/giu)]
    .map((match) => match[1].trim()).filter(Boolean);
  const additionsText = text
    .replace(/(?:без|прибери|прибрати|не додавай|не хочу)\s+[^,.;\n]+/giu, "")
    .replace(/^(?:додай|додати|хочу|потрібно|купити)\s+/iu, "");
  const additions = additionsText.split(/[,;+\n]|\s+і\s+/iu).map((value) => value.trim()).filter((value) => value.length > 1);
  const recipeUrl = text.match(/https?:\/\/[^\s]+/iu)?.[0];
  const servings = lower.match(/(?:на|для)\s+(\d+)\s*(?:людей|осіб|порц)/iu)?.[1];
  const kind = recipeUrl ? "recipe" : removals.length ? "change" : additions.length > 0 ? "product_request" : "question";
  return IntentDeltaSchema.parse({ kind, recipeUrl, additions, removals, modifications: [], servings: servings ? Number(servings) : undefined, confidence: 0.45 });
}

export async function parseIntentDelta(message: string, options?: { generate?: IntentGenerationAdapter }): Promise<IntentDelta> {
  const text = message.trim().slice(0, 2_000);
  if (!text) return IntentDeltaSchema.parse({ kind: "none", confidence: 1 });
  if (!options?.generate) return fallbackIntent(text);
  try {
    return await generateValidatedJson({
      generateJsonText: options.generate,
      system: INTENT_SYSTEM,
      prompt: JSON.stringify({ message: text }),
      schema: IntentDeltaSchema,
    });
  } catch {
    return fallbackIntent(text);
  }
}

export type StoredIntent = {
  dishName: string;
  description: string;
  contentUrl: string;
  indifferent: boolean;
};

export function applyIntentDelta(delta: IntentDelta, current: StoredIntent): StoredIntent {
  const additions = delta.additions.join(", ");
  const removals = delta.removals.length ? `Виключити: ${delta.removals.join(", ")}` : "";
  const modifications = delta.modifications.length ? `Зміни: ${delta.modifications.join(", ")}` : "";
  const fragments = [current.description, additions && `Додати: ${additions}`, removals, modifications].filter(Boolean);
  return {
    dishName: delta.dishName ?? current.dishName,
    description: fragments.join("\n").slice(0, 1_000),
    contentUrl: delta.recipeUrl ?? current.contentUrl,
    indifferent: delta.kind === "none" ? current.indifferent : false,
  };
}
