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
import {
  type UpsertIndexedFileFactInput,
  buildIndexedFileFactKey,
  createIndexedFileFactRepository,
} from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
export {
  DOMAIN_PROMOTION_THRESHOLD,
  type DomainSweepResult,
  sweepDomainPromotions,
} from "../entities/domain-promotion";
import {
  buildMaterializeDeps,
  cleanupEmptyRelationships,
  cleanupRelationshipEvidenceForFacts,
  materializeUnmaterializedFacts,
} from "../entities/materialize";
import { type ProposeEntityType, proposeEntity } from "../entities/propose";
import { validateLearnedFact, validateLlmMention } from "../entities/validators";
import { yieldToEventLoop } from "../lib/event-loop";
import type { EmbeddingProvider } from "./embeddings/types";
import type { GeminiGenerator } from "./gemini-generate";
import {
  type FactSelectionCache,
  type FactSelectionContext,
  type LearnedFactStored,
  buildFactSelectionContext,
  createFactSelectionCache,
  renderFactsForPrompt,
  selectRelevantFacts,
} from "./learned-fact-selector";
import { normalizeName } from "./name-normalize";

/** Max content length (chars) to send to Gemini for entity extraction. ~8k tokens. */
const MAX_CONTENT_CHARS = 32000;

/** Minimum files a candidate must appear in before auto-promotion. */
const CANDIDATE_PROMOTION_THRESHOLD = 2;

/**
 * Minimum distinct people sharing an email domain before a
 * `domain_observation` candidate gets auto-promoted to a real company entity.
 *
 * Set to 1 because the realistic sales motion here is single-person prospect
 * calls (Calendly demos, intro calls) — anything higher leaves 90% of demo
 * clients invisible to the graph. The false-positive floor is held by two
 * orthogonal filters that run BEFORE this counter ever increments:
 *   - personal/shared seed (gmail.com, outlook.com, slack.com, …)
 *   - role-account local-parts (hello@, info@, support@, …) — see
 *     `inferAffiliationFromEmail`
 * Fuzzy-name collisions still pause for ECR-05 review, so an LLM-extracted
 * company entity that conflicts with a new domain-derived name stays pending
 * instead of forking.
 */
/** Minimum entity name length for candidate matching (avoids false positives). */
const MIN_ENTITY_NAME_LENGTH = 3;
const LLM_EXTRACTION_PROMPT_VERSION = "llm-extraction-v5";
const PROPOSABLE_ENTITY_TYPES = new Set<ProposeEntityType>([
  "person",
  "company",
  "product",
  "project",
  "feature",
  "team",
]);

// ── Types ────────────────────────────────────────────────────────────────

interface ExtractedMention {
  mention: string;
  type: string;
  variations: string[];
  confidence?: number;
}

interface ExtractedRelationEndpoint {
  name: string;
  type: string;
  variations?: string[];
}

interface ExtractedRelation {
  type: string;
  source: ExtractedRelationEndpoint;
  target: ExtractedRelationEndpoint;
  confidence: number;
  context?: string;
}

interface EntityExtractionResult {
  mentions: ExtractedMention[];
  relations: ExtractedRelation[];
}

interface MatchedEntity {
  entityId: string;
  name: string;
  sourceType: string;
  definition: string | null;
  learnedFacts: LearnedFactStored[];
}

interface SmartEnrichmentDeps {
  db: Kysely<DB>;
  logger: Logger;
  generator: GeminiGenerator;
  embeddingProvider: EmbeddingProvider | null;
  orgContext?: { orgName?: string; description?: string; industry?: string } | null;
  /** Known product/team entities to include in extraction prompt for better matching. */
  knownEntities?: Array<{
    name: string;
    type: string;
    description?: string;
    mentionCount?: number;
    recentlyActive?: boolean;
  }>;
  /**
   * Pre-built markdown block listing meeting attendees with resolved company
   * affiliations and action-item-owner flags. Prepended to the extraction
   * prompt so the model sees cross-company evidence that lives only in
   * attendee metadata. Caller (enrichment.ts) builds via `buildParticipantBlock`.
   */
  participantBlock?: string;
  /**
   * When set, every LLM call inside this run writes a dump file (prompt + raw
   * response + token usage) under this directory. Set only by the per-file
   * "Enrich File" debug path; never set in bulk sync/reset/reenrich runs.
   */
  debugDumpDir?: string;
}

