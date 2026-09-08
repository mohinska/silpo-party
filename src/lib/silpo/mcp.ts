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

export async function getPersonalSilpoContext(userId: string): Promise<PersonalContext | null> {
  const accessToken = await getAccessToken(userId);
  if (!accessToken) return null;

  const transport = new StreamableHTTPClientTransport(new URL(SILPO_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "silpo-family", version: "0.1.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const available = new Set(tools.map((tool) => tool.name));
    const entries = await Promise.all(
      PERSONAL_TOOLS.filter((name) => available.has(name)).map(async (name) => [
        name,
        await client.callTool({ name, arguments: {} }),
      ]),
    );
    return Object.fromEntries(entries);
  } finally {
    await client.close().catch(() => undefined);
  }
}
