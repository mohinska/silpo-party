import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { extractParticipantFoodSignals } from "../planning/normalization";
import { getPersonalFoodContext } from "../../silpo/mcp";
import { createAdminClient } from "../../supabase/admin";
import type { ContextRefresh, HardRule } from "./state";

const ProfileSchema = z.object({
  allergies: z.string(),
  dietary_restrictions: z.string(),
  dislikes: z.string(),
  preferences: z.string(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();

type Profile = z.infer<typeof ProfileSchema>;
type MembershipProfile = { member: boolean; profile: Profile | null };
type ContextDependencies = {
  readMembershipProfile(partyId: string, participantId: string): Promise<MembershipProfile>;
  readPersonalFoodContext(participantId: string): Promise<Record<string, unknown> | null>;
  now(): Date;
};

function list(value: string) {
  return [...new Set(value.split(/[,;\n]/).map(item => item.trim()).filter(Boolean))].slice(0, 50);
}

function reference(source: string, participantId: string, kind: string, value: string) {
  return `${source}:${createHash("sha256").update(`${participantId}\0${kind}\0${value}`).digest("base64url").slice(0, 32)}`;
}

function rule(source: string, participantId: string, kind: HardRule["kind"], value: string): HardRule {
  const evidenceRef = reference(source, participantId, kind, value);
  return { id: evidenceRef, kind, value, source, evidenceRef, ownerId: participantId };
}

async function readMembershipProfile(partyId: string, participantId: string): Promise<MembershipProfile> {
  const admin = createAdminClient();
  const { data: membership, error: membershipError } = await admin
    .from("party_members")
    .select("user_id")
    .eq("party_id", z.uuid().parse(partyId))
    .eq("user_id", z.uuid().parse(participantId))
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) return { member: false, profile: null };
  const { data, error } = await admin
    .from("profiles")
    .select("allergies,dietary_restrictions,dislikes,preferences,updated_at")
    .eq("id", participantId)
    .maybeSingle();
  if (error) throw error;
  return { member: true, profile: data ? ProfileSchema.parse(data) : null };
}

function nextVersion(previousVersion: number, candidate: number) {
  return Math.max(previousVersion + 1, Number.isSafeInteger(candidate) ? candidate : 0);
}

/** Loads only one party member's private food context. Raw profile/MCP payloads
 * never leave this boundary; the runtime receives normalized food signals. */
export function createParticipantContextLoader(partyId: string, dependencies: Partial<ContextDependencies> = {}) {
  const deps: ContextDependencies = {
    readMembershipProfile,
    readPersonalFoodContext: getPersonalFoodContext,
    now: () => new Date(),
    ...dependencies,
  };
  return async (participantId: string, source: "profile" | "silpo", previousVersion = 0): Promise<ContextRefresh> => {
    let access: MembershipProfile;
    try {
      access = await deps.readMembershipProfile(partyId, participantId);
    } catch {
      return { source, version: previousVersion + 1, status: "error", errorCode: "context_unavailable" };
    }
    if (!access.member) throw new Error("Party membership required for participant context");
    try {
      if (source === "profile") {
        const profile = access.profile;
        const semantic = [...list(profile?.allergies ?? ""), ...list(profile?.dietary_restrictions ?? "")]
          .map(value => rule(source, participantId, "semantic", value));
        const literal = list(profile?.dislikes ?? "").map(value => rule(source, participantId, "exclude_term", value));
        const rules = [...semantic, ...literal];
        const timestamp = profile ? Date.parse(profile.updated_at) : deps.now().getTime();
        return {
          source,
          version: nextVersion(previousVersion, timestamp),
          status: "success",
          rules,
          favorites: list(profile?.preferences ?? ""),
          evidenceRefs: rules.map(item => item.evidenceRef),
        };
      }

      const raw = await deps.readPersonalFoodContext(participantId);
      if (!raw) return { source, version: previousVersion + 1, status: "error", errorCode: "silpo_not_connected" };
      const signals = extractParticipantFoodSignals(participantId, raw, deps.now().toISOString());
      if (signals.completeness === "unavailable") return { source, version: previousVersion + 1, status: "error", errorCode: "silpo_context_unavailable" };
      const rules = signals.restrictions
        .filter(item => item.kind !== "preference")
        .map(item => rule(source, participantId, item.kind === "dislike" ? "exclude_term" : "semantic", item.label));
      return {
        source,
        version: nextVersion(previousVersion, deps.now().getTime()),
        status: "success",
        rules,
        favorites: [
          ...signals.favorites.map(item => item.name),
          ...signals.restrictions.filter(item => item.kind === "preference").map(item => item.label),
        ],
        evidenceRefs: rules.map(item => item.evidenceRef),
      };
    } catch {
      return { source, version: previousVersion + 1, status: "error", errorCode: "context_unavailable" };
    }
  };
}