interface FileContext {
  id: string;
  fileName: string;
  content: string;
  contentCategory: string;
  source: string;
  sourcePath: string | null;
  contentHash: string | null;
  connectorConfigId: string;
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
  knownEntities?: Array<{
    name: string;
    type: string;
    description?: string;
    mentionCount?: number;
    recentlyActive?: boolean;
  }>,
  participantBlock?: string,
  dumpDir?: string,
): Promise<EntityExtractionResult> {
  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);

  const orgSection = orgContext?.description
    ? `\nOrganization: ${orgContext.orgName ?? "Unknown"}. ${orgContext.description}${orgContext.industry ? ` (Industry: ${orgContext.industry})` : ""}\n`
    : "";

  const renderKnown = (e: {
    name: string;
    type: string;
    description?: string;
    mentionCount?: number;
    recentlyActive?: boolean;
  }) => {
    const parts: string[] = [`- ${e.name} (${e.type})`];
    if (e.description) parts.push(`: ${e.description}`);
    const tags: string[] = [];
    if (typeof e.mentionCount === "number" && e.mentionCount > 0) {
      tags.push(`${e.mentionCount} recent files`);
    }
    if (e.recentlyActive) tags.push("active in last 2 weeks");
    if (tags.length > 0) parts.push(` · ${tags.join(" · ")}`);
    return parts.join("");
  };

  const knownSection =
    knownEntities && knownEntities.length > 0
      ? `\nKnown entities likely to appear in this file — match these to mentions instead of creating duplicates, and prefer them as relationship endpoints:\n${knownEntities.map(renderKnown).join("\n")}\n`
      : "";

  const participantSection = participantBlock && participantBlock.length > 0 ? participantBlock : "";

  const prompt = `You are analyzing a document to identify meaningful business entities mentioned in it.
${orgSection}${knownSection}${participantSection}
File: ${file.fileName}
Source: ${file.source}${file.sourcePath ? ` / ${file.sourcePath}` : ""}
Type: ${file.contentCategory}

Extract entities that a business team would want to track and reference across documents. Focus on:
- **People**: named individuals (employees, clients, contacts)
- **Companies**: external businesses, clients, partners, vendors
- **Products**: named products or services your org builds or uses (e.g., "Canvas AI", "Sketch", "Meetup by Habuild")
- **Projects**: named umbrella engagements or programs with a clear scope (e.g., "OW Tourism Dashboard", "Paid Member Migration Phase 2", "K8S Migration")
- **Features**: stable named deliverables, workstreams, or components that can recur across files and normally sit inside a named project or product (e.g., "QTD/YTD implementation", "Visa Data Integration", "Aviation Edge scraper", "Access control integration"). Classify as a feature only when the phrase names a reusable piece of work; use \`part_of\` to link it to its parent.
- **Teams**: named organizational teams (e.g., "QC team", "Content Team")

DO NOT extract:
- Email addresses, phone numbers, URLs, or other system identifiers — these are stored separately. If a person is identifiable by name, use the name (e.g., "Sarah Chen"); never use an email address as the mention.
- Generic technologies, frameworks, or libraries (Redis, Kafka, Node.js, React, PostgreSQL, Express, Vite)
- Cloud infrastructure services (ECS, EKS, RDS, S3, Lambda, AWS Batch)
- Programming concepts or acronyms (LLM, NLP, API, SDK, REST, GraphQL, npm)
- Operating systems or platforms as entities (iOS, Android, Linux)
- Backlog lists, sprint names, or task board columns ("[Infra] Backlog", "Sprint 5", "Exp Sprint 2")
- Microservice names (auth-service, user-service, payment-service)
- Generic categories (SEO, Marketing, Support, Content)
- Countries, currencies, or generic locations (India, INR, US)
- File formats, protocols, or standards (JSON, HTTP, WebSocket)
- Meeting section titles, status notes, activity descriptions, metrics, generic verbs, or generic technical nouns as features
- Generic feature-like phrases with no stable named parent, such as "Vedant's Project Progress", "67 SQL queries on the new database", "limitation note", "UI development", "backend work", or "new database"

For each entity, provide the primary name, type, name variations, and a confidence score in [0, 1] reflecting how directly grounded the mention is in the text.

Feature examples:
- YES feature: "QTD/YTD implementation" part_of "Habuild Analytics"; "Aviation Edge scraper" part_of "OW Tourism Dashboard"; "Access control integration" part_of "Sketch"; "Visa Data Integration" part_of "OW Tourism Dashboard"
- NO feature: "Vedant's Project Progress"; "67 SQL queries on the new database"; "limitation note"; "UI development"; "backend work"; "new database"

Most relationships in a business corpus follow this hierarchy, top down: **Companies** (clients, partners, vendors) own engagements → **Projects** are named umbrella engagements with a defined scope → **Features** are specific named deliverables or workstreams inside a project or product → **People and Teams** work on those features and projects, either internally for their own team or on behalf of a client engagement. Prefer extracting from the top down. Prefer \`feature\` only when the work is clearly one named component of a larger named project or product; if no parent can be named or inferred and the phrase is generic, skip the feature rather than creating an orphan.

Also extract direct relationships only when the text explicitly supports them.

Valid relationship types:
- "works_at": person -> company (the person is employed by the company)
- "engaged_with": person | team | feature -> company (the person/team/feature is working with, for, or delivered to an external company without being employed by it — vendor, consultancy, or client-engagement context)
- "leads": person -> project | product | feature | team
- "contributes_to": person | team -> project | product | feature
- "builds": company -> product
- "part_of": project -> project, product -> product, feature -> project | product, team -> company
- "partner_of": company -> company

Use "engaged_with" (not "works_at") whenever the person's employer is a different company from the one named on the right. Example: a Canvas engineer meeting with Oliver Wyman is engaged_with Oliver Wyman, not works_at Oliver Wyman.

Use "part_of" to link a feature to its parent project (or, less commonly, parent product). Example: the "Aviation Edge scraper" feature is part_of the "OW Tourism Dashboard" project.

Known feature entities in the context above are allowed matches only when this file refers to the same named deliverable. Do not match generic meeting topics, progress notes, or activity descriptions to old feature entities.

When a "Meeting participants" block is present above and lists attendees from multiple companies, the cross-company link is itself relationship evidence even when the prose never names the external company. Emit \`engaged_with\` edges from home-company participants who are marked \`[action-item owner]\` to each external company present in the participants block. Treat silent external attendees (no action items) with caution — only emit when the prose corroborates it. Use the participant name and the external company name exactly as they appear in the block as the relation endpoints.

Return one JSON object:
{
  "mentions": [
    { "mention": "Project Atlas", "type": "project", "variations": ["Atlas", "the Atlas deal"], "confidence": 0.86 },
    { "mention": "Sarah Chen", "type": "person", "variations": ["Sarah", "S. Chen"], "confidence": 0.95 }
  ],
  "relations": [
    {
      "type": "leads",
      "source": { "name": "Sarah Chen", "type": "person", "variations": ["Sarah"] },
      "target": { "name": "Project Atlas", "type": "project", "variations": ["Atlas"] },
      "confidence": 0.92,
      "context": "Sarah Chen leads Project Atlas"
    }
  ]
}

Valid types: "person", "project", "feature", "company", "product", "team"

If no notable entities or relations are found, return { "mentions": [], "relations": [] }.

<content>
${truncatedContent}
</content>`;

  const parsed = await generator.generateJSON<ExtractedMention[] | EntityExtractionResult>(prompt, {
    maxTokens: 8192,
    label: `extractEntities:${file.id}`,
    dumpDir,
  });
  if (Array.isArray(parsed)) {
    return { mentions: parsed, relations: [] };
  }
  return {
    mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [],
    relations: Array.isArray(parsed.relations) ? parsed.relations : [],
  };
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
    await yieldToEventLoop();
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
        if (!PROPOSABLE_ENTITY_TYPES.has(mention.type as ProposeEntityType)) continue;
        const owner = await db
          .selectFrom("indexed_files")
          .innerJoin("connector_configs", "connector_configs.id", "indexed_files.connector_config_id")
          .select("connector_configs.created_by")
          .where("indexed_files.id", "=", fileId)
          .executeTakeFirst();
        const materializeDeps = await buildMaterializeDeps(db);
        const proposal = await proposeEntity(
          {
            entityRepo: materializeDeps.entityRepo,
            reviewRepo: materializeDeps.reviewRepo,
            lookup: materializeDeps.lookup,
            readEmail: materializeDeps.readEmail,
          },
          {
            name: mention.mention,
            entityType: mention.type as ProposeEntityType,
            subtype: "external",
            source: "llm_extraction",
            sourceId: `candidate:${existing.id}`,
            evidence: seenFileIds.map((indexedFileId) => ({ indexedFileId })),
            triggeredByUserId: owner?.created_by ?? "system",
            aliases: mention.variations,
            metadata: { origin: "ai" },
          },
        );

        if (proposal.kind === "queued") {
          logger.info(
            { entityName: mention.mention, reviewId: proposal.reviewId },
            "Queued entity candidate promotion",
          );
          continue;
        }

        const entity = proposal.entity;

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
            confidence: "INFERRED",
            source: "llm_extraction",
            relation: "mentioned",
          });
          await yieldToEventLoop();
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
    await yieldToEventLoop();
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
  dumpDir?: string,
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

  return generator.generate(prompt, { maxTokens: 256, label: `generateSummary:${file.id}`, dumpDir });
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
  deps: { db: Kysely<DB>; logger?: Logger; generator: GeminiGenerator; now?: () => number },
  file: FileContext,
  matchedEntities: MatchedEntity[],
  context: FactSelectionContext,
  cache: FactSelectionCache,
  dumpDir?: string,
): Promise<Map<string, LearnedFact[]>> {
  if (matchedEntities.length === 0) return new Map();

  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);
  let candidateFactCount = 0;
  let selectedFactCount = 0;
  let knownFactChars = 0;
  const entityDescriptions = (
    await Promise.all(
      matchedEntities.map(async (e) => {
        candidateFactCount += e.learnedFacts.length;
        const selectedFacts = await selectRelevantFacts(deps, e, context, cache);
        const facts = renderFactsForPrompt(selectedFacts);
        selectedFactCount += selectedFacts.length;
        knownFactChars += facts.length;
        return `- ID: ${e.entityId} | Name: ${e.name} (${e.sourceType}) | Definition: ${e.definition || "none"} | Known facts: ${facts || "none"}`;
      }),
    )
  ).join("\n");

  deps.logger?.info(
    {
      fileId: file.id,
      matchedEntityCount: matchedEntities.length,
      candidateFactCount,
      selectedFactCount,
      knownFactChars,
    },
    "extractEntityFacts: selected learned facts for prompt",
  );

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
    Object.entries(
      await deps.generator.generateJSON<Record<string, LearnedFact[]>>(prompt, {
        maxTokens: 8192,
        label: `extractEntityFacts:${file.id}`,
        dumpDir,
      }),
    ),
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

  const fileMeta = {
    fileId: file.id,
    fileName: file.fileName,
    source: file.source,
    contentCategory: file.contentCategory,
    contentChars: file.content.length,
    truncatedToChars: Math.min(file.content.length, MAX_CONTENT_CHARS),
    knownEntityCount: deps.knownEntities?.length ?? 0,
  };
  logger.info(fileMeta, "smartEnrichFile: start");

  const t0 = Date.now();
  let extraction: EntityExtractionResult;
  try {
    extraction = await extractEntities(
      generator,
      file,
      deps.orgContext,
      deps.knownEntities,
      deps.participantBlock,
      deps.debugDumpDir,
    );
  } catch (err) {
    logger.error({ ...fileMeta, stage: "extractEntities", err }, "smartEnrichFile: stage failed");
    throw err;
  }
  logger.info(
    {
      fileId: file.id,
      stage: "extractEntities",
      mentionCount: extraction.mentions.length,
      relationCount: extraction.relations.length,
      durationMs: Date.now() - t0,
    },
    "smartEnrichFile: stage done",
  );

  await reconcileLlmExtractionFacts(deps, file, extraction);

  const { matched, unmatched } = await matchEntities(db, extraction.mentions);
  const allMatched = matched.map((m) => m.entity);
  logger.debug(
    { fileId: file.id, matchedCount: matched.length, unmatchedCount: unmatched.length },
    "smartEnrichFile: entity match results",
  );

  const t1 = Date.now();
  const factSelectionContext = await buildFactSelectionContext(
    db,
    file.id,
    allMatched.map((entity) => entity.entityId),
  );
  const factSelectionCache = createFactSelectionCache();
  const [summaryResult, factsResult] = await Promise.allSettled([
    generateSummary(generator, file, allMatched, deps.debugDumpDir),
    extractEntityFacts(
      { db, logger, generator },
      file,
      allMatched,
      factSelectionContext,
      factSelectionCache,
      deps.debugDumpDir,
    ),
  ]);

  const summary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
  const factsMap = factsResult.status === "fulfilled" ? factsResult.value : new Map<string, LearnedFact[]>();

  if (summaryResult.status === "rejected") {
    logger.error({ ...fileMeta, stage: "generateSummary", err: summaryResult.reason }, "smartEnrichFile: stage failed");
  }
  if (factsResult.status === "rejected") {
    logger.warn(
      { ...fileMeta, stage: "extractEntityFacts", matchedEntityCount: allMatched.length, err: factsResult.reason },
      "smartEnrichFile: stage failed (continuing without entity facts)",
    );
  }

  if (!summary) {
    throw summaryResult.status === "rejected" ? summaryResult.reason : new Error("smartEnrichFile: empty summary");
  }

  logger.info(
    {
      fileId: file.id,
      stage: "summary+facts",
      summaryLength: summary.length,
      factEntityCount: factsMap.size,
      factsExtracted: factsResult.status === "fulfilled",
      durationMs: Date.now() - t1,
    },
    "smartEnrichFile: stage done",
  );

  await db.updateTable("indexed_files").set({ summary, summary_status: "done" }).where("id", "=", file.id).execute();

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

    const newFacts = facts
      .filter((f) => {
        const validation = validateLearnedFact(f.fact);
        if (!validation.ok) {
          logger.info({ fileId: file.id, entityId, reason: validation.reason }, "Dropped invalid learned fact");
          return false;
        }
        return true;
      })
      .map((f) => ({
        fact: f.fact,
        source_file_id: file.id,
        learned_at: new Date().toISOString().split("T")[0],
      }));
    if (newFacts.length === 0) continue;

    metadata.learned_facts = [...existingFacts, ...newFacts];

    await entityRepo.updateEntity(entityId, { metadata: JSON.stringify(metadata) });

    logger.debug({ entityId, newFactCount: facts.length }, "Updated entity definition");
    await yieldToEventLoop();
  }
}

