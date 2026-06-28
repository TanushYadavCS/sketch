import type { Logger } from "pino";
import { normalizeName } from "../connectors/name-normalize";
import type { createEntityRepository } from "../db/repositories/entities";

export type LlmMentionValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "name_absent_from_content" | "short_token_no_boundary" | "type_removed" | "missing_current_reference";
    };

export type LearnedFactValidationResult = { ok: true } | { ok: false; reason: "negation" | "hedge" | "placeholder" };

/**
 * Consumer webmail brands the LLM tends to mint as a "company" after seeing a
 * personal email address (e.g. `anoushka@gmail.com` -> a `Gmail` company with a
 * spurious `works_at` edge). The deterministic affiliation path already drops
 * these via the personal/shared domain check, but the LLM extraction path has no
 * domain to check — only the brand name — so it needs this name-based gate.
 *
 * Whole-name equality only (see {@link isEmailProviderName}); collision-prone
 * bare words (`live`, `me`, `mac`, `msn`) are deliberately excluded so real
 * companies like "Live Nation" survive.
 */
const EMAIL_PROVIDER_NAMES = new Set([
  "gmail",
  "googlemail",
  "google mail",
  "outlook",
  "hotmail",
  "yahoo",
  "ymail",
  "rocketmail",
  "aol",
  "icloud",
  "proton",
  "protonmail",
  "proton mail",
  "gmx",
  "yandex",
  "fastmail",
  "zoho mail",
  "qq",
  "163",
  "naver",
  "hey",
]);

/**
 * True when `name` is exactly a consumer email-provider brand (after lowercasing,
 * collapsing whitespace, and stripping a trailing TLD like `.com`). Matches the
 * whole name only — "Proton Labs" or "Live Nation" return false.
 */
export function isEmailProviderName(name: string): boolean {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\.(com|net|org|co|io|me)$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return EMAIL_PROVIDER_NAMES.has(normalized);
}

export function validateLlmMention(input: {
  displayName: string;
  entityType?: string;
  aliases?: string[];
  fileContent: string;
  resolutionContext?: string | null;
  source: "llm_extraction" | "connector_extracted";
}): LlmMentionValidationResult {
  if (input.source !== "llm_extraction") return { ok: true };
  if (input.entityType?.trim().toLowerCase() === "feature") return { ok: false, reason: "type_removed" };

  const content = normalizePresenceText(input.fileContent);
  const names = [input.displayName, ...(input.aliases ?? [])]
    .map((name) => normalizePresenceText(name))
    .filter((name) => name.length > 0);

  const presentInContent = names.some((name) => content.includes(name));
  if (!presentInContent) {
    if (!hasResolutionContextName(names, input.resolutionContext)) {
      return { ok: false, reason: "name_absent_from_content" };
    }
    if (!hasCurrentMessageReference(input.fileContent)) {
      return { ok: false, reason: "missing_current_reference" };
    }
  }

  for (const name of names.filter((name) => content.includes(name))) {
    for (const token of name.split(" ").filter((part) => part.length > 0 && part.length < 4)) {
      const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, "i");
      if (!boundary.test(input.fileContent)) return { ok: false, reason: "short_token_no_boundary" };
    }
  }

  return { ok: true };
}

function hasResolutionContextName(names: string[], resolutionContext?: string | null): boolean {
  if (!resolutionContext) return false;
  const context = normalizePresenceText(resolutionContext);
  return names.some((name) => context.includes(name));
}

function hasCurrentMessageReference(fileContent: string): boolean {
  const normalized = normalizePresenceText(fileContent);
  if (/\b(he|him|his|she|her|hers|they|them|their|theirs)\b/.test(normalized)) return true;
  return /\b(this|that|these|those)\s+(person|people|company|team|proposal|plan|contract|renewal|review|meeting|thread|email|message|request|decision|timeline|deadline|owner|contact|vendor|client|customer|partner)\b/.test(
    normalized,
  );
}

export function validateLearnedFact(value: string): LearnedFactValidationResult {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("not mentioned") || normalized.includes("unknown")) {
    return { ok: false, reason: "negation" };
  }
  if (
    normalized.includes("is likely") ||
    normalized.includes("is probably") ||
    normalized.includes("may be") ||
    normalized.endsWith("?")
  ) {
    return { ok: false, reason: "hedge" };
  }
  if (normalized.startsWith("<") || normalized.startsWith("[")) {
    return { ok: false, reason: "placeholder" };
  }
  return { ok: true };
}

export async function rewriteLearnedFacts(
  deps: { entityRepo: ReturnType<typeof createEntityRepository>; logger: Logger },
  entityId: string,
  predicate: (value: string) => string | null,
): Promise<{ updated: number; removed: number }> {
  const entity = await deps.entityRepo.getEntity(entityId);
  if (!entity) return { updated: 0, removed: 0 };

  const metadata = entity.metadata ? JSON.parse(entity.metadata) : {};
  const facts = Array.isArray(metadata.learned_facts) ? metadata.learned_facts : [];
  let updated = 0;
  let removed = 0;
  const nextFacts: unknown[] = [];

  for (const entry of facts) {
    if (!entry || typeof entry !== "object" || typeof (entry as { fact?: unknown }).fact !== "string") {
      nextFacts.push(entry);
      continue;
    }
    const replacement = predicate((entry as { fact: string }).fact);
    if (replacement === null) {
      removed++;
      continue;
    }
    if (replacement !== (entry as { fact: string }).fact) {
      updated++;
      nextFacts.push({ ...entry, fact: replacement });
      continue;
    }
    nextFacts.push(entry);
  }

  metadata.learned_facts = nextFacts;
  await deps.entityRepo.updateEntity(entityId, { metadata: JSON.stringify(metadata) });
  deps.logger.debug({ entityId, updated, removed }, "Rewrote learned facts");
  return { updated, removed };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePresenceText(value: string): string {
  return normalizeName(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
