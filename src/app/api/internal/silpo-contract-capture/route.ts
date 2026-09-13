import "server-only";
import { z } from "zod";
import { getAccessToken } from "@/lib/silpo/oauth";
import { openSilpoMcpSessionWithAccessToken } from "@/lib/silpo/mcp";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({ userId: z.string().uuid() }).strict();

function authorized(request: Request) {
  const secret = process.env.AGENT_WORKER_SECRET;
  const value = request.headers.get("authorization");
  return Boolean(secret && value === `Bearer ${secret}`);
}

const scalarKeys = new Set(["type", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "additionalProperties"]);

// Structural schema only. Prose, defaults, examples and arbitrary enum/const/
// pattern values can carry personal data and are dropped, never returned.
function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 30 || !value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (scalarKeys.has(key) && ["string", "number", "boolean"].includes(typeof item)) {
      if (typeof item !== "string" || /^[A-Za-z0-9_-]{1,40}$/.test(item)) result[key] = item;
    } else if (["properties", "$defs", "definitions"].includes(key) && item && typeof item === "object" && !Array.isArray(item)) {
      result[key] = Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([name]) => /^[A-Za-z_$][A-Za-z0-9_$-]{0,100}$/.test(name))
          .map(([name, schema]) => [name, sanitizeSchema(schema, depth + 1)]),
      );
    } else if (key === "required" && Array.isArray(item)) {
      result.required = item.filter((name) => typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$-]{0,100}$/.test(name));
    } else if (["items", "additionalProperties"].includes(key) && item && typeof item === "object") {
      result[key] = sanitizeSchema(item, depth + 1);
    } else if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(item)) {
      result[key] = item.map((schema) => sanitizeSchema(schema, depth + 1));
    } else if (key === "enum" && Array.isArray(item)) {
      result["x-values-redacted"] = true;
    } else if (["const", "pattern", "$ref"].includes(key)) {
      result["x-values-redacted"] = true;
    }
  }
  return result;
}

// Read-only: lists tool schemas only, never calls a tool or touches a cart.
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = RequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!body.success) return Response.json({ error: "userId required" }, { status: 400 });
  const accessToken = await getAccessToken(body.data.userId);
  if (!accessToken) return Response.json({ error: "No Silpo connection for that user." }, { status: 404 });
  const session = await openSilpoMcpSessionWithAccessToken(accessToken);
  try {
    const tools = [...session.tools.values()]
      .filter((tool) => /^silpo_[a-z0-9_]{1,100}$/.test(tool.name))
      .map((tool) => ({
        name: tool.name,
        inputSchema: sanitizeSchema(tool.inputSchema),
        outputSchema: "outputSchema" in tool ? sanitizeSchema((tool as { outputSchema?: unknown }).outputSchema) : undefined,
      }));
    return Response.json({ capturedAt: new Date().toISOString(), provenance: "authenticated-tools-list-sanitized", tools });
  } finally {
    await session.close();
  }
}