async function reconcileLlmExtractionFacts(
  deps: SmartEnrichmentDeps,
  file: FileContext,
  extraction: EntityExtractionResult,
): Promise<void> {
  const { db } = deps;
  const factRepo = createIndexedFileFactRepository(db);
  const owner = await db
    .selectFrom("connector_configs")
    .select("created_by")
    .where("id", "=", file.connectorConfigId)
    .executeTakeFirst();
  const contentHash = file.contentHash ?? `missing-content-hash:${file.id}`;
  const emittedMentionKeys: string[] = [];
  const emittedRelationKeys: string[] = [];

  for (const mention of extraction.mentions) {
    if (mention.mention.length < MIN_ENTITY_NAME_LENGTH) continue;
    const validation = validateLlmMention({
      displayName: mention.mention,
      aliases: mention.variations,
      fileContent: file.content,
      source: "llm_extraction",
    });
    if (!validation.ok) {
      deps.logger.info(
        { fileId: file.id, displayName: mention.mention, reason: validation.reason },
        "Dropped invalid LLM mention",
      );
      continue;
    }
    const input: UpsertIndexedFileFactInput = {
      indexedFileId: file.id,
      connectorConfigId: file.connectorConfigId,
      createdByUserId: owner?.created_by ?? null,
      contentHash,
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: mention.mention,
      subjectSource: "llm_extraction",
      subjectSourceId: `${file.id}:${contentHash}:${LLM_EXTRACTION_PROMPT_VERSION}:${mention.mention}`,
      contextSnippet: null,
      raw: {
        contentHash,
        promptVersion: LLM_EXTRACTION_PROMPT_VERSION,
        model: "gemini",
        mention: mention.mention,
        type: mention.type,
        variations: mention.variations,
        confidence: typeof mention.confidence === "number" ? mention.confidence : 0.7,
      },
    };
    emittedMentionKeys.push(buildIndexedFileFactKey(input));
    await factRepo.upsertFact(input);
    await yieldToEventLoop();
  }

  for (const relation of extraction.relations) {
    const input = buildRelationFactInput({
      file,
      ownerUserId: owner?.created_by ?? null,
      contentHash,
      relation,
      mentions: extraction.mentions,
    });
    if (!input) continue;
    emittedRelationKeys.push(buildIndexedFileFactKey(input));
    await factRepo.upsertFact(input);
    await yieldToEventLoop();
  }

  const mentionReconcile = await factRepo.reconcileStaleFacts(
    { kind: "file", indexedFileId: file.id, source: "llm_extraction", factType: "llm_extracted" },
    new Set(emittedMentionKeys),
  );
  const relationReconcile = await factRepo.reconcileStaleFacts(
    { kind: "file", indexedFileId: file.id, source: "llm_extraction", factType: "llm_relation" },
    new Set(emittedRelationKeys),
  );
  await cleanupRelationshipEvidenceForFacts(db, [
    ...mentionReconcile.tombstonedFactIds,
    ...relationReconcile.tombstonedFactIds,
  ]);
  await cleanupEmptyRelationships(db);

  await db
    .deleteFrom("entity_mentions")
    .where("indexed_file_id", "=", file.id)
    .where("source", "=", "llm_extraction")
    .where("confidence", "!=", "EXTRACTED")
    .execute();

  await materializeUnmaterializedFacts(db, deps.logger);
}

