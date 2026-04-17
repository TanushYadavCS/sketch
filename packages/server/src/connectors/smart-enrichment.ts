/**
 * AI-powered enrichment pipeline.
 *
 * Uses Gemini Flash to:
 * 1. Extract entity mentions from file content (with name variations)
 * 2. Match against entity register, promote candidates on multi-file confirmation
 * 3. Generate grounded file summaries (using matched entity definitions as context)
 * 4. Extract and append new facts to entity definitions
 *
 * Falls back to deterministic enrichment when Gemini is unavailable.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import type { EmbeddingProvider } from "./embeddings/types";
import type { GeminiGenerator } from "./gemini-generate";

/** Max content length (chars) to send to Gemini for entity extraction. ~8k tokens. */
const MAX_CONTENT_CHARS = 32000;

/** Minimum files a candidate must appear in before auto-promotion. */
const CANDIDATE_PROMOTION_THRESHOLD = 2;

/** Minimum entity name length for candidate matching (avoids false positives). */
const MIN_ENTITY_NAME_LENGTH = 3;

// ── Types ────────────────────────────────────────────────────────────────

interface ExtractedMention {
  mention: string;
  type: string;
  variations: string[];
}

interface MatchedEntity {
  entityId: string;
  name: string;
  sourceType: string;
  definition: string | null;
  learnedFacts: Array<{ fact: string }>;
}

interface SmartEnrichmentDeps {
  db: Kysely<DB>;
  logger: Logger;
  generator: GeminiGenerator;
  embeddingProvider: EmbeddingProvider | null;
  orgContext?: { orgName?: string; description?: string; industry?: string } | null;
  /** Known product/team entities to include in extraction prompt for better matching. */
  knownEntities?: Array<{ name: string; type: string; description?: string }>;
}

interface FileContext {
  id: string;
  fileName: string;
  content: string;
  contentCategory: string;
  source: string;
  sourcePath: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

// ── Entity Extraction ────────────────────────────────────────────────────

/**
 * Extract entity mentions from file content using Gemini Flash.
 */
export async function extractEntities(
  generator: GeminiGenerator,
  file: FileContext,
  orgContext?: { orgName?: string; description?: string; industry?: string } | null,
  knownEntities?: Array<{ name: string; type: string; description?: string }>,
): Promise<ExtractedMention[]> {
  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);

  const orgSection = orgContext?.description
    ? `\nOrganization: ${orgContext.orgName ?? "Unknown"}. ${orgContext.description}${orgContext.industry ? ` (Industry: ${orgContext.industry})` : ""}\n`
    : "";

  const knownSection =
    knownEntities && knownEntities.length > 0
      ? `\nKnown entities (match these when mentioned):\n${knownEntities.map((e) => `- ${e.name} (${e.type})${e.description ? `: ${e.description}` : ""}`).join("\n")}\n`
      : "";

  const prompt = `You are analyzing a document to identify meaningful business entities mentioned in it.
${orgSection}${knownSection}
File: ${file.fileName}
Source: ${file.source}${file.sourcePath ? ` / ${file.sourcePath}` : ""}
Type: ${file.contentCategory}

Extract entities that a business team would want to track and reference across documents. Focus on:
- **People**: named individuals (employees, clients, contacts)
- **Companies**: external businesses, clients, partners, vendors
- **Products**: named products or services your org builds or uses (e.g., "Canvas AI", "Sketch", "Meetup by Habuild")
- **Projects**: named initiatives, campaigns, or programs with a clear scope (e.g., "Paid Member Migration Phase 2", "K8S Migration")
- **Teams**: named organizational teams (e.g., "QC team", "Content Team")

DO NOT extract:
- Generic technologies, frameworks, or libraries (Redis, Kafka, Node.js, React, PostgreSQL, Express, Vite)
- Cloud infrastructure services (ECS, EKS, RDS, S3, Lambda, AWS Batch)
- Programming concepts or acronyms (LLM, NLP, API, SDK, REST, GraphQL, npm)
- Operating systems or platforms as entities (iOS, Android, Linux)
- Backlog lists, sprint names, or task board columns ("[Infra] Backlog", "Sprint 5", "Exp Sprint 2")
- Microservice names (auth-service, user-service, payment-service)
- Generic categories (SEO, Marketing, Support, Content)
- Countries, currencies, or generic locations (India, INR, US)
- File formats, protocols, or standards (JSON, HTTP, WebSocket)

For each entity, provide the primary name, type, and name variations.

Return a JSON array:
[
  { "mention": "Project Atlas", "type": "project", "variations": ["Atlas", "the Atlas deal"] },
  { "mention": "Sarah Chen", "type": "person", "variations": ["Sarah", "S. Chen"] }
]

Valid types: "person", "project", "company", "product", "team"

If no notable entities are found, return an empty array: []

<content>
${truncatedContent}
</content>`;

