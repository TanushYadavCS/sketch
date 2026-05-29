import type { Logger } from "pino";
import { normalizeName } from "../connectors/name-normalize";
import type { createEntityRepository } from "../db/repositories/entities";

export type LlmMentionValidationResult =
  | { ok: true }
  | { ok: false; reason: "name_absent_from_content" | "short_token_no_boundary" | "type_removed" };

export type LearnedFactValidationResult = { ok: true } | { ok: false; reason: "negation" | "hedge" | "placeholder" };

export function validateLlmMention(input: {
  displayName: string;
  entityType?: string;
  aliases?: string[];
  fileContent: string;
  source: "llm_extraction" | "connector_extracted";
}): LlmMentionValidationResult {
  if (input.source !== "llm_extraction") return { ok: true };
  if (input.entityType?.trim().toLowerCase() === "feature") return { ok: false, reason: "type_removed" };

  const content = normalizePresenceText(input.fileContent);
  const names = [input.displayName, ...(input.aliases ?? [])]
    .map((name) => normalizePresenceText(name))
    .filter((name) => name.length > 0);

  if (!names.some((name) => content.includes(name))) {
    return { ok: false, reason: "name_absent_from_content" };
  }

  for (const name of names) {
    for (const token of name.split(" ").filter((part) => part.length > 0 && part.length < 4)) {
      const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, "i");
      if (!boundary.test(input.fileContent)) return { ok: false, reason: "short_token_no_boundary" };
    }
  }

  return { ok: true };
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
