/**
 * AI-powered enrichment pipeline.
 *
 * Uses Gemini Flash to:
 * 1. Extract entity mentions from file content (with name variations)
 * 2. Match against entity register, promote candidates on multi-file confirmation
 * 3. Generate grounded file summaries (using matched entity definitions as context)
 * 4. Extract and append new facts to entity definitions
 *
 * When Gemini is unavailable, callers skip AI extraction and mark summaries accordingly.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { upsertFeatureFact } from "../db/repositories/features";
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
  coerceMentionType,
  isHighConfidenceEndpoint,
  isHighConfidenceRelation,
  normalizeMentionType,
  normalizeRelationEndpointType,
  normalizeRelationType,
} from "../entities/graph";
import {
  buildMaterializeDeps,
  cleanupEmptyRelationships,
  cleanupRelationshipEvidenceForFacts,
  materializeUnmaterializedFacts,
} from "../entities/materialize";
import { reconcileFeatureSubEntity } from "../entities/materialize-feature";
import type { MaterializeDeps } from "../entities/materialize-types";
import { tokenizeName } from "../entities/name-tokenize";
import { HIDDEN_ENTITY_SOURCE_TYPES } from "../entities/profile-facts";
import { type ProposeEntityType, proposeEntity } from "../entities/propose";
import {
  isDomainOrUrlOrEmailName,
  isEmailProviderName,
  validateLearnedFact,
  validateLlmMention,
} from "../entities/validators";
import { yieldToEventLoop } from "../lib/event-loop";
import { STRUCTURAL_TASK_FILE_TYPES } from "./document-facts";
import {
  type NameDedupEntityType,
  reconcileMissingNameEmbeddings,
  retrieveNameDedupCandidates,
} from "./embeddings/trunk-name-embeddings";
import type { EmbeddingProvider } from "./embeddings/types";
import { isGenericEngagementName } from "./engagement-name-filter";
import type { MintContextBlock, StageOutcome, StageReporter } from "./enrichment-stage-report";
import { isCodeShapedFeatureName } from "./feature-name-filter";
import type { KnownEntityForPrompt } from "./file-scope-context";
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
import { SLACK_CONVERSATION_SLICE_FILE_TYPE, WHATSAPP_CONVERSATION_SLICE_FILE_TYPE } from "./types";

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
const LLM_EXTRACTION_PROMPT_VERSION = "llm-extraction-v13";
const DEDUP_PROMPT_VERSION = "dedup-adjudication-v1";
const GENERIC_DEDUP_TOKENS = new Set([
  "a",
  "ai",
  "an",
  "and",
  "app",
  "by",
  "dashboard",
  "data",
  "for",
  "in",
  "new",
  "of",
  "on",
  "platform",
  "project",
  "system",
  "the",
  "to",
  "tool",
  "view",
  "with",
]);
/**
 * `team` is intentionally absent: teams are never proposed by the LLM. A team
 * is a structural object (e.g. a Linear team) and is born only through
 * structural seeding. The LLM may still *match* a mention to an existing team
 * (see `MATCHABLE_ENTITY_TYPES`), but never create one.
 */
const BASE_PROPOSABLE_ENTITY_TYPES: ProposeEntityType[] = ["person", "project", "company", "product", "tool"];
const MATCHABLE_ENTITY_TYPES: ProposeEntityType[] = ["person", "project", "company", "product", "team", "deal"];
const SPINE_TYPES_FROM_STRUCTURE = new Set<ProposeEntityType>(["project", "team"]);

function proposableEntityTypes(fileType?: string | null): Set<ProposeEntityType> {
  const types = [...BASE_PROPOSABLE_ENTITY_TYPES];
  let set = new Set(types);
  if (fileType && STRUCTURAL_TASK_FILE_TYPES.has(fileType.toLowerCase())) {
    set = new Set([...set].filter((type) => !SPINE_TYPES_FROM_STRUCTURE.has(type)));
  }
  return set;
}

function extractionValidTypes(fileType?: string | null): Set<string> {
  const types = new Set<string>(proposableEntityTypes(fileType));
  types.add("feature");
  return types;
}

// ── Types ────────────────────────────────────────────────────────────────

interface ExtractedMention {
  mention: string;
  type: string;
  variations: string[];
  confidence?: number;
  parentProduct?: string;
  matchesKnown?: string;
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

interface ExtractionOrgContext {
  orgName?: string;
  description?: string;
  industry?: string;
  disambiguationGuidance?: string;
}

interface SmartEnrichmentDeps {
  db: Kysely<DB>;
  logger: Logger;
  generator: GeminiGenerator;
  embeddingProvider: EmbeddingProvider | null;
  orgContext?: ExtractionOrgContext | null;
  /** Known product/team entities to include in extraction prompt for better matching. */
  knownEntities?: KnownEntityForPrompt[];
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
  stageReport?: StageReporter;
  ensureFresh?: () => Promise<void>;
}

interface FileContext {
  id: string;
  fileName: string;
  content: string;
  threadContext?: string | null;
  contentCategory: string;
  fileType?: string | null;
  source: string;
  sourcePath: string | null;
  contentHash: string | null;
  connectorConfigId: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

function isConversationalFile(file: Pick<FileContext, "fileType">): boolean {
  return (
    file.fileType === WHATSAPP_CONVERSATION_SLICE_FILE_TYPE || file.fileType === SLACK_CONVERSATION_SLICE_FILE_TYPE
  );
}

type FileContentVersion = {
  contentHash: string | null;
  contentCategory: string;
  content: string;
  sourceUpdatedAt: string | null;
};

type ContentVersionGuardable<T> = {
  where(column: "content_category", op: "=", value: string): T;
  where(column: "content_hash", op: "=", value: string): T;
  where(column: "content_hash", op: "is", value: null): T;
  where(column: "content", op: "=", value: string): T;
  where(column: "source_updated_at", op: "=", value: string): T;
  where(column: "source_updated_at", op: "is", value: null): T;
};

function noRowsUpdated(result: { numUpdatedRows?: bigint | number }): boolean {
  const count = result.numUpdatedRows ?? 0;
  return typeof count === "bigint" ? count === BigInt(0) : count === 0;
}

function staleEnrichmentError(fileId: string): Error {
  const err = new Error(`Stale smart enrichment result for file ${fileId}`);
  err.name = "StaleEnrichmentError";
  return err;
}

function assertFreshUpdate(result: { numUpdatedRows?: bigint | number }, fileId: string): void {
  if (noRowsUpdated(result)) throw staleEnrichmentError(fileId);
}

function isStaleEnrichmentError(err: unknown): boolean {
  return err instanceof Error && err.name === "StaleEnrichmentError";
}

function contentVersionOf(file: FileContext): FileContentVersion {
  return {
    contentHash: file.contentHash,
    contentCategory: file.contentCategory,
    content: file.content,
    sourceUpdatedAt: file.sourceUpdatedAt,
  };
}

function applyContentVersionWhere<T extends ContentVersionGuardable<T>>(query: T, version: FileContentVersion): T {
  const guarded = query.where("content_category", "=", version.contentCategory);
  if (version.contentHash === null) {
    return guarded.where("content_hash", "is", null).where("content", "=", version.content);
  }
  return guarded.where("content_hash", "=", version.contentHash);
}

async function withFreshFileWriteLock<T>(
  db: Kysely<DB>,
  fileId: string,
  version: FileContentVersion,
  write: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const lockQuery = trx
      .updateTable("indexed_files")
      .set({ embedding_status: sql<string>`embedding_status` })
      .where("id", "=", fileId);
    const lockResult = await applyContentVersionWhere(lockQuery, version).executeTakeFirst();
    assertFreshUpdate(lockResult, fileId);
    return write(trx);
  });
}