  return generator.generateJSON<ExtractedMention[]>(prompt, {
    maxTokens: 1024,
  });
}

/**
 * Match extracted mentions against the entity register.
 * Returns matched entities and unmatched mentions.
 */
export async function matchEntities(
  db: Kysely<DB>,
  mentions: ExtractedMention[],
): Promise<{
  matched: Array<{ mention: ExtractedMention; entity: MatchedEntity }>;
  unmatched: ExtractedMention[];
}> {
  const entityRepo = createEntityRepository(db);
  const matched: Array<{ mention: ExtractedMention; entity: MatchedEntity }> = [];
  const unmatched: ExtractedMention[] = [];

  for (const mention of mentions) {
    const allNames = [mention.mention, ...mention.variations];
    let found = false;

    for (const name of allNames) {
      if (name.length < MIN_ENTITY_NAME_LENGTH) continue;

      const results = await entityRepo.searchEntities(name, { limit: 5 });
      if (results.length > 0) {
        // Take the best match (first result from substring search)
        const entity = results[0];
        const metadata = parseEntityMetadata(entity.metadata);

        // Avoid duplicates
        if (!matched.some((m) => m.entity.entityId === entity.id)) {
          matched.push({
            mention,
            entity: {
              entityId: entity.id,
              name: entity.name,
              sourceType: entity.source_type,
              definition: metadata.definition ?? null,
              learnedFacts: metadata.learned_facts ?? [],
            },
          });
        }
        found = true;
        break;
      }
    }

    if (!found) {
      unmatched.push(mention);
    }
  }

  return { matched, unmatched };
}

/**
 * Filter a list of file IDs down to those still present in `indexed_files`.
 * Preserves input order. Used to keep `entity_candidates.seen_file_ids`
 * (a JSON blob, not a FK) in sync with reality before FK-guarded inserts.
 */
async function pruneMissingFileIds(db: Kysely<DB>, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await db.selectFrom("indexed_files").select("id").where("id", "in", fileIds).execute();
  const live = new Set(rows.map((r) => r.id));
  return fileIds.filter((id) => live.has(id));
}

/**
 * Handle unmatched mentions: create or update entity candidates.
 * Promotes candidates to real entities when seen in enough files.
 */
