export function agentV2Enabled(environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return environment.PARTY_AGENT_VERSION?.trim() !== "v1";
}
