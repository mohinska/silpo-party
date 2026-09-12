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
const FOOD_CONTEXT_TOOLS = [
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

export type SilpoMcpSession = {
  client: Client;
  tools: Map<string, SilpoTool>;
  close(): Promise<void>;
};

/** Opens an MCP session from an already-authorized server-side token. The token is never returned or stored here. */
export async function openSilpoMcpSessionWithAccessToken(accessToken: string): Promise<SilpoMcpSession> {
  if (!accessToken.trim()) throw new Error("Silpo MCP access token is required.");
  const transport = new StreamableHTTPClientTransport(new URL(SILPO_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "silpo-family", version: "0.2.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    return { client, tools: new Map(listed.tools.map((tool) => [tool.name, tool as SilpoTool])), close: () => client.close().catch(() => undefined) };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function openSilpoMcpSession(userId: string): Promise<SilpoMcpSession> {
  const accessToken = await getAccessToken(userId);
  if (!accessToken) throw new Error("Організатор має підключити акаунт «Сільпо» у профілі.");
  return openSilpoMcpSessionWithAccessToken(accessToken);
}

export async function withSilpoMcp<T>(
  userId: string,
  operation: (client: Client, tools: Map<string, SilpoTool>) => Promise<T>,
) {
  const accessToken = await getAccessToken(userId);
  if (!accessToken) throw new Error("Організатор має підключити акаунт «Сільпо» у профілі.");
  return withSilpoMcpAccessToken(accessToken, operation);
}

export async function withSilpoMcpAccessToken<T>(
  accessToken: string | null,
  operation: (client: Client, tools: Map<string, SilpoTool>) => Promise<T>,
) {
  if (!accessToken) throw new Error("Silpo MCP access token is required.");
  const session = await openSilpoMcpSessionWithAccessToken(accessToken);
  try {
    return await operation(session.client, session.tools);
  } finally {
    await session.close();
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
  return getPersonalContext(userId, PERSONAL_TOOLS);
}

export async function getPersonalFoodContext(userId: string): Promise<PersonalContext | null> {
  return getPersonalContext(userId, FOOD_CONTEXT_TOOLS);
}

async function getPersonalContext(userId: string, allowedTools: readonly string[]): Promise<PersonalContext | null> {
  try {
    return await withSilpoMcp(userId, async (client, tools) => {
      const entries = await Promise.all(
        allowedTools.filter((name) => tools.has(name)).map(async (name) => [
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
