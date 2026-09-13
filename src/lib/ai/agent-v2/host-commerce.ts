import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { getAccessToken, SILPO_MCP_URL } from "../../silpo/oauth";
import { createAdminClient } from "../../supabase/admin";
import { createMcpCommerceAdapter, CommerceError, type CommerceAdapter, type CommerceReadAdapter, type ListedCommerceTool } from "./commerce-contract";

const issuedAuthority = new WeakSet<object>();
const authorityBrand = Symbol("verified-host-commerce-authority");
export type VerifiedHostCommerceAuthority = { readonly scope: "approved_operation_write"; readonly hostId: string; readonly partyId: string; readonly operationId: string; readonly [authorityBrand]: true };
export type VerifiedPartyHostCommerceAuthority = { readonly scope: "party_read"; readonly hostId: string; readonly partyId: string; readonly [authorityBrand]: true };
export interface HostCommerceAuthorityRepository {
  resolveApprovedHost(input: { operationId: string; actorId: string }): Promise<{ partyId: string; hostId: string; approvedBy: string } | null>;
}
type ApprovedHostOperationReader = (operationId: string) => Promise<{ partyId: string; hostId: string; approvedBy: string } | null>;
type PartyHostLookup = { partyId: string; actorId: string };
type PartyHostAuthorityRow = { partyId: string; hostId: string; memberPartyId: string; memberUserId: string };
type PartyHostReader = (input: PartyHostLookup) => Promise<PartyHostAuthorityRow | null>;

async function readApprovedHostOperation(operationId: string) {
  const admin = createAdminClient();
  const { data: operation, error: operationError } = await admin.from("party_cart_operations").select("party_id, approved_by").eq("id", z.uuid().parse(operationId)).maybeSingle();
  if (operationError || !operation) return null;
  const { data: party, error: partyError } = await admin.from("parties").select("host_id").eq("id", operation.party_id).maybeSingle();
  if (partyError || !party) return null;
  return { partyId: operation.party_id, hostId: party.host_id, approvedBy: operation.approved_by };
}
async function readPartyHost(input: PartyHostLookup) {
  const partyId = z.uuid().parse(input.partyId);
  const actorId = z.uuid().parse(input.actorId);
  const { data, error } = await createAdminClient()
    .from("party_members")
    .select("party_id,user_id,parties!inner(id,host_id)")
    .eq("party_id", partyId)
    .eq("user_id", actorId)
    .maybeSingle();
  if (error || !data) return null;
  const row = z.object({
    party_id: z.uuid(),
    user_id: z.uuid(),
    parties: z.object({ id: z.uuid(), host_id: z.uuid() }),
  }).parse(data);
  return { partyId: row.parties.id, hostId: row.parties.host_id, memberPartyId: row.party_id, memberUserId: row.user_id };
}

/** Repository-backed authority resolution. The default reader is server-only;
 * tests may provide an equivalent authoritative reader. */
export function createHostCommerceAuthorityRepository(read: ApprovedHostOperationReader = readApprovedHostOperation): HostCommerceAuthorityRepository {
  return {
    async resolveApprovedHost(input) {
      const resolved = await read(input.operationId);
      return resolved && resolved.hostId === input.actorId && resolved.approvedBy === input.actorId ? resolved : null;
    },
  };
}
export function createPartyHostCommerceAuthorityRepository(read: PartyHostReader = readPartyHost) {
  return { async resolvePartyHost(input: PartyHostLookup) { return read(input); } };
}
export async function resolveVerifiedPartyHostCommerceAuthority(input: PartyHostLookup, repository: { resolvePartyHost(input: PartyHostLookup): Promise<PartyHostAuthorityRow | null> }): Promise<VerifiedPartyHostCommerceAuthority> {
  const partyId = z.string().trim().min(1).parse(input.partyId);
  const actorId = z.string().trim().min(1).parse(input.actorId);
  const resolved = await repository.resolvePartyHost({ partyId, actorId });
  if (!resolved || resolved.partyId !== partyId || resolved.memberPartyId !== partyId || resolved.memberUserId !== actorId) throw new CommerceError("approval_required", "Verified party Host authority required");
  const authority = Object.freeze({ scope: "party_read" as const, hostId: resolved.hostId, partyId, [authorityBrand]: true }) as VerifiedPartyHostCommerceAuthority;
  issuedAuthority.add(authority);
  return authority;
}

/** This is the only constructor for Host commerce authority. Its repository
 * boundary must bind an approved operation to the party's current Host. */
export async function resolveVerifiedHostCommerceAuthority(input: { operationId: string; actorId: string }, repository: HostCommerceAuthorityRepository): Promise<VerifiedHostCommerceAuthority> {
  if (!input.operationId.trim() || !input.actorId.trim()) throw new CommerceError("approval_required", "Approved operation and Host actor are required");
  const resolved = await repository.resolveApprovedHost(input);
  if (!resolved || resolved.hostId !== input.actorId || resolved.approvedBy !== input.actorId) throw new CommerceError("approval_required", "Verified Host authority required");
  const authority = Object.freeze({ scope: "approved_operation_write" as const, hostId: resolved.hostId, partyId: resolved.partyId, operationId: input.operationId, [authorityBrand]: true }) as VerifiedHostCommerceAuthority;
  issuedAuthority.add(authority);
  return authority;
}

/** Credentials remain in this server-only scope. Callers cannot supply an
 * arbitrary Host id: they must present an authority issued above. */
export async function withVerifiedHostCommerce<T>(authority: VerifiedHostCommerceAuthority, operation: (api: CommerceAdapter) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  if (!issuedAuthority.has(authority) || authority.scope !== "approved_operation_write") throw new CommerceError("approval_required", "Verified Host authority required");
  return withAuthorityCommerce(authority, operation, parentSignal);
}
export async function withVerifiedPartyHostCommerce<T>(authority: VerifiedPartyHostCommerceAuthority, operation: (api: CommerceReadAdapter) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  if (!issuedAuthority.has(authority) || authority.scope !== "party_read") throw new CommerceError("approval_required", "Verified party Host authority required");
  return withAuthorityCommerce(authority, async api => operation({ cart: api.cart, search: api.search, details: api.details, substitutions: api.substitutions }), parentSignal);
}
async function withAuthorityCommerce<T>(authority: { hostId: string }, operation: (api: CommerceAdapter) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(parentSignal ? [parentSignal] : [])]);
  signal.throwIfAborted();
  const accessToken = await getAccessToken(authority.hostId);
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