function renderKnown(e: KnownEntityForPrompt, index: number): string {
  const parts: string[] = [`- [K${index + 1}] ${e.name} (${e.type})`];
  if (e.description) parts.push(`: ${e.description}`);
  const tags: string[] = [];
  if (typeof e.mentionCount === "number" && e.mentionCount > 0) {
    tags.push(`${e.mentionCount} recent files`);
  }
  if (e.recentlyActive) tags.push("active in last 2 weeks");
  if (tags.length > 0) parts.push(` · ${tags.join(" · ")}`);
  return parts.join("");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractionContextBlocks(
  file: FileContext,
  knownEntities: KnownEntityForPrompt[] | undefined,
  participantBlock: string | undefined,
): MintContextBlock[] {
  const knownItems = (knownEntities ?? []).slice(0, 20).map(renderKnown);
  const blocks: MintContextBlock[] = [
    {
      key: "knownEntities",
      label: "Known entities",
      selection:
        "Known entities likely to appear in this file, selected by file anchors, adjacency, verbatim baseline matches, and pending proposals; display capped at 20.",
      total: knownEntities?.length ?? 0,
      items: knownItems,
      truncated: (knownEntities?.length ?? 0) > knownItems.length,
      via: "prompt",
    },
    {
      key: "content",
      label: "Content",
      selection: `First ${MAX_CONTENT_CHARS} characters of file content sent to the extraction model.`,
      total: file.content.length,
      items: [`${Math.min(file.content.length, MAX_CONTENT_CHARS)} characters sent`],
      truncated: file.content.length > MAX_CONTENT_CHARS,
      via: "prompt",
    },
  ];
  if (participantBlock) {
    blocks.push({
      key: "participants",
      label: "Participant block",
      selection: "Meeting or message participants resolved from connector facts for this file.",
      total: participantBlock.split("\n").filter(Boolean).length,
      items: participantBlock.split("\n").filter(Boolean).slice(0, 20),
      truncated: participantBlock.split("\n").filter(Boolean).length > 20,
      via: "prompt",
    });
  }
  return blocks;
}

function outcomeForMention(
  mention: Pick<ExtractedMention, "mention" | "type">,
  result: StageOutcome["result"],
  reason?: string,
): StageOutcome {
  return { subject: mention.mention, kind: mention.type, result, ...(reason ? { reason } : {}) };
}

// ── Entity Extraction ────────────────────────────────────────────────────

/**
 * Extract entity mentions from file content using Gemini Flash.
 */
export async function extractEntities(
  generator: GeminiGenerator,
  file: FileContext,
  orgContext?: ExtractionOrgContext | null,
  knownEntities?: KnownEntityForPrompt[],
  participantBlock?: string,
  dumpDir?: string,
  allowedTypes = extractionValidTypes(file.fileType),
): Promise<EntityExtractionResult> {
  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);

  const orgSection = orgContext?.description
    ? `\nBackground on the organization that operates this system (${orgContext.orgName ?? "Unknown"}${orgContext.industry ? `, industry: ${orgContext.industry}` : ""}). This is context for disambiguation only — do NOT extract an entity merely because it is named in this background. Extract only entities the document content below actually refers to:\n${orgContext.description}\n`
    : "";
  const disambiguationSection = orgContext?.disambiguationGuidance
    ? `\nProduct/disambiguation guidance:\n${orgContext.disambiguationGuidance}\n`
    : "";

  const knownSection =
    knownEntities && knownEntities.length > 0
      ? `\nKnown entities likely to appear in this file — each has a handle like [K1]. Match these to mentions instead of creating duplicates, and prefer them as relationship endpoints. Product entries here are the injected known-products list; map product mentions to those entries instead of inventing new product names.\n${knownEntities.map(renderKnown).join("\n")}\n`
      : "";

  const participantSection = participantBlock && participantBlock.length > 0 ? participantBlock : "";
  const threadSection = file.threadContext
    ? `\nEmail thread context for resolving references only. Do not emit entities or relationships that appear only in this context; emitted mentions and relationships must be supported by the current message content below.\n${file.threadContext}\n`
    : "";
  const validTypes = [...allowedTypes];
  const validTypesPrompt = validTypes.map((type) => `"${type}"`).join(", ");
  const toolFocusLine =
    "- **Tools**: third-party SaaS apps/platforms the org uses (e.g., Slack, Notion, Zoom, Figma, GitHub)\n";
  const featureFocusLine =
    '- **Features**: a feature is a named sub-capability, module, tab, or screen within a product (e.g., "CRM Analytics", "Push Notifications"). Emit it as type "feature" and set "parentProduct" to the product it belongs to. A feature\'s parentProduct must be a product or project name, never a domain, URL, or email. Never emit a feature as a product or project.\n';
  const featureNoiseLine = "- Do not emit class names, DTOs, code symbols, table names, or column names as features.\n";
  const featureSchemaInstruction =
    '\nFor feature mentions, include "parentProduct" with the product the feature belongs to. Omit "parentProduct" for non-feature mentions.\n';
  const mentionExamples = `    { "mention": "Project Atlas", "type": "project", "variations": ["Atlas", "the Atlas deal"], "confidence": 0.86 },
    { "mention": "Sarah Chen", "type": "person", "variations": ["Sarah", "S. Chen"], "confidence": 0.95 },
    { "mention": "CRM Analytics", "type": "feature", "parentProduct": "Canvas CRM", "variations": ["Analytics tab"], "confidence": 0.91 }`;
  const relationshipTypesPrompt = `Valid relationship types:
- "works_at": person -> company (the person is employed by the company)
- "engaged_with": person -> company (the person is working with, for, or delivered to an external company without being employed by it — vendor, consultancy, or client-engagement context)
- "leads": person -> project | product
- "contributes_to": person -> project | product
- "builds": company -> product
- "part_of": project -> project, project -> product, product -> product
- "engagement_for": project -> company (the project is a client engagement delivered for that company)
- "partner_of": company -> company`;
  const engagementHint =
    'Use "engagement_for" for a PROJECT delivered for a client company; use "engaged_with" for a PERSON working with a company.';

  const prompt = `You are analyzing a document to identify meaningful business entities mentioned in it.
${orgSection}${disambiguationSection}${knownSection}${participantSection}${threadSection}
File: ${file.fileName}
Source: ${file.source}${file.sourcePath ? ` / ${file.sourcePath}` : ""}
Type: ${file.contentCategory}

Extract entities that a business team would want to track and reference across documents. Focus on:
- **People**: named individuals (employees, clients, contacts)
- **Companies**: external businesses, clients, partners, vendors
- **Products**: named products or services your org or your client builds or owns. When product entries appear in the Known entities section, treat that injected known-products list as the source of truth instead of inventing product names.
- **Projects**: named umbrella engagements or programs with their own scope and timeline (e.g., "OW Tourism Dashboard", "Paid Member Migration Phase 2", "K8S Migration"). A project is the umbrella, NOT a single ticket, pull request, or one feature of a product.
${toolFocusLine}${featureFocusLine}

DO NOT extract:
${featureNoiseLine}
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
- Meeting titles or calendar event names — anything containing "<>", "Standup", "Sync", "Weekly", "Daily", or "1:1". These are calendar event names, not projects. Extract the companies and people referenced by the meeting instead.
- Document, note, or artifact titles as projects (e.g. names ending in "note", "chart", "doc", "spec", "deck"). These are filenames, not engagements.
- Issue or ticket identifiers and keys — "SKE-123", "ECR-01", "ABC-1234", or a bare "#192". These are individual work items, not projects; extract the project or product they belong to instead, never the ticket key (even when the key is followed by a title, e.g. "SKE-120: Provenance columns").
- Pull requests, commits, or branches — "PR #192", commit SHAs, branch names. These are code artifacts, not engagements.
- A single feature, tab, screen, or module of a product as a project — "Files", "Workflows", "Analytics", "Push Notifications", "Outlook Integration". These are parts of a product, not umbrella engagements with their own scope.
- Generic feature descriptions or internal component names as products (e.g. "responder functionality", "conversational model", "X service", "X module", "X pipeline"). Products must be a branded, proper-noun name your org or a client publicly markets — not the internal name of a component you are building.
- Capability areas, risk/compliance domains, and meeting-agenda headings are NOT projects — e.g. "Cloud", "Data & AI", "AML", "Fraud", "Risk", "Compliance", "Vendor Strategy", "Stakeholder Alignment", "RFP follow-ups".
- Meeting section titles, status notes, activity descriptions, metrics, generic verbs, or generic technical nouns
- Task fragments or implementation notes with no stable named project/product parent, such as "Vedant's Project Progress", "67 SQL queries on the new database", "limitation note", "UI development", "backend work", or "new database"

Name shape rules (person mentions only):
- Person mentions must be Title Case with a recognizable first + last name separated by whitespace (e.g. "Sarah Chen", "Ashish Banka"). Reject and omit:
  - Single first names with no surname or other identifier ("Sarah", "Mohammed", "Manish")
  - Initials-only strings ("KT", "P C", "SB", "VD")
  - Email-handle style strings — no spaces, lowercase, or otherwise looks like an email local part ("bhavyasharma", "nancyjain", "ayushgupta")
  - ALL-CAPS strings ("ASHISH BANKA", "RAJ BHOSLE")
  - Whitespace-only or non-printing strings
- When the source uses one of these degraded forms, omit the mention rather than emit the degraded version. If you can recover the proper-name form in Title Case with high confidence from surrounding context, emit the recovered form.

Type disambiguation:
- Any mention ending in "Pvt Ltd", "Private Limited", "Inc", "LLC", "Ltd", "GmbH", "Consulting", "Solutions", or "Technologies" is type "company", never "person", regardless of where it appears (including the participant block).
- Third-party data sources, market-data providers, and SaaS you merely integrate with or pull data from are type "tool", not "product"; e.g. a flight/hotel/market-data API or provider you consume is a tool.

For each entity, provide the primary name, type, name variations, and a confidence score in [0, 1] reflecting how directly grounded the mention is in the text.
${featureSchemaInstruction}

If email thread context is provided, use it only to resolve references in the current message. Do not extract an entity or relationship unless the current message refers to it directly or indirectly.

Most relationships in a business corpus follow this hierarchy, top down: **Companies** (clients, partners, vendors) own engagements → **Projects** are named umbrella engagements with a defined scope → **Products** are named offerings or tools → **People** work on those projects and products, either internally for their own team or on behalf of a client engagement. Prefer extracting from the top down.

Also extract direct relationships only when the text explicitly supports them.

${relationshipTypesPrompt}

Use "engaged_with" (not "works_at") whenever the person's employer is a different company from the one named on the right. Example: a Canvas engineer meeting with Oliver Wyman is engaged_with Oliver Wyman, not works_at Oliver Wyman.
${engagementHint}
Do not extract "member_of", "deal_for", or "primary_contact" from prose; those are connector-sourced relationships.

When a "Meeting participants" block is present above and lists attendees from multiple companies, the cross-company link is itself relationship evidence even when the prose never names the external company. Emit \`engaged_with\` edges from home-company participants who are marked \`[action-item owner]\` to each external company present in the participants block. Treat silent external attendees (no action items) with caution — only emit when the prose corroborates it. Use the participant name and the external company name exactly as they appear in the block as the relation endpoints.

Return one JSON object:
{
  "mentions": [
${mentionExamples}
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

Valid types: ${validTypesPrompt}

If no notable entities or relations are found, return { "mentions": [], "relations": [] }.

<content>
${truncatedContent}
</content>`;

  const parsed = await generator.generateJSON<ExtractedMention[] | EntityExtractionResult>(prompt, {
    maxTokens: 8192,
    label: `extractEntities:${file.id}`,
    dumpDir,
  });
  const mentions = Array.isArray(parsed) ? parsed : Array.isArray(parsed.mentions) ? parsed.mentions : [];
  const relations = Array.isArray(parsed) ? [] : Array.isArray(parsed.relations) ? parsed.relations : [];
  return { mentions, relations };
}

