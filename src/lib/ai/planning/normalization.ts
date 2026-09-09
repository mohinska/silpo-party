import type { EventParticipant } from "./schemas";
import {
  ParticipantFoodSignalsSchema,
  UserFoodContextSchema,
  type ParticipantFoodSignals,
  type UserFoodContext,
} from "./schemas";

const ALLOWED_TOOLS = new Set([
  "silpo_get_my_food_restrictions",
  "silpo_get_my_favorites",
]);
const SENSITIVE_KEY =
  /(access.?token|refresh.?token|authorization|cookie|password|secret|ciphertext|api.?key|e-?mail|phone|address|birth)/i;
const MAX_SOURCE_TEXT = 50_000;
const MAX_VISITED_NODES = 500;

export type ParticipantNormalizationAdapter = (request: {
  participantId: string;
  signals: ParticipantFoodSignals;
}) => Promise<unknown>;

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, 500) : undefined;
}

function decodeToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  if (!Array.isArray(result.content)) return undefined;

  const texts = result.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(
          block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string",
        ),
    )
    .map(({ text }) => text)
    .filter((text) => text.length <= MAX_SOURCE_TEXT);

  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // A bounded non-JSON food fragment may still require semantic normalization.
    }
  }
  return texts[0]?.slice(0, 500);
}

function walkFoodObjects(
  value: unknown,
  visit: (record: Record<string, unknown>, path: string) => void,
) {
  let visited = 0;

  function walk(current: unknown, path: string, depth: number) {
    if (depth > 6 || visited >= MAX_VISITED_NODES) return;
    visited += 1;
    if (Array.isArray(current)) {
      current.slice(0, 100).forEach((item, index) =>
        walk(item, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    if (!current || typeof current !== "object") return;
    const cleanEntries = Object.entries(current).filter(
      ([key]) => !SENSITIVE_KEY.test(key),
    );
    const clean = Object.fromEntries(cleanEntries);
    visit(clean, path);
    cleanEntries.forEach(([key, nested]) =>
      walk(nested, path ? `${path}.${key}` : key, depth + 1),
    );
  }

  walk(value, "", 0);
}

function classifyRestriction(value: unknown) {
  const type = boundedText(value)?.toLocaleLowerCase();
  if (!type) return undefined;
  if (/allerg|алерг/.test(type)) return "allergy" as const;
  if (/dislike|не люблю|не їм/.test(type)) return "dislike" as const;
  if (/prefer|подоба|улюб/.test(type)) return "preference" as const;
  if (/hard|restrict|diet|дієт|обмеж|vegan|vegetarian|gluten/.test(type)) {
    return "hard_restriction" as const;
  }
  return undefined;
}

export function extractParticipantFoodSignals(
  participantId: string,
  rawData: unknown,
  fetchedAt?: string,
): ParticipantFoodSignals {
  const restrictions: ParticipantFoodSignals["restrictions"] = [];
  const favorites: ParticipantFoodSignals["favorites"] = [];
  const ambiguousFragments: string[] = [];
  const evidence: ParticipantFoodSignals["evidence"] = [];
  const seen = new Set<string>();
  let recognizedTools = 0;

  if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
    for (const [toolName, rawResult] of Object.entries(rawData)) {
      if (!ALLOWED_TOOLS.has(toolName)) continue;
      const payload = decodeToolPayload(rawResult);
      if (payload === undefined) continue;
      recognizedTools += 1;

      if (toolName === "silpo_get_my_food_restrictions") {
        if (typeof payload === "string") {
          ambiguousFragments.push(payload);
          continue;
        }
        walkFoodObjects(payload, (record, path) => {
          const label = boundedText(record.label ?? record.name ?? record.title);
          if (!label) return;
          const kind = classifyRestriction(
            record.type ?? record.kind ?? record.restrictionType ?? record.category,
          );
          if (!kind) {
            if (ambiguousFragments.length < 20) ambiguousFragments.push(label);
            return;
          }
          const dedupeKey = `${kind}:${label.toLocaleLowerCase()}`;
          if (seen.has(dedupeKey) || restrictions.length >= 50) return;
          seen.add(dedupeKey);
          const evidenceId = `silpo-restriction:${restrictions.length + 1}`;
          restrictions.push({
            label,
            details: boundedText(record.details ?? record.description),
            kind,
            evidenceId,
          });
          evidence.push({
            id: evidenceId,
            source: "silpo_restrictions",
            fetchedAt,
            fieldPath: path || undefined,
          });
        });
      }

      if (toolName === "silpo_get_my_favorites") {
        walkFoodObjects(payload, (record, path) => {
          const name = boundedText(record.name ?? record.title);
          if (!name || favorites.length >= 100) return;
          const dedupeKey = `favorite:${name.toLocaleLowerCase()}`;
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);
          const evidenceId = `silpo-favorite:${favorites.length + 1}`;
          favorites.push({
            name,
            category: boundedText(record.category ?? record.categoryName),
            evidenceId,
          });
          evidence.push({
            id: evidenceId,
            source: "silpo_favorites",
            fetchedAt,
            fieldPath: path || undefined,
          });
        });
      }
    }
  }

  return ParticipantFoodSignalsSchema.parse({
    participantId,
    restrictions,
    favorites,
    ambiguousFragments: [...new Set(ambiguousFragments)].slice(0, 20),
    evidence: evidence.slice(0, 30),
    completeness:
      recognizedTools === 0
        ? "unavailable"
        : ambiguousFragments.length > 0
          ? "partial"
          : "complete",
  });
}

function declaredContext(participant: EventParticipant): UserFoodContext {
  const evidence = [
    ...participant.preferences.allergies.map(({ id }) => ({
      id: `declared:${id}`,
      source: "declared" as const,
    })),
    ...participant.preferences.dietaryRestrictions.map(({ id }) => ({
      id: `declared:${id}`,
      source: "declared" as const,
    })),
  ];
  const hardConstraints: UserFoodContext["hardConstraints"] = [
    ...participant.preferences.allergies.map((allergy) => ({
      id: allergy.id,
      kind: "allergy" as const,
      label: allergy.label,
      details: allergy.details,
      source: "declared" as const,
      evidenceIds: [`declared:${allergy.id}`],
    })),
    ...participant.preferences.dietaryRestrictions
      .filter(({ strength }) => strength === "hard")
      .map((restriction) => ({
        id: restriction.id,
        kind: "hard_restriction" as const,
        label: restriction.label,
        details: restriction.details,
        source: "declared" as const,
        evidenceIds: [`declared:${restriction.id}`],
      })),
  ];
  const softPreferences = [
    ...participant.preferences.likes,
    ...participant.preferences.cuisines,
    ...participant.preferences.dietaryRestrictions
      .filter(({ strength }) => strength === "preference")
      .map(({ label }) => label),
  ].map((label) => ({ label, source: "declared" as const, evidenceIds: [] }));
  const dislikes = participant.preferences.dislikes.map((label) => ({
    label,
    source: "declared" as const,
    evidenceIds: [],
  }));

  return UserFoodContextSchema.parse({
    participantId: participant.id,
    hardConstraints,
    softPreferences,
    dislikes,
    usefulPatterns: [],
    missingInformation:
      participant.contextCompleteness === "complete"
        ? []
        : ["Потрібно підтвердити повноту харчових обмежень."],
    completeness:
      participant.contextCompleteness === "complete" ? "complete" : "partial",
    evidence,
    summary:
      hardConstraints.length > 0
        ? `Відомі жорсткі обмеження: ${hardConstraints.map(({ label }) => label).join(", ")}.`
        : "Заявлених жорстких обмежень немає; повноту контексту потрібно врахувати.",
  });
}

function mergeUnique<T>(items: T[], key: (item: T) => string, max: number): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item).toLocaleLowerCase();
    if (seen.has(value) || seen.size >= max) return false;
    seen.add(value);
    return true;
  });
}

