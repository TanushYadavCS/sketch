import type { Kysely } from "kysely";
import { whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { readPersonEmailFromMetadata } from "./materialize-json";

export type EntityAdjudicationConfidence = "high" | "medium" | "low";

/**
 * Minimal structured-generation surface the adjudicator needs. Satisfied by
 * the enrichment Gemini generator (`createGeminiGenerator`) — the same model
 * the rest of the entity pipeline runs on — and by a fake in tests.
 */
export interface AdjudicationGenerator {
  generateJSON<T>(prompt: string, opts?: { systemPrompt?: string; maxTokens?: number; label?: string }): Promise<T>;
}

export interface EntityMentionFileContext {
  fileName: string;
  sourcePath: string | null;
  summary: string | null;
}

export interface EntityCoMentionContext {
  entityId: string;
  name: string;
  count: number;
}

export interface EntityContext {
  entityId: string;
  entityType: string;
  name: string;
  aliases: string[];
  subtype: string | null;
  email: string | null;
  corporateDomains: string[];
  worksAtCompanies: string[];
  mentionFiles: EntityMentionFileContext[];
  coMentionedEntities: EntityCoMentionContext[];
}

export interface EntityAdjudicationVerdict {
  matchEntityId: string | null;
  confidence: EntityAdjudicationConfidence;
  reason: string;
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function validateVerdict(parsed: {
  match?: unknown;
  confidence?: unknown;
  reason?: unknown;
}): EntityAdjudicationVerdict {
  const confidence =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";
  return {
    matchEntityId: typeof parsed.match === "string" ? parsed.match : null,
    confidence,
    reason: typeof parsed.reason === "string" ? parsed.reason : "No parseable reason returned.",
  };
}

function renderContext(context: EntityContext): string {
  return JSON.stringify({
    id: context.entityId,
    type: context.entityType,
    name: context.name,
    aliases: context.aliases,
    subtype: context.subtype,
    email: context.email,
    corporateDomains: context.corporateDomains,
    worksAtCompanies: context.worksAtCompanies,
    mentionFiles: context.mentionFiles,
    coMentionedEntities: context.coMentionedEntities,
  });
}

export async function buildEntityAdjudicationContext(db: Kysely<DB>, entityId: string): Promise<EntityContext> {
  const entity = await db
    .selectFrom("entities")
    .selectAll()
    .where("id", "=", entityId)
    .where(whereLiveEntity())
    .executeTakeFirstOrThrow();

  const corporateDomains = await db
    .selectFrom("entity_domains")
    .select("domain")
    .where("entity_id", "=", entityId)
    .where("kind", "=", "corporate")
    .orderBy("is_primary", "desc")
    .orderBy("confidence", "desc")
    .orderBy("domain", "asc")
    .limit(5)
    .execute();

  const worksAtCompanies = await db
    .selectFrom("entity_relationships")
    .innerJoin("entities as company", "company.id", "entity_relationships.target_entity_id")
    .select("company.name")
    .where("entity_relationships.source_entity_id", "=", entityId)
    .where("entity_relationships.relationship_type", "=", "works_at")
    .where("entity_relationships.valid_to", "is", null)
    .where(whereLiveEntity("company"))
    .orderBy("company.name", "asc")
    .limit(5)
    .execute();

  const mentionFiles = await db
    .selectFrom("entity_mentions")
    .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
    .select(["indexed_files.file_name", "indexed_files.source_path", "indexed_files.summary"])
    .where("entity_mentions.entity_id", "=", entityId)
    .orderBy("entity_mentions.mentioned_at", "desc")
    .limit(5)
    .execute();

  const coMentionedEntities = await db
    .selectFrom("entity_mentions as subject_mention")
    .innerJoin("entity_mentions as other_mention", "other_mention.indexed_file_id", "subject_mention.indexed_file_id")
    .innerJoin("entities as other_entity", "other_entity.id", "other_mention.entity_id")
    .select(["other_mention.entity_id as entityId", "other_entity.name as name", db.fn.countAll<number>().as("count")])
    .where("subject_mention.entity_id", "=", entityId)
    .where("other_mention.entity_id", "!=", entityId)
    .where(whereLiveEntity("other_entity"))
    .groupBy(["other_mention.entity_id", "other_entity.name"])
    .orderBy("count", "desc")
    .orderBy("other_entity.name", "asc")
    .limit(5)
    .execute();

  return {
    entityId: entity.id,
    entityType: entity.source_type,
    name: entity.name,
    aliases: parseAliases(entity.aliases).slice(0, 5),
    subtype: entity.subtype,
    email: readPersonEmailFromMetadata(entity.metadata),
    corporateDomains: corporateDomains.map((row) => row.domain),
    worksAtCompanies: worksAtCompanies.map((row) => row.name),
    mentionFiles: mentionFiles.map((row) => ({
      fileName: row.file_name,
      sourcePath: row.source_path,
      summary: row.summary,
    })),
    coMentionedEntities: coMentionedEntities.map((row) => ({
      entityId: row.entityId,
      name: row.name,
      count: Number(row.count),
    })),
  };
}

export async function adjudicateEntityMatch(
  generator: AdjudicationGenerator,
  subject: EntityContext,
  candidates: EntityContext[],
): Promise<EntityAdjudicationVerdict> {
  const prompt = [
    `Are the subject and any candidate the same real-world ${subject.entityType}?`,
    "The subject is the entity being considered for merge into one candidate.",
    "Reorder or formatting differences alone are not sufficient. Require corroborating signals such as email, domain, workplace, shared files, aliases, or co-mentions.",
    "Bias to different or uncertain when evidence is thin.",
    'Return only strict JSON in this shape: {"match":"<candidate id>"|null,"confidence":"high"|"medium"|"low","reason":"short reason"}.',
    `Subject: ${renderContext(subject)}`,
    `Candidates: ${JSON.stringify(candidates.map((candidate) => JSON.parse(renderContext(candidate))))}`,
  ].join("\n");

  try {
    const parsed = await generator.generateJSON<{ match?: unknown; confidence?: unknown; reason?: unknown }>(prompt, {
      maxTokens: 512,
      label: "entity-dedup-adjudicator",
    });
    const verdict = validateVerdict(parsed);
    if (verdict.matchEntityId && !candidates.some((candidate) => candidate.entityId === verdict.matchEntityId)) {
      return { matchEntityId: null, confidence: "low", reason: "Model returned a candidate id outside the prompt." };
    }
    return verdict;
  } catch {
    return { matchEntityId: null, confidence: "low", reason: "Entity adjudication failed." };
  }
}
