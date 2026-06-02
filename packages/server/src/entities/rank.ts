import { normalizeName } from "../connectors/name-normalize";
import type { Entity } from "./propose";

const LOW_SIGNAL_PERSON_TOKENS = new Set(["person", "people", "user", "unknown"]);

export interface ExtractedMention {
  name: string;
  aliases?: string[];
  entityType: "person";
}

export interface RankedCandidate {
  entity: Entity;
  score: number;
  reason: "llm-ambiguous";
}

export type LlmMentionDecision =
  | { kind: "confident_match"; mention: ExtractedMention; entity: Entity; confidence: "INFERRED" }
  | { kind: "confident_no_match"; mention: ExtractedMention }
  | { kind: "ambiguous_existing"; mention: ExtractedMention; candidates: RankedCandidate[] }
  | {
      kind: "ambiguous_new_entity";
      mention: ExtractedMention;
      proposedName: string;
      entityType: "person";
      candidates: RankedCandidate[];
    };

export interface RankerContext {
  fileId: string;
  extractedPersons: Array<{ entityId: string }>;
  extractedCompanies: Array<{ entityId: string; domain?: string }>;
  contextCompanies: Array<{ entityId: string }>;
}

function tokens(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token.length > 0 && !LOW_SIGNAL_PERSON_TOKENS.has(token));
}

function hasTokenOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const bSet = new Set(b);
  return a.some((token) => bSet.has(token));
}

function scoreCandidate(
  mentionTokens: string[],
  entity: Entity,
  ctx: RankerContext,
  worksAtLookup: (entityId: string) => string | null,
): number | null {
  const entityTokens = tokens(entity.name);
  if (!hasTokenOverlap(mentionTokens, entityTokens)) return null;

  let score = 0;
  if (ctx.extractedPersons.some((p) => p.entityId === entity.id)) score += 10;

  const companyId = worksAtLookup(entity.id);
  if (companyId) {
    if (ctx.extractedCompanies.some((c) => c.entityId === companyId)) score += 5;
    else if (ctx.contextCompanies.some((c) => c.entityId === companyId)) score += 2;
  }

  if (entityTokens.length > mentionTokens.length) score += 1;
  return score;
}

export function rankPersonLlmMention(
  mention: ExtractedMention,
  candidates: Entity[],
  ctx: RankerContext,
  worksAtLookup: (entityId: string) => string | null,
): LlmMentionDecision {
  const mentionTokens = tokens(mention.name);
  const ranked = candidates
    .map((entity) => {
      const score = scoreCandidate(mentionTokens, entity, ctx, worksAtLookup);
      return score === null ? null : ({ entity, score, reason: "llm-ambiguous" as const } satisfies RankedCandidate);
    })
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));

  if (ranked.length === 0) {
    return { kind: "confident_no_match", mention };
  }

  const top = ranked[0];
  const second = ranked[1] ?? null;
  const topHasExtractedFileMention = ctx.extractedPersons.some((p) => p.entityId === top.entity.id);

  if (top.score <= 0) {
    return {
      kind: "ambiguous_new_entity",
      mention,
      proposedName: mention.name,
      entityType: "person",
      candidates: ranked,
    };
  }

  if (top.score < 2) {
    return { kind: "ambiguous_existing", mention, candidates: ranked };
  }

  if (second) {
    if (!topHasExtractedFileMention && top.score - second.score <= 1) {
      return { kind: "ambiguous_existing", mention, candidates: ranked };
    }
    if (second.score > 0 && top.score < 2 * second.score) {
      return { kind: "ambiguous_existing", mention, candidates: ranked };
    }
  }

  return { kind: "confident_match", mention, entity: top.entity, confidence: "INFERRED" };
}