export async function normalizeParticipantFoodContext({
  participant,
  signals,
  normalizeAmbiguous,
}: {
  participant: EventParticipant;
  signals: ParticipantFoodSignals;
  normalizeAmbiguous?: ParticipantNormalizationAdapter;
}): Promise<UserFoodContext> {
  const declared = declaredContext(participant);
  const deterministic: UserFoodContext = UserFoodContextSchema.parse({
    participantId: participant.id,
    hardConstraints: signals.restrictions
      .filter(({ kind }) => kind === "allergy" || kind === "hard_restriction")
      .map((restriction) => ({
        id: restriction.evidenceId,
        kind: restriction.kind,
        label: restriction.label,
        details: restriction.details,
        source: "silpo_restrictions",
        evidenceIds: [restriction.evidenceId],
      })),
    softPreferences: [
      ...signals.restrictions
        .filter(({ kind }) => kind === "preference")
        .map(({ label, evidenceId }) => ({
          label,
          source: "silpo_restrictions" as const,
          evidenceIds: [evidenceId],
        })),
      ...signals.favorites.map(({ name, evidenceId }) => ({
        label: name,
        source: "silpo_favorites" as const,
        evidenceIds: [evidenceId],
      })),
    ],
    dislikes: signals.restrictions
      .filter(({ kind }) => kind === "dislike")
      .map(({ label, evidenceId }) => ({
        label,
        source: "silpo_restrictions" as const,
        evidenceIds: [evidenceId],
      })),
    usefulPatterns: [],
    missingInformation:
      signals.completeness === "complete"
        ? []
        : ["Контекст Сільпо неповний або недоступний."],
    completeness: signals.completeness,
    evidence: signals.evidence,
    summary: "Контекст Сільпо нормалізовано детерміновано.",
  });

  const semantic =
    signals.ambiguousFragments.length > 0 && normalizeAmbiguous
      ? UserFoodContextSchema.parse(
          await normalizeAmbiguous({ participantId: participant.id, signals }),
        )
      : undefined;

  const hardConstraints = mergeUnique(
    [
      ...declared.hardConstraints,
      ...deterministic.hardConstraints,
      ...(semantic?.hardConstraints ?? []),
    ],
    ({ kind, label }) => `${kind}:${label}`,
    30,
  );
  const completeness =
    signals.completeness === "unavailable"
      ? declared.completeness
      : signals.completeness === "complete" && declared.completeness === "complete"
        ? "complete"
        : "partial";

  return UserFoodContextSchema.parse({
    participantId: participant.id,
    hardConstraints,
    softPreferences: mergeUnique(
      [
        ...declared.softPreferences,
        ...deterministic.softPreferences,
        ...(semantic?.softPreferences ?? []),
      ],
      ({ label }) => label,
      40,
    ),
    dislikes: mergeUnique(
      [
        ...declared.dislikes,
        ...deterministic.dislikes,
        ...(semantic?.dislikes ?? []),
      ],
      ({ label }) => label,
      30,
    ),
    usefulPatterns: mergeUnique(
      semantic?.usefulPatterns ?? [],
      ({ label }) => label,
      20,
    ),
    missingInformation: mergeUnique(
      [
        ...declared.missingInformation,
        ...deterministic.missingInformation,
        ...(semantic?.missingInformation ?? []),
      ],
      (value) => value,
      20,
    ),
    completeness,
    evidence: mergeUnique(
      [...declared.evidence, ...signals.evidence, ...(semantic?.evidence ?? [])],
      ({ id }) => id,
      30,
    ),
    summary: semantic?.summary ?? deterministic.summary,
  });
}