export async function handleCandidates(
  deps: SmartEnrichmentDeps,
  fileId: string,
  unmatched: ExtractedMention[],
): Promise<MatchedEntity[]> {
  const { db, logger } = deps;
  const entityRepo = createEntityRepository(db);
  const promoted: MatchedEntity[] = [];

  for (const mention of unmatched) {
    if (mention.mention.length < MIN_ENTITY_NAME_LENGTH) continue;

    // Check if candidate already exists (case-insensitive name match)
    const existing = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where(sql`lower(name)`, "=", mention.mention.toLowerCase())
      .where("promoted_entity_id", "is", null)
      .executeTakeFirst();

    if (existing) {
      // Update existing candidate. Prune any file IDs whose indexed_files row
      // no longer exists (dev resets, manual DB ops) — seen_file_ids is a JSON
      // blob, not a FK, so stale IDs accumulate and would break the FK-guarded
      // backfill below on promotion.
      const rawSeenFileIds: string[] = JSON.parse(existing.seen_file_ids);
      if (rawSeenFileIds.includes(fileId)) continue; // Already counted this file

      const seenFileIds = await pruneMissingFileIds(db, rawSeenFileIds);
      seenFileIds.push(fileId);
      const newCount = seenFileIds.length;

      await db
        .updateTable("entity_candidates")
        .set({
          seen_file_ids: JSON.stringify(seenFileIds),
          seen_count: newCount,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", existing.id)
        .execute();

      // Promote if threshold met
      if (newCount >= CANDIDATE_PROMOTION_THRESHOLD) {
        const entity = await entityRepo.upsertEntity({
          name: mention.mention,
          sourceType: mention.type,
          aliases: mention.variations,
          metadata: { origin: "ai" },
          status: "confirmed",
        });

        await db
          .updateTable("entity_candidates")
          .set({ promoted_entity_id: entity.id, updated_at: new Date().toISOString() })
          .where("id", "=", existing.id)
          .execute();

        // Backfill entity_mentions. The prune above makes this mostly a no-op,
        // but re-check at insert time so a file deleted between prune and loop
        // can't crash the whole promotion.
        const liveFileIds = await pruneMissingFileIds(db, seenFileIds);
        for (const seenFileId of liveFileIds) {
          await entityRepo.createMention({
            entityId: entity.id,
            indexedFileId: seenFileId,
          });
        }
        if (liveFileIds.length < seenFileIds.length) {
          logger.warn(
            { entityId: entity.id, total: seenFileIds.length, skipped: seenFileIds.length - liveFileIds.length },
            "Skipped mention backfill for missing indexed files",
          );
        }

        logger.info(
          { entityName: mention.mention, entityId: entity.id, fileCount: liveFileIds.length },
          "Promoted entity candidate",
        );

        promoted.push({
          entityId: entity.id,
          name: entity.name,
          sourceType: entity.source_type,
          definition: null,
          learnedFacts: [],
        });
      }
    } else {
      // Create new candidate
      await db
        .insertInto("entity_candidates")
        .values({
          id: randomUUID(),
          name: mention.mention,
          type: mention.type,
          variations: JSON.stringify(mention.variations),
          first_seen_file_id: fileId,
          seen_file_ids: JSON.stringify([fileId]),
          seen_count: 1,
          promoted_entity_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
    }
  }

  return promoted;
}

// ── Summary Generation ───────────────────────────────────────────────────

/**
 * Generate a grounded file summary using matched entity context.
 */
export async function generateSummary(
  generator: GeminiGenerator,
  file: FileContext,
  matchedEntities: MatchedEntity[],
): Promise<string> {
  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);
  const entityContext = matchedEntities
    .map((e) => {
      const def = e.definition || "no definition yet";
      return `- ${e.name} (${e.sourceType}): ${def}`;
    })
    .join("\n");

  const prompt = `You are summarizing a document for a search index. Your summary should capture what someone would search for later.

File: ${file.fileName}
Source: ${file.source}${file.sourcePath ? ` / ${file.sourcePath}` : ""}
Type: ${file.contentCategory}
Date: ${file.sourceCreatedAt || file.sourceUpdatedAt || "unknown"}
${entityContext ? `Related entities:\n${entityContext}` : ""}

Write a 2-3 sentence summary focusing on: what this document is about, key decisions or outcomes, and topics discussed. Be specific — use names, numbers, dates. Do not start with "This document".

<content>
${truncatedContent}
</content>`;

  return generator.generate(prompt, { maxTokens: 256 });
}

// ── Entity Fact Extraction ───────────────────────────────────────────────

interface LearnedFact {
  fact: string;
}

/**
 * Extract new facts about matched entities from file content.
 * Returns a map of entity ID → new facts.
 */
export async function extractEntityFacts(
  generator: GeminiGenerator,
  file: FileContext,
  matchedEntities: MatchedEntity[],
): Promise<Map<string, LearnedFact[]>> {
  if (matchedEntities.length === 0) return new Map();

  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);
  const entityDescriptions = matchedEntities
    .map((e) => {
      const facts = e.learnedFacts.map((f) => f.fact).join("; ");
      return `- ID: ${e.entityId} | Name: ${e.name} (${e.sourceType}) | Definition: ${e.definition || "none"} | Known facts: ${facts || "none"}`;
    })
    .join("\n");

  const prompt = `Extract NEW facts about these entities from the document below. Max 3 facts per entity, each under 20 words.

Entities:
${entityDescriptions}

Document: ${file.fileName} (${file.sourceCreatedAt || file.sourceUpdatedAt || "unknown"})

Return JSON: { "entity-id": [{ "fact": "short fact" }] }
Return {} if no new facts.

<content>
${truncatedContent}
</content>`;

  return new Map(
    Object.entries(await generator.generateJSON<Record<string, LearnedFact[]>>(prompt, { maxTokens: 2048 })),
  );
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Run AI-powered enrichment for a single file.
 *
 * Stage 1: Extract entities + match against register + handle candidates
 * Stage 2 (parallel): Generate summary + extract entity facts
 * Then: store summary, embed summary, update entity definitions, create mentions
 */
export async function smartEnrichFile(deps: SmartEnrichmentDeps, file: FileContext): Promise<void> {
  const { db, logger, generator, embeddingProvider } = deps;
  const entityRepo = createEntityRepository(db);

  // ── Stage 1: Entity extraction + matching ──────────────────────
  const mentions = await extractEntities(generator, file, deps.orgContext, deps.knownEntities);
  logger.debug({ fileId: file.id, mentionCount: mentions.length }, "Extracted entity mentions");

  const { matched, unmatched } = await matchEntities(db, mentions);
  const promoted = await handleCandidates(deps, file.id, unmatched);

  // Combine matched + promoted for context
  const allMatched = [...matched.map((m) => m.entity), ...promoted];

  // Create entity mentions for matched entities
  await entityRepo.deleteMentionsForFile(file.id);
  for (const entity of allMatched) {
    await entityRepo.createMention({ entityId: entity.entityId, indexedFileId: file.id });
    await entityRepo.updateHotness(entity.entityId);
  }

  // ── Stage 2: Summary + fact extraction (parallel) ──────────────
  const [summary, factsMap] = await Promise.all([
    generateSummary(generator, file, allMatched),
    extractEntityFacts(generator, file, allMatched),
  ]);

  // Store summary
  await db.updateTable("indexed_files").set({ summary, summary_status: "done" }).where("id", "=", file.id).execute();

  logger.debug({ fileId: file.id, summaryLength: summary.length }, "Generated file summary");

  // Embed summary into file_embeddings
  if (embeddingProvider && summary) {
    try {
      const [embedding] = await embeddingProvider.embedTexts([summary]);
      if (embedding) {
        const isPostgres = isPg(db);
        if (isPostgres) {
          await sql`INSERT INTO file_embeddings (indexed_file_id, embedding)
            VALUES (${file.id}, ${JSON.stringify(embedding)}::vector)
            ON CONFLICT (indexed_file_id) DO UPDATE SET embedding = EXCLUDED.embedding`.execute(db);
        } else {
          await sql`INSERT OR REPLACE INTO file_embeddings (indexed_file_id, embedding)
            VALUES (${file.id}, ${JSON.stringify(embedding)})`.execute(db);
        }
      }
    } catch (err) {
      logger.warn({ err, fileId: file.id }, "Failed to embed summary");
    }
  }

  // Update entity definitions with new facts
  for (const [entityId, facts] of factsMap) {
    if (facts.length === 0) continue;

    const entity = await entityRepo.getEntity(entityId);
    if (!entity) continue;

    const metadata = parseEntityMetadata(entity.metadata);
    const existingFacts = metadata.learned_facts ?? [];

    const newFacts = facts.map((f) => ({
      fact: f.fact,
      source_file_id: file.id,
      learned_at: new Date().toISOString().split("T")[0],
    }));

    metadata.learned_facts = [...existingFacts, ...newFacts];

    await entityRepo.updateEntity(entityId, { metadata: JSON.stringify(metadata) });

    logger.debug({ entityId, newFactCount: facts.length }, "Updated entity definition");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface EntityMetadata {
  definition?: string;
  learned_facts?: Array<{ fact: string; source_file_id?: string; learned_at?: string }>;
  [key: string]: unknown;
}

function parseEntityMetadata(raw: string | null): EntityMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EntityMetadata;
  } catch {
    return {};
  }
}