interface AdjudicateKnownMatchesOptions {
  fileId: string;
  debugDumpDir?: string;
  logger?: Logger;
  rejectedKnownMatchPairs?: Set<string>;
  anchorNames?: string[];
}

type DedupAdjudicationRow = {
  mention?: unknown;
  matchesKnown?: unknown;
};

function isProjectOrProductMention(mention: ExtractedMention): boolean {
  const type = mention.type.trim().toLowerCase();
  return type === "project" || type === "product";
}

export function projectProductMentionNames(mentions: Array<Pick<ExtractedMention, "mention" | "type">>) {
  const seen = new Set<string>();
  const queries: Array<{ name: string; type: NameDedupEntityType }> = [];
  for (const mention of mentions) {
    const name = mention.mention.trim();
    const type = mention.type.trim().toLowerCase();
    if (!name) continue;
    if (type !== "project" && type !== "product") continue;
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ name, type });
  }
  return queries;
}

export function mergeKnownEntities(
  existing: KnownEntityForPrompt[],
  retrieved: KnownEntityForPrompt[],
): KnownEntityForPrompt[] {
  const byKey = new Map<string, KnownEntityForPrompt>();
  for (const entity of existing) {
    byKey.set(`${entity.type}:${entity.name.toLowerCase()}`, entity);
  }
  for (const entity of retrieved) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, entity);
  }
  return Array.from(byKey.values());
}

function normalizeDedupRejectionKey(entityId: string, mentionName: string): string {
  return `${entityId}:${normalizeName(mentionName)}`;
}

function derivedAnchorNames(knownEntities: KnownEntityForPrompt[]): string[] {
  return knownEntities
    .filter((entity) => {
      const type = entity.type.trim().toLowerCase();
      return type === "company" || type === "person";
    })
    .map((entity) => entity.name);
}

export function hasDistinctiveOverlap(mentionName: string, candidateName: string, anchorNames: string[]): boolean {
  const anchorTokens = new Set(anchorNames.flatMap(tokenizeName));
  const candidateTokens = new Set(tokenizeName(candidateName));
  for (const token of tokenizeName(mentionName)) {
    if (token.length < 2) continue;
    if (!candidateTokens.has(token)) continue;
    if (GENERIC_DEDUP_TOKENS.has(token)) continue;
    if (anchorTokens.has(token)) continue;
    return true;
  }
  return false;
}

function buildDedupPrompt(input: {
  mentionLines: string;
  knownLines: string;
}): string {
  return `Prompt version: ${DEDUP_PROMPT_VERSION}

NEVER merge related-but-distinct entities, same-client sibling projects, parent/child initiatives, or entities that merely share generic words.
You are adjudicating entity deduplication. Only mark a match when the extracted mention is the SAME real-world project or product as one known candidate.

Worked examples:
- "Tourism dashboard" and "[OW x Canvasx] Tourism Recovery Dashboard" are the same when the document clearly uses the short form for that dashboard.
- "Maaden Dashboard" and "Maaden Sites" are NOT the same. They are related but distinct.
- "War Dashboard" and a tourism recovery dashboard are NOT the same. Sharing "dashboard" is not enough.

Extracted mentions:
${input.mentionLines}

Known candidates:
${input.knownLines}

For each extracted mention handle, return exactly one object. Use the candidate handle only when it is the same real-world entity and the same type; otherwise use null.
Return only JSON in this shape:
[
  { "mention": "M1", "matchesKnown": "K2" },
  { "mention": "M2", "matchesKnown": null }
]`;
}

function safeErrorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export async function adjudicateKnownMatches(
  generator: GeminiGenerator | null | undefined,
  mentions: ExtractedMention[],
  knownEntities: KnownEntityForPrompt[] | undefined,
  opts: AdjudicateKnownMatchesOptions,
): Promise<Map<string, string>> {
  for (const mention of mentions) {
    mention.matchesKnown = undefined;
  }

  if (!generator || !knownEntities || knownEntities.length === 0) return new Map();
  const dedupMentions = mentions.filter(isProjectOrProductMention);
  if (dedupMentions.length === 0) return new Map();

  const mentionByHandle = new Map(dedupMentions.map((mention, index) => [`M${index + 1}`, mention]));
  const knownByHandle = new Map(knownEntities.map((entity, index) => [`K${index + 1}`, entity]));
  const mentionLines = dedupMentions
    .map((mention, index) => `- [M${index + 1}] ${mention.mention} (${mention.type})`)
    .join("\n");
  const knownLines = knownEntities.map(renderKnown).join("\n");
  const anchorNames = opts.anchorNames ?? derivedAnchorNames(knownEntities);

  try {
    const rows = await generator.generateJSON<unknown>(buildDedupPrompt({ mentionLines, knownLines }), {
      maxTokens: 1024,
      label: `dedupAdjudicate:${opts.fileId}`,
      dumpDir: opts.debugDumpDir,
    });
    if (!Array.isArray(rows)) throw new Error("dedup adjudication response was not an array");

    const accepted = new Map<ExtractedMention, { handle: string; canonical: string }>();
    const seenMentions = new Set<string>();
    for (const row of rows as DedupAdjudicationRow[]) {
      if (!row || typeof row !== "object") continue;
      if (typeof row.mention !== "string") continue;
      if (seenMentions.has(row.mention)) continue;
      const mention = mentionByHandle.get(row.mention);
      if (!mention) continue;
      seenMentions.add(row.mention);
      if (row.matchesKnown === null || row.matchesKnown === undefined) continue;
      if (typeof row.matchesKnown !== "string") continue;
      if (row.matchesKnown.trim().toLowerCase() === "none") continue;
      const known = knownByHandle.get(row.matchesKnown);
      if (!known) continue;
      if (known.type !== mention.type) continue;
      const knownEntityId = known.entityId ?? known.id;
      if (
        knownEntityId &&
        opts.rejectedKnownMatchPairs?.has(normalizeDedupRejectionKey(knownEntityId, mention.mention))
      ) {
        continue;
      }
      if (!hasDistinctiveOverlap(mention.mention, known.name, anchorNames)) continue;
      accepted.set(mention, { handle: row.matchesKnown, canonical: known.name });
    }

    const rewriteMap = new Map<string, string>();
    for (const [mention, match] of accepted) {
      mention.matchesKnown = match.handle;
      if (mention.mention !== match.canonical) {
        rewriteMap.set(rewriteMapKey(mention.type, mention.mention), match.canonical);
      }
    }
    return rewriteMap;
  } catch (err) {
    opts.logger?.warn(
      { fileId: opts.fileId, stage: "dedupAdjudicate", errorName: safeErrorName(err) },
      "smartEnrichFile: dedup adjudication failed open",
    );
    return new Map();
  }
}

