import { z, type ZodType } from "zod";

import {
  PlanningInvalidJsonError,
  PlanningSchemaValidationError,
} from "./errors";

export type JsonTextGenerationRequest = {
  system: string;
  prompt: string;
};

export type JsonTextGenerator = (
  request: JsonTextGenerationRequest,
) => Promise<string>;

function parseJson(responseText: string): unknown {
  try {
    return JSON.parse(responseText) as unknown;
  } catch (error) {
    throw new PlanningInvalidJsonError(responseText, error);
  }
}

function validateJson<T>(value: unknown, schema: ZodType<T>): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PlanningSchemaValidationError(result.error);
  }
  return result.data;
}

function correctionFor(error: unknown, responseText: string): string {
  if (error instanceof PlanningSchemaValidationError) {
    return `The previous JSON did not match the required schema. Correct it and return the complete JSON object again. Validation errors:\n${JSON.stringify(error.issues)}\nPrevious JSON:\n${responseText}`;
  }

  return `The previous response was not valid JSON. Return a complete corrected JSON object matching the supplied schema. Previous response:\n${responseText}`;
}

export async function generateValidatedJson<T>({
  generateJsonText,
  system,
  prompt,
  schema,
}: {
  generateJsonText: JsonTextGenerator;
  system: string;
  prompt: string;
  schema: ZodType<T>;
}): Promise<T> {
  const schemaInstruction = `Return only one complete JSON object with no Markdown or commentary. The JSON must match this JSON Schema exactly:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  let requestPrompt = prompt;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const responseText = await generateJsonText({
      system: `${system}\n\n${schemaInstruction}`,
      prompt: requestPrompt,
    });

    try {
      return validateJson(parseJson(responseText), schema);
    } catch (error) {
      if (
        attempt === 1 ||
        !(error instanceof PlanningInvalidJsonError) &&
          !(error instanceof PlanningSchemaValidationError)
      ) {
        throw error;
      }
      requestPrompt = `${prompt}\n\n${correctionFor(error, responseText)}`;
    }
  }

  throw new Error("JSON generation exhausted its validation attempts.");
}
