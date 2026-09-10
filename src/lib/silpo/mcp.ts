import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAccessToken, SILPO_MCP_URL } from "@/lib/silpo/oauth";
import { readToolData } from "./tool-data";
export { readToolData } from "./tool-data";

const PERSONAL_TOOLS = [
  "silpo_get_my_profile",
  "silpo_get_my_food_restrictions",
  "silpo_get_my_favorites",
] as const;

export type PersonalContext = Record<string, unknown>;

export type SilpoTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

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

/** Keep credentials inside the existing session; expose only advertised tools. */
export async function withDiscoveredSilpoTools<T>(
  userId: string,
  operation: (client: Client, tools: Map<string, SilpoTool>) => Promise<T>,
): Promise<T> {
  return withSilpoMcp(userId, operation);
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