/**
 * Apply each mention's `matchesKnown` handle (e.g. "K1") by rewriting the
 * mention to the known entity's canonical name when their types agree. The
 * original surface form is preserved in `variations` so downstream matching can
 * still recognize the document spelling. Rewriting to the canonical name lets
 * the existing exact-name path link to a confirmed entity OR dedupe onto the
 * same pending-proposal queue row, with no new direct-link code path. Invalid,
 * out-of-range, or type-mismatched handles are ignored. Mutates in place.
 */
function resolveKnownMatches(
  mentions: ExtractedMention[],
  knownEntities?: Array<{ name: string; type: string }>,
): void {
  if (!knownEntities || knownEntities.length === 0) return;
  for (const mention of mentions) {
    const handle = mention.matchesKnown;
    if (typeof handle !== "string") continue;
    const match = /^K(\d+)$/i.exec(handle.trim());
    if (!match) continue;
    const index = Number.parseInt(match[1], 10) - 1;
    const known = knownEntities[index];
    if (!known || !known.name) continue;
    if (known.type !== mention.type) continue;
    if (known.name === mention.mention) continue;
    const original = mention.mention;
    mention.mention = known.name;
    const variations = Array.isArray(mention.variations) ? mention.variations : [];
    if (original && !variations.some((v) => v.toLowerCase() === original.toLowerCase())) {
      variations.push(original);
    }
    mention.variations = variations;
  }
}

async function listRejectedKnownMatchPairs(
  db: Kysely<DB>,
  knownEntities: KnownEntityForPrompt[] | undefined,
): Promise<Set<string>> {
  const entityIds = [
    ...new Set(
      (knownEntities ?? [])
        .map((entity) => entity.entityId ?? entity.id)
        .filter((entityId): entityId is string => typeof entityId === "string" && entityId.length > 0),
    ),
  ];
  if (entityIds.length === 0) return new Set();
  return createEntityReviewRepo(db).listRejectedNamesForEntities(entityIds);
}

function rewriteMapKey(type: string, name: string): string {
  return `${type}:${name}`;
}

