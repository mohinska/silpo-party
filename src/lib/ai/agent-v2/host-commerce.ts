import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAccessToken, SILPO_MCP_URL } from "../../silpo/oauth";
import { createMcpCommerceAdapter, CommerceError, type CommerceAdapter, type ListedCommerceTool } from "./commerce-contract";

/** Server runtime resolves Host identity from membership/operation first.
 * Existing OAuth storage/token refresh is reused, and credentials never leave
 * this scope. A schema mismatch blocks before any commerce tools are called. */
export async function withHostCommerce<T>(hostId: string, operation: (api: CommerceAdapter) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(parentSignal ? [parentSignal] : [])]);
  signal.throwIfAborted();
  const accessToken = await getAccessToken(hostId);
  if (!accessToken) throw new CommerceError("unavailable", "Host must connect Silpo");
  const client = new Client({ name: "silpo-agent-v2", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(SILPO_MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` }, signal } }), { signal, timeout: 10_000 });
    const listed: ListedCommerceTool[] = []; let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10_000 });
      listed.push(...result.tools); cursor = result.nextCursor;
      if (!cursor) return await operation(createMcpCommerceAdapter(listed, (input, options) => client.callTool(input, undefined, options), { signal }));
    }
    throw new CommerceError("contract", "Tool schema pagination limit exceeded");
  } finally { await client.close(); }
}
