import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAccessToken, SILPO_MCP_URL } from "@/lib/silpo/oauth";

const PERSONAL_TOOLS = [
  "silpo_get_my_profile",
  "silpo_get_my_food_restrictions",
  "silpo_get_my_favorites",
] as const;

export type PersonalContext = Record<string, unknown>;

export type SilpoTool = {
  name: string;
  inputSchema?: Record<string, unknown>;
};

export function readToolData(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  if (record.structuredContent) return record.structuredContent;
  if (!Array.isArray(record.content)) return result;
  const values = record.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== "string") return [];
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [text];
    }
  });
  return values.length === 1 ? values[0] : values;
}

export async function withSilpoMcp<T>(
  userId: string,
  operation: (client: Client, tools: Map<string, SilpoTool>) => Promise<T>,
) {
  const accessToken = await getAccessToken(userId);
  if (!accessToken) throw new Error("Організатор має підключити акаунт «Сільпо» у профілі.");

  const transport = new StreamableHTTPClientTransport(new URL(SILPO_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "silpo-family", version: "0.2.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool as SilpoTool]));
    return await operation(client, tools);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function getPersonalSilpoContext(userId: string): Promise<PersonalContext | null> {
  try {
    return await withSilpoMcp(userId, async (client, tools) => {
      const entries = await Promise.all(
        PERSONAL_TOOLS.filter((name) => tools.has(name)).map(async (name) => [
          name,
          readToolData(await client.callTool({ name, arguments: {} })),
        ]),
      );
      return Object.fromEntries(entries);
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("підключити акаунт")) return null;
    throw error;
  }
}