function applyCanonicalRewriteMap(extraction: EntityExtractionResult, rewriteMap: Map<string, string>): void {
  if (rewriteMap.size === 0) return;
  for (const relation of extraction.relations) {
    const sourceName = rewriteMap.get(rewriteMapKey(relation.source.type, relation.source.name));
    if (sourceName) relation.source.name = sourceName;
    const targetName = rewriteMap.get(rewriteMapKey(relation.target.type, relation.target.name));
    if (targetName) relation.target.name = targetName;
  }
  for (const mention of extraction.mentions) {
    if (!isFeatureMention(mention) || !mention.parentProduct) continue;
    const parentProduct =
      rewriteMap.get(rewriteMapKey("product", mention.parentProduct)) ??
      rewriteMap.get(rewriteMapKey("project", mention.parentProduct));
    if (parentProduct) mention.parentProduct = parentProduct;
  }
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
      const trimmed = name.trim();
      if (!trimmed) continue;
      const sourceTypes = MATCHABLE_ENTITY_TYPES.filter((type) => !HIDDEN_ENTITY_SOURCE_TYPES.has(type));

      /**
       * Below the minimum length only exact whole-string equality is allowed.
       * The guard exists because `searchEntities` matches substrings, where a
       * short value is nearly always a false positive ("OW" inside "power").
       * Equality against a committed alias carries no such risk, so a real
       * two-letter alias like "OW" resolves instead of being dropped.
       */
      const results =
        trimmed.length < MIN_ENTITY_NAME_LENGTH
          ? await entityRepo.findEntitiesByExactNameOrAlias(trimmed, { sourceTypes, limit: 5 })
          : await entityRepo.searchEntities(trimmed, { sourceTypes, limit: 5 });
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
  allowedTypes = proposableEntityTypes(),
): Promise<MatchedEntity[]> {
  const { db, logger } = deps;
  const entityRepo = createEntityRepository(db);
  const promoted: MatchedEntity[] = [];

  for (const rawMention of unmatched) {
    const mention = {
      ...rawMention,
      type: coerceMentionType(rawMention.mention, rawMention.type),
    };
    if (!allowedTypes.has(mention.type as ProposeEntityType)) continue;
    if (mention.mention.length < MIN_ENTITY_NAME_LENGTH) continue;
    if ((mention.type === "project" || mention.type === "product") && isGenericEngagementName(mention.mention)) {
      logger.info(
        { fileId, displayName: mention.mention, reason: "generic_engagement_name" },
        "Dropped generic engagement-name mention",
      );
      continue;
    }

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
            domainsRepo: materializeDeps.domainsRepo,
            lookup: materializeDeps.lookup,
            logger: materializeDeps.logger,
            birthGateTypes: materializeDeps.birthGateTypes,
            birthGateLiveTypes: materializeDeps.birthGateLiveTypes,
            birthGateDryRun: materializeDeps.birthGateDryRun,
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
            provenanceTier: "inferred",
          },
        );

        if (proposal.kind === "queued") {
          logger.info(
            { entityName: mention.mention, reviewId: proposal.reviewId },
            "Queued entity candidate promotion",
          );
          continue;
        }
        if (proposal.kind === "suppressed") {
          logger.info(
            { entityName: mention.mention, reason: proposal.reason },
            "Suppressed entity candidate promotion",
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
${file.threadContext ? `\nEmail thread context for resolving this message:\n${file.threadContext}\n` : ""}

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

interface LearnedFactRetraction {
  factKey?: string;
  entityId?: string;
  fact?: string;
}

interface EntityFactExtractionResult {
  facts: Map<string, LearnedFact[]>;
  retractions: LearnedFactRetraction[];
}

interface ExistingIndexedLlmFact {
  factKey: string;
  factType: string;
  relation: string;
  subjectName: string | null;
  raw: string | null;
}

interface ConversationalSliceState {
  conversational: boolean;
  open: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderDifferentialLearnedFacts(facts: LearnedFactStored[]): string {
  return facts
    .map((fact) => {
      const key = learnedFactKey(fact);
      return key ? `${fact.fact} [learned_fact_key: ${key}]` : fact.fact;
    })
    .join("; ");
}

function indexedFactText(fact: ExistingIndexedLlmFact): string {
  if (fact.factType === "llm_relation" && fact.raw) {
    try {
      const raw = JSON.parse(fact.raw) as {
        relationType?: unknown;
        source?: { name?: unknown };
        target?: { name?: unknown };
      };
      if (
        typeof raw.source?.name === "string" &&
        typeof raw.target?.name === "string" &&
        typeof (raw.relationType ?? fact.relation) === "string"
      ) {
        return `${raw.source.name} ${raw.relationType ?? fact.relation} ${raw.target.name}`;
      }
    } catch {
      return fact.subjectName ?? fact.relation;
    }
  }
  if (fact.raw) {
    try {
      const raw = JSON.parse(fact.raw) as { mention?: unknown };
      if (typeof raw.mention === "string") return raw.mention;
    } catch {
      return fact.subjectName ?? fact.relation;
    }
  }
  return fact.subjectName ?? fact.relation;
}

function parseEntityFactResponse(value: unknown, existingFacts: ExistingIndexedLlmFact[]): EntityFactExtractionResult {
  if (!isObject(value)) return { facts: new Map(), retractions: [] };
  const factContainer = isObject(value.facts) ? value.facts : value;
  const facts = new Map<string, LearnedFact[]>();
  for (const [entityId, rawFacts] of Object.entries(factContainer)) {
    if (entityId === "facts" || entityId === "retractions" || entityId === "retracted_fact_keys") continue;
    if (!Array.isArray(rawFacts)) continue;
    const validFacts = rawFacts.filter(
      (fact): fact is LearnedFact => isObject(fact) && typeof fact.fact === "string" && fact.fact.trim().length > 0,
    );
    if (validFacts.length > 0) facts.set(entityId, validFacts);
  }

  const rawRetractions = [
    ...(Array.isArray(value.retracted_fact_keys) ? value.retracted_fact_keys : []),
    ...(Array.isArray(value.retractions) ? value.retractions : []),
  ];
  const existingByText = new Map(
    existingFacts.map((fact) => [normalizeLearnedFactContent(indexedFactText(fact)), fact.factKey]),
  );
  const existingKeys = new Set(existingFacts.map((fact) => fact.factKey));
  const retractions: LearnedFactRetraction[] = [];
  for (const rawRetraction of rawRetractions) {
    if (typeof rawRetraction === "string") {
      if (existingKeys.has(rawRetraction)) retractions.push({ factKey: rawRetraction });
      continue;
    }
    if (!isObject(rawRetraction)) continue;
    const factKey = typeof rawRetraction.fact_key === "string" ? rawRetraction.fact_key : undefined;
    const fact =
      typeof rawRetraction.fact === "string"
        ? rawRetraction.fact
        : typeof rawRetraction.text === "string"
          ? rawRetraction.text
          : undefined;
    const entityId =
      typeof rawRetraction.entity_id === "string"
        ? rawRetraction.entity_id
        : typeof rawRetraction.entityId === "string"
          ? rawRetraction.entityId
          : undefined;
    const mappedFactKey = factKey ?? (fact ? existingByText.get(normalizeLearnedFactContent(fact)) : undefined);
    if (!mappedFactKey || !existingKeys.has(mappedFactKey)) continue;
    retractions.push({ factKey: mappedFactKey, entityId, fact });
  }
  return { facts, retractions };
}

async function readConversationalSliceState(db: Kysely<DB>, file: FileContext): Promise<ConversationalSliceState> {
  const conversational = isConversationalFile(file);
  if (!conversational) return { conversational: false, open: false };
  const slice = await db
    .selectFrom("conversation_slices")
    .select("status")
    .where("indexed_file_id", "=", file.id)
    .executeTakeFirst();
  return { conversational, open: slice?.status === "open" };
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
): Promise<EntityFactExtractionResult> {
  if (matchedEntities.length === 0) return { facts: new Map(), retractions: [] };

  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);
  const conversational = isConversationalFile(file);
  const existingFacts = conversational
    ? await deps.db
        .selectFrom("indexed_file_facts")
        .select(["fact_key as factKey", "fact_type as factType", "relation", "subject_name as subjectName", "raw"])
        .where("indexed_file_id", "=", file.id)
        .where("source", "=", "llm_extraction")
        .where("fact_type", "in", ["llm_extracted", "llm_relation"])
        .where("deleted_at", "is", null)
        .execute()
    : [];
  let candidateFactCount = 0;
  let selectedFactCount = 0;
  let knownFactChars = 0;
  const entityDescriptions = (
    await Promise.all(
      matchedEntities.map(async (e) => {
        candidateFactCount += e.learnedFacts.length;
        const selectedFacts = conversational ? e.learnedFacts : await selectRelevantFacts(deps, e, context, cache);
        const facts = conversational
          ? renderDifferentialLearnedFacts(selectedFacts)
          : renderFactsForPrompt(selectedFacts);
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

  const existingIndexedFactsSection = conversational
    ? `
Existing indexed facts from earlier passes. Treat these as prior knowledge. Emit only genuinely new facts. If the current messages contradict or reverse one, include its exact fact_key in retractions.
${existingFacts.map((fact) => `- fact_key: ${fact.factKey}; fact: ${indexedFactText(fact)}`).join("\n")}
`
    : "";
  const differentialOutputSection = conversational
    ? 'Return JSON: { "facts": { "entity-id": [{ "fact": "short fact" }] }, "retractions": [{ "fact_key": "...", "entity_id": "...", "fact": "prior learned fact text" }] }'
    : 'Return JSON: { "entity-id": [{ "fact": "short fact" }] }';
  const prompt = `Extract NEW facts about these entities from the document below. Max 3 facts per entity, each under 20 words.${
    conversational ? " Existing facts are already stored; do not repeat them." : ""
  }

Entities:
${entityDescriptions}
${existingIndexedFactsSection}

Document: ${file.fileName} (${file.sourceCreatedAt || file.sourceUpdatedAt || "unknown"})
${file.threadContext ? `\nEmail thread context for resolving references only:\n${file.threadContext}\n` : ""}

${differentialOutputSection}
Return {} if no new facts.
Only return facts supported by the document content. Thread context may disambiguate references but is not evidence by itself.

<content>
${truncatedContent}
</content>`;

  return parseEntityFactResponse(
    await deps.generator.generateJSON<unknown>(prompt, {
      maxTokens: 8192,
      label: `extractEntityFacts:${file.id}`,
      dumpDir,
    }),
    existingFacts,
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
  const fileVersion = contentVersionOf(file);
  const validExtractionTypes = extractionValidTypes(file.fileType);
  const conversationalState = await readConversationalSliceState(db, file);

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
      validExtractionTypes,
    );
  } catch (err) {
    deps.stageReport?.({
      stage: "extractEntities",
      label: "Extract entities",
      kind: "model",
      status: "failed",
      context: extractionContextBlocks(file, deps.knownEntities, deps.participantBlock),
      error: errorMessage(err),
    });
    logger.error({ ...fileMeta, stage: "extractEntities", err }, "smartEnrichFile: stage failed");
    throw err;
  }
  deps.stageReport?.({
    stage: "extractEntities",
    label: "Extract entities",
    kind: "model",
    status: "done",
    context: extractionContextBlocks(file, deps.knownEntities, deps.participantBlock),
    summary: { mentionCount: extraction.mentions.length, relationCount: extraction.relations.length },
  });
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

  if (deps.embeddingProvider) {
    await reconcileMissingNameEmbeddings(db, deps.embeddingProvider);
  }
  const retrievedKnown = deps.embeddingProvider
    ? await retrieveNameDedupCandidates(db, deps.embeddingProvider, projectProductMentionNames(extraction.mentions))
    : [];
  const widenedKnown = mergeKnownEntities(deps.knownEntities ?? [], retrievedKnown);
  const rejectedKnownMatchPairs = await listRejectedKnownMatchPairs(db, widenedKnown);
  const canonicalRewriteMap = await adjudicateKnownMatches(generator, extraction.mentions, widenedKnown, {
    fileId: file.id,
    debugDumpDir: deps.debugDumpDir,
    logger,
    rejectedKnownMatchPairs,
  });
  deps.stageReport?.({
    stage: "dedupAdjudicate",
    label: "Adjudicate known matches",
    kind: "model",
    status: "done",
    context: [
      {
        key: "knownCandidates",
        label: "Known candidates",
        selection:
          "Known project and product candidates from the file-scoped list plus retrieved name-dedup candidates; display capped at 20.",
        total: widenedKnown.length,
        items: widenedKnown.slice(0, 20).map(renderKnown),
        truncated: widenedKnown.length > 20,
        via: "prompt",
      },
    ],
    summary: { rewriteCount: canonicalRewriteMap.size },
  });
  resolveKnownMatches(extraction.mentions, widenedKnown);
  applyCanonicalRewriteMap(extraction, canonicalRewriteMap);

  await deps.ensureFresh?.();
  const writtenLlmFactKeys = await reconcileLlmExtractionFacts(
    deps,
    file,
    extraction,
    validExtractionTypes,
    conversationalState,
  );
  try {
    await deps.ensureFresh?.();
  } catch (err) {
    if (isStaleEnrichmentError(err)) {
      await tombstoneWrittenLlmFacts(deps, writtenLlmFactKeys);
    }
    throw err;
  }

  const matchableMentions = extraction.mentions.filter((mention) => !isFeatureMention(mention));
  const { matched, unmatched } = await matchEntities(db, matchableMentions);
  deps.stageReport?.({
    stage: "matchEntities",
    label: "Match entities",
    kind: "code",
    status: "done",
    outcomes: [
      ...matched.map(({ mention, entity }) =>
        outcomeForMention(mention, "linked", `matched existing ${entity.sourceType} entity ${entity.name}`),
      ),
      ...unmatched.map((mention) => outcomeForMention(mention, "deferred", "no existing entity matched")),
    ],
    summary: { matchedCount: matched.length, unmatchedCount: unmatched.length },
  });
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
  const factsMap = factsResult.status === "fulfilled" ? factsResult.value.facts : new Map<string, LearnedFact[]>();

  if (summaryResult.status === "rejected") {
    deps.stageReport?.({
      stage: "generateSummary",
      label: "Summary",
      kind: "model",
      status: "failed",
      parallelGroup: "summaryAndFacts",
      error: errorMessage(summaryResult.reason),
    });
    logger.error({ ...fileMeta, stage: "generateSummary", err: summaryResult.reason }, "smartEnrichFile: stage failed");
  } else {
    deps.stageReport?.({
      stage: "generateSummary",
      label: "Summary",
      kind: "model",
      status: "done",
      parallelGroup: "summaryAndFacts",
      summary: { summaryLength: summaryResult.value.length },
    });
  }
  if (factsResult.status === "rejected") {
    deps.stageReport?.({
      stage: "extractEntityFacts",
      label: "Entity facts",
      kind: "model",
      status: "failed",
      parallelGroup: "summaryAndFacts",
      error: errorMessage(factsResult.reason),
    });
    logger.warn(
      { ...fileMeta, stage: "extractEntityFacts", matchedEntityCount: allMatched.length, err: factsResult.reason },
      "smartEnrichFile: stage failed (continuing without entity facts)",
    );
    if (conversationalState.conversational) {
      await markConversationalFactsPending(db, file, fileVersion);
      throw factsResult.reason;
    }
  } else {
    deps.stageReport?.({
      stage: "extractEntityFacts",
      label: "Entity facts",
      kind: "model",
      status: "done",
      parallelGroup: "summaryAndFacts",
      summary: {
        entityCount: factsMap.size,
        factCount: [...factsMap.values()].reduce((sum, facts) => sum + facts.length, 0),
      },
    });
  }

  if (!summary) {
    throw summaryResult.status === "rejected" ? summaryResult.reason : new Error("smartEnrichFile: empty summary");
  }
  if (deps.stageReport && factsResult.status === "rejected") {
    throw factsResult.reason;
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

  try {
    await deps.ensureFresh?.();
    const summaryUpdate = applyContentVersionWhere(
      db.updateTable("indexed_files").set({ summary, summary_status: "done" }).where("id", "=", file.id),
      fileVersion,
    );
    const summaryUpdateResult = await summaryUpdate.executeTakeFirst();
    assertFreshUpdate(summaryUpdateResult, file.id);

    if (embeddingProvider && summary) {
      try {
        const [embedding] = await embeddingProvider.embedTexts([summary]);
        if (embedding) {
          await deps.ensureFresh?.();
          await withFreshFileWriteLock(db, file.id, fileVersion, async (trx) => {
            const isPostgres = isPg(trx);
            if (isPostgres) {
              await sql`INSERT INTO file_embeddings (indexed_file_id, embedding)
                VALUES (${file.id}, ${JSON.stringify(embedding)}::vector)
                ON CONFLICT (indexed_file_id) DO UPDATE SET embedding = EXCLUDED.embedding`.execute(trx);
            } else {
              await sql`INSERT OR REPLACE INTO file_embeddings (indexed_file_id, embedding)
                VALUES (${file.id}, ${JSON.stringify(embedding)})`.execute(trx);
            }
          });
        }
      } catch (err) {
        if (isStaleEnrichmentError(err)) throw err;
        logger.warn({ err, fileId: file.id }, "Failed to embed summary");
      }
    }

    if (conversationalState.conversational && factsResult.status === "fulfilled") {
      const retractions = factsResult.value.retractions;
      const factKeys = retractions.flatMap((retraction) => (retraction.factKey ? [retraction.factKey] : []));
      if (factKeys.length > 0) {
        await createIndexedFileFactRepository(db).tombstoneByFactKeys(factKeys);
      }
      await removeRetractedLearnedFacts(db, file.id, retractions);
    }

    // Update entity definitions with new facts
    for (const [entityId, facts] of factsMap) {
      if (facts.length === 0) continue;

      const entity = await entityRepo.getEntity(entityId);
      if (!entity) continue;

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

      await deps.ensureFresh?.();
      const appendedCount = await withFreshFileWriteLock(db, file.id, fileVersion, async (trx) => {
        const txEntityRepo = createEntityRepository(trx);
        const currentEntity = await txEntityRepo.getEntity(entityId);
        if (!currentEntity) return 0;
        const currentMetadata = parseEntityMetadata(currentEntity.metadata);
        const existingFacts = currentMetadata.learned_facts ?? [];
        const existingKeys = new Set(existingFacts.map(learnedFactKey).filter((key): key is string => key !== null));
        const factsToAppend = newFacts.filter((fact) => {
          const key = learnedFactKey(fact);
          if (!key || existingKeys.has(key)) return false;
          existingKeys.add(key);
          return true;
        });
        if (factsToAppend.length === 0) return 0;
        currentMetadata.learned_facts = [...existingFacts, ...factsToAppend];
        await txEntityRepo.updateEntity(entityId, { metadata: JSON.stringify(currentMetadata) });
        return factsToAppend.length;
      });

      if (appendedCount > 0) logger.debug({ entityId, newFactCount: appendedCount }, "Updated entity definition");
      await yieldToEventLoop();
    }

    if (conversationalState.conversational && factsResult.status === "fulfilled") {
      await deps.ensureFresh?.();
      await db
        .updateTable("conversation_slices")
        .set({ facts_enriched_content_hash: file.contentHash })
        .where("indexed_file_id", "=", file.id)
        .execute();
    }
  } catch (err) {
    if (isStaleEnrichmentError(err)) {
      await tombstoneWrittenLlmFacts(deps, writtenLlmFactKeys);
    }
    throw err;
  }
}

async function reconcileLlmExtractionFacts(
  deps: SmartEnrichmentDeps,
  file: FileContext,
  extraction: EntityExtractionResult,
  allowedTypes: Set<string>,
  conversationalState: ConversationalSliceState,
): Promise<string[]> {
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
  const emittedFeatureKeys: string[] = [];
  const writtenFactKeys: string[] = [];
  let materializeDeps: MaterializeDeps | null = null;
  const outcomes: StageOutcome[] = [];

  try {
    for (const rawMention of extraction.mentions) {
      const mention = {
        ...rawMention,
        type: coerceMentionType(rawMention.mention, rawMention.type),
      };
      if (!allowedTypes.has(mention.type)) {
        outcomes.push(outcomeForMention(mention, "dropped", "type not allowed for this file type"));
        deps.logger.info(
          { fileId: file.id, displayName: mention.mention, entityType: mention.type },
          "Dropped LLM mention with unsupported type",
        );
        continue;
      }
      if (mention.type === "company" && isEmailProviderName(mention.mention)) {
        outcomes.push(outcomeForMention(mention, "dropped", "email-provider company name"));
        deps.logger.info({ fileId: file.id, displayName: mention.mention }, "Dropped email-provider company mention");
        continue;
      }
      if (
        mention.type === "project" &&
        normalizeDocumentTitle(mention.mention) === normalizeDocumentTitle(file.fileName)
      ) {
        outcomes.push(outcomeForMention(mention, "dropped", "project name matching the document title"));
        deps.logger.info(
          { fileId: file.id, displayName: mention.mention },
          "Dropped project mention matching document title",
        );
        continue;
      }
      if (mention.mention.length < MIN_ENTITY_NAME_LENGTH) {
        outcomes.push(outcomeForMention(mention, "dropped", `shorter than ${MIN_ENTITY_NAME_LENGTH} characters`));
        continue;
      }
      if ((mention.type === "project" || mention.type === "product") && isGenericEngagementName(mention.mention)) {
        outcomes.push(outcomeForMention(mention, "dropped", "generic engagement name"));
        deps.logger.info(
          { fileId: file.id, displayName: mention.mention, reason: "generic_engagement_name" },
          "Dropped generic engagement-name mention",
        );
        continue;
      }
      const validation = validateLlmMention({
        displayName: mention.mention,
        entityType: mention.type,
        aliases: mention.variations,
        fileContent: file.content,
        resolutionContext: file.threadContext,
        source: "llm_extraction",
      });
      if (!validation.ok) {
        outcomes.push(outcomeForMention(mention, "dropped", validation.reason));
        deps.logger.info(
          { fileId: file.id, displayName: mention.mention, reason: validation.reason },
          "Dropped invalid LLM mention",
        );
        continue;
      }
      if (mention.type === "feature") {
        if (isCodeShapedFeatureName(mention.mention)) {
          deps.logger.info(
            { fileId: file.id, displayName: mention.mention, reason: "feature_name_code_shaped" },
            "Dropped code-shaped LLM feature mention",
          );
          continue;
        }
        const parentProductName = mention.parentProduct?.trim() ?? "";
        if (!parentProductName) {
          deps.logger.info(
            { fileId: file.id, displayName: mention.mention },
            "Dropped LLM feature mention without a parent product name",
          );
          continue;
        }
        if (isDomainOrUrlOrEmailName(parentProductName)) {
          deps.logger.info(
            { fileId: file.id, displayName: mention.mention, reason: "feature_parent_is_domain" },
            "Dropped LLM feature mention with domain parent",
          );
          continue;
        }
        const featureId = buildLlmFeatureId(file.id, mention.mention, parentProductName);
        const corroborationKey = buildLlmFeatureCorroborationKey(mention.mention, parentProductName);
        await deps.ensureFresh?.();
        const result = await upsertFeatureFact(db, {
          indexedFileId: file.id,
          connectorConfigId: file.connectorConfigId,
          createdByUserId: owner?.created_by ?? null,
          contentHash,
          source: "llm_extraction",
          featureId,
          featureName: mention.mention,
          parentProductName,
          status: "proposed",
          evidence: { fileIds: [file.id], entityIds: [] },
          corroborationKey,
          promptVersion: LLM_EXTRACTION_PROMPT_VERSION,
          model: "gemini",
          confidence: typeof mention.confidence === "number" ? mention.confidence : 0.7,
        });
        if (result.emitted && result.factKey) {
          emittedFeatureKeys.push(result.factKey);
          writtenFactKeys.push(result.factKey);
        }
        await yieldToEventLoop();
        continue;
      }
      const input: UpsertIndexedFileFactInput = {
        indexedFileId: file.id,
        fileType: file.fileType,
        connectorConfigId: file.connectorConfigId,
        createdByUserId: owner?.created_by ?? null,
        contentHash,
        source: "llm_extraction",
        factType: "llm_extracted",
        relation: "mentioned",
        subjectName: mention.mention,
        subjectSource: "llm_extraction",
        subjectSourceId: isConversationalFile(file)
          ? `${file.id}:${LLM_EXTRACTION_PROMPT_VERSION}:${mention.mention}`
          : `${file.id}:${contentHash}:${LLM_EXTRACTION_PROMPT_VERSION}:${mention.mention}`,
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
      const factKey = buildIndexedFileFactKey(input);
      emittedMentionKeys.push(factKey);
      await deps.ensureFresh?.();
      await factRepo.upsertFact(input);
      outcomes.push(outcomeForMention(mention, "kept", "llm_extracted fact written"));
      writtenFactKeys.push(factKey);
      await yieldToEventLoop();
    }

    for (const relation of extraction.relations) {
      const input = buildRelationFactInput({
        file,
        ownerUserId: owner?.created_by ?? null,
        contentHash,
        relation,
        mentions: extraction.mentions,
        allowedTypes,
      });
      if (!input) continue;
      const factKey = buildIndexedFileFactKey(input);
      emittedRelationKeys.push(factKey);
      await deps.ensureFresh?.();
      await factRepo.upsertFact(input);
      writtenFactKeys.push(factKey);
      await yieldToEventLoop();
    }

    await deps.ensureFresh?.();
    if (!conversationalState.open) {
      const featureCorroborationKeys = await collectStaleFeatureCorroborationKeys(
        db,
        file.id,
        new Set(emittedFeatureKeys),
      );
      const mentionReconcile = await factRepo.reconcileStaleFacts(
        { kind: "file", indexedFileId: file.id, source: "llm_extraction", factType: "llm_extracted" },
        new Set(emittedMentionKeys),
      );
      const relationReconcile = await factRepo.reconcileStaleFacts(
        { kind: "file", indexedFileId: file.id, source: "llm_extraction", factType: "llm_relation" },
        new Set(emittedRelationKeys),
      );
      await factRepo.reconcileStaleFacts(
        { kind: "file", indexedFileId: file.id, source: "llm_extraction", factType: "feature" },
        new Set(emittedFeatureKeys),
      );
      await cleanupRelationshipEvidenceForFacts(db, [
        ...mentionReconcile.tombstonedFactIds,
        ...relationReconcile.tombstonedFactIds,
      ]);
      await cleanupEmptyRelationships(db);
      if (featureCorroborationKeys.length > 0) {
        materializeDeps ??= await buildMaterializeDeps(db);
        for (const corroborationKey of featureCorroborationKeys) {
          await reconcileFeatureSubEntity(materializeDeps, corroborationKey);
        }
      }
    }

    await deps.ensureFresh?.();
    await db
      .deleteFrom("entity_mentions")
      .where("indexed_file_id", "=", file.id)
      .where("source", "=", "llm_extraction")
      .where("confidence", "!=", "EXTRACTED")
      .execute();

    await deps.ensureFresh?.();
    await materializeUnmaterializedFacts(db, deps.logger, {
      embeddingProvider: deps.embeddingProvider,
      factTypes: ["llm_extracted", "llm_relation", "feature"],
    });
    deps.stageReport?.({
      stage: "reconcileFacts",
      label: "Reconcile facts",
      kind: "code",
      status: "done",
      outcomes,
      summary: {
        mentionCount: extraction.mentions.length,
        kept: outcomes.filter((outcome) => outcome.result === "kept").length,
        dropped: outcomes.filter((outcome) => outcome.result === "dropped").length,
      },
    });
    return writtenFactKeys;
  } catch (err) {
    deps.stageReport?.({
      stage: "reconcileFacts",
      label: "Reconcile facts",
      kind: "code",
      status: "failed",
      outcomes,
      error: errorMessage(err),
    });
    if (isStaleEnrichmentError(err)) {
      await tombstoneWrittenLlmFacts(deps, writtenFactKeys);
    }
    throw err;
  }
}

function isFeatureMention(mention: ExtractedMention): boolean {
  return mention.type.trim().toLowerCase() === "feature";
}

function buildLlmFeatureId(indexedFileId: string, featureName: string, parentProductName: string): string {
  return `llm-feature:${indexedFileId}:${createHash("sha256")
    .update([normalizeName(featureName), normalizeName(parentProductName)].join("\x1f"))
    .digest("hex")}`;
}

function buildLlmFeatureCorroborationKey(featureName: string, parentProductName: string): string {
  return createHash("sha256")
    .update([normalizeName(featureName), normalizeName(parentProductName)].join("\x1f"))
    .digest("hex");
}

async function collectStaleFeatureCorroborationKeys(
  db: Kysely<DB>,
  indexedFileId: string,
  seenFactKeys: Set<string>,
): Promise<string[]> {
  let query = db
    .selectFrom("indexed_file_facts")
    .select("raw")
    .where("indexed_file_id", "=", indexedFileId)
    .where("source", "=", "llm_extraction")
    .where("fact_type", "=", "feature")
    .where("deleted_at", "is", null);
  if (seenFactKeys.size > 0) {
    query = query.where("fact_key", "not in", [...seenFactKeys]);
  }
  const rows = await query.execute();
  const keys = rows.map((row) => readFeatureCorroborationKey(row.raw)).filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

function readFeatureCorroborationKey(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { corroborationKey?: unknown };
    return typeof parsed.corroborationKey === "string" && parsed.corroborationKey.length > 0
      ? parsed.corroborationKey
      : null;
  } catch {
    return null;
  }
}

async function markConversationalFactsPending(
  db: Kysely<DB>,
  file: FileContext,
  fileVersion: FileContentVersion,
): Promise<void> {
  const result = await applyContentVersionWhere(
    db
      .updateTable("indexed_files")
      .set({ embedding_status: "pending", embedding_next_retry_at: null })
      .where("id", "=", file.id),
    fileVersion,
  ).executeTakeFirst();
  assertFreshUpdate(result, file.id);
}

async function removeRetractedLearnedFacts(
  db: Kysely<DB>,
  indexedFileId: string,
  retractions: LearnedFactRetraction[],
): Promise<void> {
  const removalKeys = new Set(
    retractions
      .filter(
        (retraction): retraction is LearnedFactRetraction & { fact: string } => typeof retraction.fact === "string",
      )
      .map((retraction) => learnedFactKey({ fact: retraction.fact, source_file_id: indexedFileId }))
      .filter((key): key is string => key !== null),
  );
  if (removalKeys.size === 0) return;
  const entityIds = [
    ...new Set(retractions.flatMap((retraction) => (retraction.entityId ? [retraction.entityId] : []))),
  ];
  let query = db.selectFrom("entities").select(["id", "metadata"]);
  if (entityIds.length > 0) query = query.where("id", "in", entityIds);
  const entities = await query.execute();
  for (const entity of entities) {
    const metadata = parseEntityMetadata(entity.metadata);
    const learnedFacts = metadata.learned_facts ?? [];
    const retained = learnedFacts.filter((fact) => {
      const key = learnedFactKey(fact);
      return key === null || !removalKeys.has(key);
    });
    if (retained.length === learnedFacts.length) continue;
    metadata.learned_facts = retained;
    await db
      .updateTable("entities")
      .set({ metadata: JSON.stringify(metadata), updated_at: new Date().toISOString() })
      .where("id", "=", entity.id)
      .execute();
  }
}

async function tombstoneWrittenLlmFacts(deps: SmartEnrichmentDeps, factKeys: string[]): Promise<void> {
  const keys = [...new Set(factKeys)];
  if (keys.length === 0) return;
  const now = new Date().toISOString();
  const facts = await deps.db
    .selectFrom("indexed_file_facts")
    .select(["id", "indexed_file_id", "fact_type", "raw"])
    .where("fact_key", "in", keys)
    .where("deleted_at", "is", null)
    .execute();
  if (facts.length === 0) return;
  const featureCorroborationKeys = [
    ...new Set(
      facts
        .filter((fact) => fact.fact_type === "feature")
        .map((fact) => readFeatureCorroborationKey(fact.raw))
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  await deps.db
    .updateTable("indexed_file_facts")
    .set({ deleted_at: now, materialized_at: null, updated_at: now })
    .where(
      "id",
      "in",
      facts.map((fact) => fact.id),
    )
    .execute();
  await cleanupRelationshipEvidenceForFacts(
    deps.db,
    facts.map((fact) => fact.id),
  );
  await cleanupEmptyRelationships(deps.db);
  const fileIds = [...new Set(facts.map((fact) => fact.indexed_file_id))];
  await deps.db
    .deleteFrom("entity_mentions")
    .where("indexed_file_id", "in", fileIds)
    .where("source", "=", "llm_extraction")
    .where("confidence", "!=", "EXTRACTED")
    .execute();
  if (featureCorroborationKeys.length > 0) {
    const materializeDeps = await buildMaterializeDeps(deps.db);
    for (const corroborationKey of featureCorroborationKeys) {
      await reconcileFeatureSubEntity(materializeDeps, corroborationKey);
    }
  }
}

export async function purgeConversationalFactsForFile(db: Kysely<DB>, indexedFileId: string): Promise<void> {
  const factRows = await db
    .selectFrom("indexed_file_facts")
    .select("fact_key")
    .where("indexed_file_id", "=", indexedFileId)
    .where("source", "=", "llm_extraction")
    .where("fact_type", "in", ["llm_extracted", "llm_relation", "feature"])
    .where("deleted_at", "is", null)
    .execute();
  await createIndexedFileFactRepository(db).tombstoneByFactKeys(factRows.map((row) => row.fact_key));

  const entities = await db.selectFrom("entities").select(["id", "metadata"]).execute();
  for (const entity of entities) {
    const metadata = parseEntityMetadata(entity.metadata);
    const learnedFacts = metadata.learned_facts ?? [];
    const retained = learnedFacts.filter((fact) => fact.source_file_id !== indexedFileId);
    if (retained.length === learnedFacts.length) continue;
    metadata.learned_facts = retained;
    await db
      .updateTable("entities")
      .set({ metadata: JSON.stringify(metadata), updated_at: new Date().toISOString() })
      .where("id", "=", entity.id)
      .execute();
  }

  await db
    .deleteFrom("entity_mentions")
    .where("indexed_file_id", "=", indexedFileId)
    .where("source", "in", ["llm_extraction", "llm_relation"])
    .execute();
  await db
    .deleteFrom("entity_source_refs")
    .where("source", "in", ["llm_extraction", "llm_relation"])
    .where("source_id", "like", `${indexedFileId}:%`)
    .execute();
  await db
    .updateTable("conversation_slices")
    .set({ facts_enriched_content_hash: null })
    .where("indexed_file_id", "=", indexedFileId)
    .execute();
}

/**
 * Normalize a document title for comparison against an extracted project name:
 * strip leading reply/forward prefixes (`Re:`, `Fwd:`, `Fw:`, possibly repeated)
 * then lowercase/collapse whitespace via {@link normalizeName}. Used to drop a
 * `project` mention that is merely the email subject / file title restated.
 */
function normalizeDocumentTitle(title: string | null | undefined): string {
  let current = title ?? "";
  let previous: string;
  do {
    previous = current;
    current = current.replace(/^\s*(re|fwd|fw)\s*:\s*/i, "");
  } while (current !== previous);
  return normalizeName(current);
}

function buildRelationFactInput(input: {
  file: FileContext;
  ownerUserId: string | null;
  contentHash: string;
  relation: ExtractedRelation;
  mentions: ExtractedMention[];
  allowedTypes: Set<string>;
}): UpsertIndexedFileFactInput | null {
  const relationType = normalizeRelationType(input.relation.type);
  if (!relationType || !isHighConfidenceRelation(input.relation.confidence)) return null;
  const sourceName = input.relation.source.name?.trim();
  const targetName = input.relation.target.name?.trim();
  if (!sourceName || !targetName) return null;
  const sourceType = normalizeMentionType(coerceMentionType(sourceName, input.relation.source.type));
  const targetType = normalizeMentionType(coerceMentionType(targetName, input.relation.target.type));
  if (!sourceType || !targetType) return null;
  if (!normalizeRelationEndpointType(sourceType) || !normalizeRelationEndpointType(targetType)) return null;
  if (!input.allowedTypes.has(sourceType) || !input.allowedTypes.has(targetType)) {
    return null;
  }
  if (
    (sourceType === "company" && isEmailProviderName(sourceName)) ||
    (targetType === "company" && isEmailProviderName(targetName))
  ) {
    return null;
  }
  if (isDomainOrUrlOrEmailName(sourceName) || isDomainOrUrlOrEmailName(targetName)) {
    return null;
  }
  if (
    ((sourceType === "project" || sourceType === "product") && isGenericEngagementName(sourceName)) ||
    ((targetType === "project" || targetType === "product") && isGenericEngagementName(targetName))
  ) {
    return null;
  }
  const sourceConfidence = findMentionConfidence(input.mentions, input.relation.source);
  const targetConfidence = findMentionConfidence(input.mentions, input.relation.target);
  if (!isHighConfidenceEndpoint(sourceConfidence) || !isHighConfidenceEndpoint(targetConfidence)) return null;

  return {
    indexedFileId: input.file.id,
    fileType: input.file.fileType,
    connectorConfigId: input.file.connectorConfigId,
    createdByUserId: input.ownerUserId,
    contentHash: input.contentHash,
    source: "llm_extraction",
    factType: "llm_relation",
    relation: relationType,
    subjectName: sourceName,
    subjectSource: "llm_extraction",
    subjectSourceId: isConversationalFile(input.file)
      ? `${input.file.id}:${LLM_EXTRACTION_PROMPT_VERSION}:${relationType}:${sourceName}:${targetName}`
      : `${input.file.id}:${input.contentHash}:${LLM_EXTRACTION_PROMPT_VERSION}:${relationType}:${sourceName}:${targetName}`,
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

function normalizeLearnedFactContent(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function learnedFactKey(entry: { fact?: unknown; source_file_id?: unknown }): string | null {
  if (typeof entry.fact !== "string" || typeof entry.source_file_id !== "string" || entry.source_file_id.length === 0) {
    return null;
  }
  const normalizedFact = normalizeLearnedFactContent(entry.fact);
  const factHash = createHash("sha256").update(normalizedFact).digest("hex");
  return `${entry.source_file_id}:${factHash}`;
}

function parseEntityMetadata(raw: string | null): EntityMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EntityMetadata;
  } catch {
    return {};
  }
}