const RELATION_TYPES = [
  "works_at",
  "engaged_with",
  "leads",
  "contributes_to",
  "builds",
  "part_of",
  "partner_of",
] as const;

function normalizeRelationType(raw: string): (typeof RELATION_TYPES)[number] | null {
  const normalized = raw.trim().toLowerCase();
  return (RELATION_TYPES as readonly string[]).includes(normalized)
    ? (normalized as (typeof RELATION_TYPES)[number])
    : null;
}

function buildRelationFactInput(input: {
  file: FileContext;
  ownerUserId: string | null;
  contentHash: string;
  relation: ExtractedRelation;
  mentions: ExtractedMention[];
}): UpsertIndexedFileFactInput | null {
  const relationType = normalizeRelationType(input.relation.type);
  if (!relationType || input.relation.confidence < 0.85) return null;
  const sourceName = input.relation.source.name?.trim();
  const targetName = input.relation.target.name?.trim();
  if (!sourceName || !targetName) return null;
  const sourceType = input.relation.source.type?.trim().toLowerCase();
  const targetType = input.relation.target.type?.trim().toLowerCase();
  if (!sourceType || !targetType) return null;
  const sourceConfidence = findMentionConfidence(input.mentions, input.relation.source);
  const targetConfidence = findMentionConfidence(input.mentions, input.relation.target);
  if (sourceConfidence < 0.8 || targetConfidence < 0.8) return null;

  return {
    indexedFileId: input.file.id,
    connectorConfigId: input.file.connectorConfigId,
    createdByUserId: input.ownerUserId,
    contentHash: input.contentHash,
    source: "llm_extraction",
    factType: "llm_relation",
    relation: relationType,
    subjectName: sourceName,
    subjectSource: "llm_extraction",
    subjectSourceId: `${input.file.id}:${input.contentHash}:${LLM_EXTRACTION_PROMPT_VERSION}:${relationType}:${sourceName}:${targetName}`,
    contextSnippet: input.relation.context ?? null,
    raw: {
      contentHash: input.contentHash,
      promptVersion: LLM_EXTRACTION_PROMPT_VERSION,
      model: "gemini",
      relationType,
      confidence: input.relation.confidence,
      sourceConfidence,
      targetConfidence,
      context: input.relation.context,
      source: {
        name: sourceName,
        type: sourceType,
        variations: input.relation.source.variations ?? [],
      },
      target: {
        name: targetName,
        type: targetType,
        variations: input.relation.target.variations ?? [],
      },
    },
  };
}

function findMentionConfidence(mentions: ExtractedMention[], endpoint: ExtractedRelationEndpoint): number {
  const names = [endpoint.name, ...(endpoint.variations ?? [])].map(normalizeName).filter((name) => name.length > 0);
  for (const mention of mentions) {
    const mentionNames = [mention.mention, ...mention.variations].map(normalizeName);
    if (!names.some((name) => mentionNames.includes(name))) continue;
    return typeof mention.confidence === "number" ? mention.confidence : 0.7;
  }
  return 0;
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
