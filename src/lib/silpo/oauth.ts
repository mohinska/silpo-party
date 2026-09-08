import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret } from "@/lib/silpo/crypto";

export const SILPO_MCP_URL = "https://mcp.silpo.ua/mcp";
const AUTHORIZATION_ENDPOINT = "https://mcp.silpo.ua/authorize";
const TOKEN_ENDPOINT = "https://mcp.silpo.ua/token";
const REGISTRATION_ENDPOINT = "https://mcp.silpo.ua/register";

type OAuthClient = { clientId: string; clientSecret?: string };
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

export function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256UrlSafe(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

async function getOAuthClient(redirectUri: string): Promise<OAuthClient> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("silpo_oauth_clients")
    .select("client_id, client_secret_ciphertext")
    .eq("redirect_uri", redirectUri)
    .maybeSingle();

  if (data) {
    return {
      clientId: data.client_id,
      clientSecret: data.client_secret_ciphertext
        ? decryptSecret(data.client_secret_ciphertext)
        : undefined,
    };
  }

  const response = await fetch(REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Silpo Family",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Silpo client registration failed (${response.status}).`);

  const registered = (await response.json()) as {
    client_id: string;
    client_secret?: string;
  };
  const { error } = await admin.from("silpo_oauth_clients").insert({
    redirect_uri: redirectUri,
    client_id: registered.client_id,
    client_secret_ciphertext: registered.client_secret
      ? encryptSecret(registered.client_secret)
      : null,
  });
  if (error) throw error;
  return { clientId: registered.client_id, clientSecret: registered.client_secret };
}

export async function createAuthorization(userId: string, redirectUri: string) {
  const client = await getOAuthClient(redirectUri);
  const state = randomUrlSafe();
  const verifier = randomUrlSafe(64);
  const admin = createAdminClient();
  await admin.from("silpo_oauth_states").delete().lt("expires_at", new Date().toISOString());
  const { error } = await admin.from("silpo_oauth_states").insert({
    state_hash: sha256UrlSafe(state),
    user_id: userId,
    redirect_uri: redirectUri,
    code_verifier_ciphertext: encryptSecret(verifier),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) throw error;

  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", sha256UrlSafe(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", "https://mcp.silpo.ua");
  return url;
}

export async function exchangeAuthorizationCode(
  userId: string,
  state: string,
  code: string,
) {
  const admin = createAdminClient();
  const stateHash = sha256UrlSafe(state);
  const { data, error } = await admin
    .from("silpo_oauth_states")
    .select("user_id, redirect_uri, code_verifier_ciphertext, expires_at")
    .eq("state_hash", stateHash)
    .single();
  await admin.from("silpo_oauth_states").delete().eq("state_hash", stateHash);
  if (error || !data || data.user_id !== userId || new Date(data.expires_at) <= new Date()) {
    throw new Error("Silpo authorization state is invalid or expired.");
  }

  const client = await getOAuthClient(data.redirect_uri);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: data.redirect_uri,
    client_id: client.clientId,
    code_verifier: decryptSecret(data.code_verifier_ciphertext),
    resource: "https://mcp.silpo.ua",
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Silpo token exchange failed (${response.status}).`);
  await saveTokens(userId, (await response.json()) as TokenResponse, data.redirect_uri);
}

async function saveTokens(
  userId: string,
  tokens: TokenResponse,
  redirectUri: string,
  priorRefresh?: string,
) {
  const admin = createAdminClient();
  const refreshToken = tokens.refresh_token ?? priorRefresh;
  const { error } = await admin.from("silpo_connections").upsert({
    user_id: userId,
    redirect_uri: redirectUri,
    access_token_ciphertext: encryptSecret(tokens.access_token),
    refresh_token_ciphertext: refreshToken ? encryptSecret(refreshToken) : null,
    token_type: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? null,
    expires_at: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getAccessToken(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("silpo_connections")
    .select("access_token_ciphertext, refresh_token_ciphertext, expires_at, redirect_uri")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;

  const accessToken = decryptSecret(data.access_token_ciphertext);
  if (!data.expires_at || new Date(data.expires_at).getTime() > Date.now() + 60_000) {
    return accessToken;
  }
  if (!data.refresh_token_ciphertext) return null;

  const refreshToken = decryptSecret(data.refresh_token_ciphertext);
  const client = await getOAuthClient(data.redirect_uri);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    resource: "https://mcp.silpo.ua",
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) return null;
  const tokens = (await response.json()) as TokenResponse;
  await saveTokens(userId, tokens, data.redirect_uri, refreshToken);
  return tokens.access_token;
}

export async function getConnectionStatus(userId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("silpo_connections")
    .select("connected_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

export async function deleteConnection(userId: string) {
  const admin = createAdminClient();
  const { error } = await admin.from("silpo_connections").delete().eq("user_id", userId);
  if (error) throw error;
}
