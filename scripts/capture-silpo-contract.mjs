import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const scalarKeys = new Set(["type", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "additionalProperties"]);
const safeEnums = new Set(["g", "kg", "ml", "l", "piece", "tbsp", "tsp", "DeliveryHome", "WideAssortDelivery", "SelfPickup", "NovaPoshta", "B2B"]);
/** Capture structural contracts only; prose, defaults, examples and arbitrary
 * enum/const/pattern values can contain personal data and are not retained. */
function sanitizeSchema(value, depth = 0) {
  if (depth > 30 || !value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (scalarKeys.has(key) && ["string", "number", "boolean"].includes(typeof item)) {
      if (typeof item !== "string" || /^[A-Za-z0-9_-]{1,40}$/.test(item)) result[key] = item;
    } else if (["properties", "$defs", "definitions"].includes(key) && item && typeof item === "object" && !Array.isArray(item)) {
      result[key] = Object.fromEntries(Object.entries(item).filter(([name]) => /^[A-Za-z_$][A-Za-z0-9_$-]{0,100}$/.test(name)).map(([name, schema]) => [name, sanitizeSchema(schema, depth + 1)]));
    } else if (key === "required" && Array.isArray(item)) result.required = item.filter(name => typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$-]{0,100}$/.test(name));
    else if (["items", "additionalProperties"].includes(key) && item && typeof item === "object") result[key] = sanitizeSchema(item, depth + 1);
    else if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(item)) result[key] = item.map(schema => sanitizeSchema(schema, depth + 1));
    else if (key === "enum" && Array.isArray(item)) {
      if (item.every(v => typeof v === "boolean" || typeof v === "number" || v === null || safeEnums.has(v))) result.enum = item;
      else result["x-values-redacted"] = true;
    } else if (["const", "pattern", "$ref"].includes(key)) result["x-values-redacted"] = true;
  }
  return result;
}
export async function writeSanitizedCapture(tools, output, live = true) {
  if (!output?.endsWith(".json")) throw new Error("Specify a new .json output file");
  const safe = tools.filter(t => /^silpo_[a-z0-9_]{1,100}$/.test(t.name)).map(t => ({ name: t.name, inputSchema: sanitizeSchema(t.inputSchema), ...(t.outputSchema ? { outputSchema: sanitizeSchema(t.outputSchema) } : {}) }));
  const fixture = { provenance: live ? "authenticated-tools-list-sanitized" : "sanitized-test-fixture-NOT-live", capturedAt: new Date().toISOString(), redactionPolicy: "No descriptions/defaults/examples; arbitrary enum/const/pattern/ref values redacted. Review adapter support separately.", tools: safe };
  await writeFile(output, JSON.stringify(fixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function main() {
  const output = process.argv[2];
  if (!output?.endsWith(".json")) throw new Error("Usage: SILPO_MCP_ACCESS_TOKEN=<existing authorized token> node scripts/capture-silpo-contract.mjs <new-output.json>");
  const token = process.env.SILPO_MCP_ACCESS_TOKEN;
  if (!token?.trim()) throw new Error("An existing authenticated MCP access token is required");
  const client = new Client({ name: "silpo-contract-capture", version: "1.0.0" });
  const signal = AbortSignal.timeout(30_000);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.silpo.ua/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` }, signal } }), { signal, timeout: 10_000 });
    const tools = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10_000 });
      tools.push(...result.tools); cursor = result.nextCursor;
      if (!cursor) { await writeSanitizedCapture(tools, output); return; }
    }
    throw new Error("Tool schema pagination limit exceeded");
  } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("Contract capture failed; no credentials or server error payload logged. Check authentication, output path and schema availability.\n"); process.exitCode = 1; });
}
