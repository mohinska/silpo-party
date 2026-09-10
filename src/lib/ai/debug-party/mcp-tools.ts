import type { SilpoTool } from "../../silpo/mcp";

export type AdvertisedPersonalTool = SilpoTool;
export type PersonalRole = "profile" | "restrictions" | "favorites" | "orders";
export type PersonalMcpSession = {
  tools: readonly AdvertisedPersonalTool[];
  callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
};
export type PersonalMcpAdapter = <T>(
  userId: string,
  operation: (session: PersonalMcpSession) => Promise<T>,
) => Promise<T>;

export const personalMcpAdapter: PersonalMcpAdapter = async (userId, operation) => {
  const { withDiscoveredSilpoTools } = await import("../../silpo/mcp");
  return withDiscoveredSilpoTools(userId, (client, tools) => operation({
    tools: [...tools.values()],
    callTool: (request) => client.callTool(request),
  }));
};

/** Only invoke recognized read capabilities whose advertised schema accepts {}. */
export function discoverPersonalCapabilities(tools: readonly AdvertisedPersonalTool[]) {
  const roles = new Map<PersonalRole, AdvertisedPersonalTool>();
  for (const tool of tools.slice(0, 200)) {
    const words = `${tool.name} ${tool.description ?? ""}`.slice(0, 2000).toLowerCase();
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) continue;
    if (/(?:^|[\s_-])(create|update|delete|remove|set|add|write|submit|cancel|checkout|place)(?:$|[\s_-])/.test(words)) continue;
    if (tool.annotations?.readOnlyHint !== true && !/(?:^|[\s_-])(get|list|read|fetch|search)(?:$|[\s_-])/.test(tool.name)) continue;
    const schema = tool.inputSchema;
    if (!schema || schema.type !== "object") continue;
    // Complex argument contracts must get an explicit adapter, never guessed inputs.
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 0)) continue;
    if (["allOf", "anyOf", "oneOf", "$ref", "not", "if", "minProperties"].some((key) => key in schema)) continue;
    let role: PersonalRole | undefined;
    if (/restrict|allerg|dietary|обмеж|алерг/.test(words)) role = "restrictions";
    else if (/favorite|favourite|улюб/.test(words)) role = "favorites";
    else if (/order|purchase|покуп|замовл/.test(words)) role = "orders";
    else if (/profile|профіл/.test(words)) role = "profile";
    if (role && !roles.has(role)) roles.set(role, tool);
  }
  return roles;
}
