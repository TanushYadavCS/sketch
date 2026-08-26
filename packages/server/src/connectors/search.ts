/**
 * Hybrid search interface for the agent.
 *
 * Combines three search layers:
 * 1. Metadata filtering (time, source, content type, tags)
 * 2. FTS5 keyword search (BM25 ranking) — SQLite only
 * 3. Vector similarity search (sqlite-vec / pgvector embeddings)
 *
 * Results are merged using reciprocal rank fusion (RRF).
 *
 * Uses raw SQL for the FTS5/tsvector and vec/pgvector queries because:
 * - Kysely's typed query builder doesn't support virtual table joins (FTS5, sqlite-vec) natively.
 * - Postgres-specific operators (@@ plainto_tsquery, <=> halfvec cosine distance) have no
 *   Kysely equivalents. The two dialects use entirely different WHERE clauses, JOIN patterns,
 *   and ranking functions (bm25 vs ts_rank, sqlite-vec MATCH vs pgvector KNN), so a shared
 *   query builder abstraction would add complexity without benefit.
 */
import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";
import type { Logger } from "pino";
import { isPg } from "../db/dialect";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import { createEntityRepository } from "../db/repositories/entities";
import { fileVisibilityRuleSql } from "../db/repositories/file-visibility-rule";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { parseEmailAddrJson, parseEmailAddrListJson } from "./email/envelope-metadata";
import type { EmailAddr } from "./email/normalized-email";
import { createEnrichmentQueryEmbedder, resolveOpenRouterEnrichmentConfig } from "./enrichment-providers";
import type { SearchCandidate, StageKey, StageReporter, VectorChunkHit } from "./enrichment-stage-report";
import { type AccessPrincipalInput, CONNECTOR_TYPES, type ConnectorType, normalizeAccessPrincipals } from "./types";
import {
  type ScoredVector,
  VECTOR_HIT_DISPLAY_CAP,
  rankVectorHits,
  selectVectorHitsForDisplay,
} from "./vector-trace-hits";

export interface SearchResult {
  id: string;
  fileName: string;
  source: string;
  contentCategory: string;
  summary: string | null;
  /** External provider ID (e.g. ClickUp task id, Fireflies transcript id). Some sources prefix subtypes (e.g. `doc:`, `db-`, `project-`). */
  providerFileId: string;
  providerUrl: string | null;
  sourcePath: string | null;
  sourceUpdatedAt: string | null;
  /** FTS5 relevance rank (lower = more relevant). */
  relevance: number;
}

export type SearchableSource = ConnectorType | "conversation" | "local";

function buildSearchableSources(connectorTypes: readonly ConnectorType[]): [SearchableSource, ...SearchableSource[]] {
  return ["conversation", "local", ...connectorTypes];
}

export const SEARCHABLE_SOURCES = buildSearchableSources(CONNECTOR_TYPES);

export interface SearchOptions {
  /** Filter by source provider. */
  source?: string;
  /** Max results (default 10). */
  limit?: number;
  /** Content category filter: "document" or "structured". */
  category?: string;
  /**
   * RBAC (user-level): restrict results to files the user can access.
   * Typed principals to match against current scope membership and explicit shares.
   * Non-chat files with no scope AND no file_access rows are unrestricted.
   * When omitted, no user-level filtering is applied.
   */
  userPrincipals?: AccessPrincipalInput[];
  slackEntitySyncEnabled?: boolean;
}

export function fileAccessFilterSql(principalInput: AccessPrincipalInput[], slackEntitySyncEnabled = true) {
  return fileVisibilityRuleSql({
    principals: normalizeAccessPrincipals(principalInput),
    slackEntitySyncEnabled,
    archived: "include",
  });
}

/**
 * Search the FTS5 index.
 *
 * Supports FTS5 query syntax:
 * - Simple terms: "planning doc"
 * - Prefix: "plan*"
 * - Phrase: '"Q1 planning"'
 * - Column filter: "file_name:report"
 */
export async function searchFiles(db: Kysely<DB>, query: string, opts?: SearchOptions): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 10;
  if (opts?.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];

  const principalList = opts?.userPrincipals ?? [];
  const userFilter =
    principalList.length > 0
      ? sql`AND ${fileAccessFilterSql(principalList, opts?.slackEntitySyncEnabled ?? true)}`
      : sql``;

  // Hide bodyless CRM activities ("empty reminders") from search — they're rolled
  // up under their parent object, never surfaced as standalone results.
  const excludeEmptyActivities = sql`AND NOT (
    indexed_files.content_category = 'structured'
    AND indexed_files.file_type IN ('crm_task', 'crm_call', 'crm_event', 'crm_meeting', 'crm_note')
  )`;

  if (isPg(db)) {
    const tsQuery = sanitizeTsQuery(query);
    if (!tsQuery) return [];

    const pgQuery = sql<SearchResult>`
      SELECT
        indexed_files.id,
        indexed_files.file_name as "fileName",
        indexed_files.source,
        indexed_files.content_category as "contentCategory",
        indexed_files.summary,
        indexed_files.provider_file_id as "providerFileId",
        indexed_files.provider_url as "providerUrl",
        indexed_files.source_path as "sourcePath",
        indexed_files.source_updated_at as "sourceUpdatedAt",
        ts_rank(indexed_files.search_vector, plainto_tsquery('english', ${query})) as relevance
      FROM indexed_files
      WHERE indexed_files.search_vector @@ plainto_tsquery('english', ${query})
      AND indexed_files.is_archived = 0
      ${excludeEmptyActivities}
      ${userFilter}
      ${opts?.source ? sql`AND indexed_files.source = ${opts.source}` : sql``}
      ${opts?.category ? sql`AND indexed_files.content_category = ${opts.category}` : sql``}
      ORDER BY relevance DESC
      LIMIT ${limit}
    `;
    return (await pgQuery.execute(db)).rows;
  }

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const baseQuery = sql<SearchResult>`
		SELECT
			indexed_files.id,
			indexed_files.file_name as "fileName",
			indexed_files.source,
			indexed_files.content_category as "contentCategory",
			indexed_files.summary,
			indexed_files.provider_file_id as "providerFileId",
			indexed_files.provider_url as "providerUrl",
			indexed_files.source_path as "sourcePath",
			indexed_files.source_updated_at as "sourceUpdatedAt",
			bm25(indexed_files_fts, 10.0, 4.0, 2.0) as relevance
		FROM indexed_files
		INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
		WHERE indexed_files_fts MATCH ${ftsQuery}
		AND indexed_files.is_archived = 0
		${excludeEmptyActivities}
		${userFilter}
		${opts?.source ? sql`AND indexed_files.source = ${opts.source}` : sql``}
		${opts?.category ? sql`AND indexed_files.content_category = ${opts.category}` : sql``}
		ORDER BY relevance
		LIMIT ${limit}
	`;

  const results = await baseQuery.execute(db);
  return results.rows;
}

/**
 * Get the full content of an indexed file.
 * Used by the agent when it wants to load a document into conversation context,
 * and by the frontend file detail sheet.
 *
 * Access control:
 *   - `userPrincipals === undefined` → trusted bypass (server/agent boot paths,
 *     admin bypass when the org setting is on). Returns the file unfiltered.
 *   - `userPrincipals === []`        → caller has no resolvable principal → fail closed.
 *     Returns null regardless of the file's access shape. Prevents an unauth'd
 *     user from inheriting visibility through the empty-array path.
 *   - `userPrincipals.length > 0`    → 3-tier check (unrestricted / scope / per-file).
 */
export async function getFileContent(
  db: Kysely<DB>,
  fileId: string,
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<{
  id: string;
  connectorConfigId: string;
  fileName: string;
  fileType: string | null;
  source: string;
  sourcePath: string | null;
  content: string | null;
  summary: string | null;
  contextNote: string | null;
  providerUrl: string | null;
  enrichmentStatus: string;
} | null> {
  let query = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "connector_config_id",
      "file_name",
      "file_type",
      "source",
      "source_path",
      "content",
      "summary",
      "context_note",
      "provider_url",
      "enrichment_status",
    ])
    .where("id", "=", fileId);

  if (userPrincipals !== undefined) {
    const principals = normalizeAccessPrincipals(userPrincipals);
    if (principals.length === 0) return null;
    query = query.where(fileVisibilityRuleSql({ principals, slackEntitySyncEnabled, archived: "exclude" }));
  }

  const file = await query.executeTakeFirst();
  if (!file) return null;

  return {
    id: file.id,
    connectorConfigId: file.connector_config_id,
    fileName: file.file_name,
    fileType: file.file_type,
    source: file.source,
    sourcePath: file.source_path,
    content: file.content,
    summary: file.summary,
    contextNote: file.context_note,
    providerUrl: file.provider_url,
    enrichmentStatus: file.enrichment_status,
  };
}

/**
 * Filter a list of indexed file IDs down to only those the user can access.
 *
 * Contract mirrors `getFileContent`:
 *   - `userPrincipals === undefined` → trusted bypass (server/agent boot, admin
 *     bypass): returns the input set unchanged.
 *   - `userPrincipals === []`        → caller has no resolvable principal → fail closed:
 *     returns an empty set.
 *   - `userPrincipals.length > 0`    → 3-tier check (unrestricted / scope / per-file).
 */
export async function filterAccessibleFileIds(
  db: Kysely<DB>,
  fileIds: string[],
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  if (userPrincipals === undefined) return new Set(fileIds);
  const principals = normalizeAccessPrincipals(userPrincipals);
  if (principals.length === 0) return new Set();

  const files = await db
    .selectFrom("indexed_files")
    .select("id")
    .where("id", "in", fileIds)
    .where(fileVisibilityRuleSql({ principals, slackEntitySyncEnabled, archived: "exclude" }))
    .execute();

  return new Set(files.map((file) => file.id));
}

/**
 * List all indexed sources with file counts.
 * Useful for the agent to report what data is available.
 */
export async function listIndexedSources(
  db: Kysely<DB>,
): Promise<Array<{ source: string; fileCount: number; lastSynced: string | null }>> {
  const results = await db
    .selectFrom("indexed_files")
    .select(["source", sql<number>`count(*)`.as("fileCount"), sql<string>`max(synced_at)`.as("lastSynced")])
    .where("is_archived", "=", 0)
    .groupBy("source")
    .execute();

  return results.map((r) => ({
    source: r.source,
    fileCount: Number(r.fileCount),
    lastSynced: r.lastSynced,
  }));
}

/**
 * Summary of sources with at least one indexed file, for inclusion in the
 * agent's system prompt. A source qualifies as "indexed" when it has ≥ 1 file
 * in `indexed_files` (trusting that anyone who wired a connector and has files
 * will keep them refreshed). Empty sources are excluded to avoid telling the
 * agent to Search against nothing.
 */
export async function listIndexedSourcesForPrompt(
  db: Kysely<DB>,
): Promise<Array<{ source: string; fileCount: number }>> {
  const results = await db
    .selectFrom("indexed_files")
    .select(["source", sql<number>`count(*)`.as("fileCount")])
    .where("is_archived", "=", 0)
    .groupBy("source")
    .having(sql<number>`count(*)`, ">", 0)
    .execute();

  return results
    .map((r) => ({ source: r.source, fileCount: Number(r.fileCount) }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Sanitize user input for Postgres tsquery / plainto_tsquery.
 * plainto_tsquery is quite robust, but we strip operator characters that could
 * cause issues when passed through string interpolation.
 */
function sanitizeTsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const cleaned = trimmed
    .replace(/[&|!<>():*\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "";
}

/**
 * Sanitize user input for FTS5 queries.
 * Strips characters that would cause FTS5 syntax errors.
 */
function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // Preserve explicit phrase queries
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }

  // Preserve column-scoped queries
  if (trimmed.includes(":") && /^\w+:/.test(trimmed)) {
    return trimmed;
  }

  // Strip FTS5 boolean operators and special chars, then join with OR so partial
  // matches work. FTS5 defaults to AND which fails when the query is long and any
  // word is missing.
  const words = trimmed
    // Remove FTS5 boolean keywords (case-insensitive whole-word match)
    .replace(/\b(OR|AND|NOT|NEAR)\b/gi, " ")
    // Remove special chars except word chars, spaces, and a single trailing *
    // (FTS5 allows prefix queries like "plan*" but not standalone * or **)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);

  if (words.length === 0) return "";
  if (words.length === 1) return words[0];

  // Use OR so documents matching any word are returned (ranked by BM25)
  return words.join(" OR ");
}

// ── Kind taxonomy ─────────────────────────────────────────────────────────

/**
 * One rule in a kind's filter set: an `indexed_files.source IN (...)` group
 * optionally narrowed by `indexed_files.file_type IN (...)`. Multiple rules
 * for the same kind are OR-ed together so a kind can span sources with
 * different file_type vocabularies (e.g. "doc" = Drive documents OR Notion
 * pages OR ClickUp Docs OR Linear projects).
 */
export type KindRule = { sources?: string[]; fileTypes?: string[] };

/**
 * Static map of semantic content kind → SQL-filter rules. Values are code
 * constants and never user-driven; any future dynamic source must enforce a
 * static allowlist before reaching the SQL builder. ContentCategory is too
 * coarse (only "document" | "structured") and source-only mapping silently
 * sweeps in tasks under `kind: "doc"` — so we discriminate on file_type too.
 */
export const KIND_TO_RULES: Record<string, KindRule[]> = {
  meeting: [{ sources: ["fireflies", "otter"] }, { sources: ["teams"], fileTypes: ["meeting_transcript"] }],
  doc: [
    { sources: ["google_drive"], fileTypes: ["document", "presentation"] },
    { sources: ["notion"], fileTypes: ["page"] },
    { sources: ["clickup"], fileTypes: ["doc"] },
    { sources: ["linear"], fileTypes: ["project"] },
  ],
  task: [
    { sources: ["clickup"], fileTypes: ["task", "subtask"] },
    { sources: ["linear"], fileTypes: ["issue"] },
  ],
  message: [{ sources: ["conversation", "whatsapp", "slack"] }],
};

/** Compile kind rules to a raw SQL fragment for the FTS / hybrid pipelines. */
function kindFilterSql(rules: KindRule[]) {
  if (rules.length === 0) return sql``;
  const parts = rules.map((r) => {
    const conds: ReturnType<typeof sql>[] = [];
    if (r.sources?.length) {
      conds.push(
        sql`indexed_files.source IN (${sql.join(
          r.sources.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      );
    }
    if (r.fileTypes?.length) {
      conds.push(
        sql`indexed_files.file_type IN (${sql.join(
          r.fileTypes.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      );
    }
    return sql`(${sql.join(conds, sql` AND `)})`;
  });
  return sql`AND (${sql.join(parts, sql` OR `)})`;
}

// ── Hybrid Search ─────────────────────────────────────────────────────────

export interface HybridSearchOptions extends SearchOptions {
  /** Time filter — matches file dates AND content timeframes. */
  timeFilter?: {
    after?: string;
    before?: string;
  };
  /** Filter by content types: "image", "document", "structured". */
  contentTypes?: string[];
  /** Embed the query for vector search. If null, only FTS5 is used. */
  queryEmbedding?: number[];
  /** Restrict search to these file IDs only (entity-scoped search). */
  fileIds?: string[];
  /** File IDs linked to entities matching the query — used for entity boost in ranking. */
  entityFileIds?: Set<string>;
  /** Multi-source filter (OR-of-sources). Takes precedence over `source` when both set. */
  sources?: string[];
  /** Compiled kind rules — see KIND_TO_RULES. Caller (Search tool) translates `kind` → rules. */
  kindRules?: KindRule[];
  /**
   * Dev-tools trace hook. Undefined in production, which is what keeps the reporting path
   * free: every call site is optional-chained and the one extra query it needs is guarded
   * on this being set.
   */
  stageReport?: StageReporter;
}

export interface HybridSearchResult {
  resultKind: "file" | "email_thread";
  id: string;
  hitFileId: string;
  fileName: string;
  source: string;
  contentCategory: string;
  summary: string | null;
  /** External provider ID (e.g. ClickUp task id, Fireflies transcript id). Some sources prefix subtypes (e.g. `doc:`, `db-`, `project-`). */
  providerFileId: string;
  providerUrl: string | null;
  sourcePath: string | null;
  sourceUpdatedAt: string | null;
  /** Source-side creation date — used by recency tie-break when sourceUpdatedAt ties. */
  sourceCreatedAt: string | null;
  /** Text snippet from the best matching chunk (null for images). */
  snippet: string | null;
  /** Vector similarity score 0-1 (null if no vector match). */
  similarity: number | null;
  /** Combined score (higher = more relevant). */
  score: number;
  threadKey?: string;
  messageCount?: number;
  latestSubject?: string;
  lastActivity?: string | null;
  participants?: string[];
}

/**
 * pgvector caps `hnsw.ef_search` at 1000. Sized to the requested candidate limit, because
 * a non-iterative scan cannot return more rows than this.
 */
function hnswEfSearch(vecLimit: number): number {
  return Math.min(1000, Math.max(40, vecLimit));
}

/** RRF constant — standard value from the original paper. */
const RRF_K = 60;

/** Score boost for files linked to entities matching the search query. */
const ENTITY_BOOST = 0.005;

/**
 * Hybrid search combining FTS5 keyword search and vector similarity.
 *
 * Opens its own transaction for the Postgres KNN reads, so it must not be called from
 * inside a caller's transaction: the inner COMMIT would end the outer one early. No
 * production caller does this today, and tests that need an ambient transaction get
 * their own database instead.
 *
 * Strategy:
 * 1. Run FTS5 search → ranked keyword results
 * 2. Run vector KNN search → ranked semantic results
 * 3. Merge via reciprocal rank fusion (RRF)
 * 4. Apply metadata filters (time, type, source)
 * 5. Apply RBAC
 */
export async function hybridSearch(
  db: Kysely<DB>,
  query: string,
  opts?: HybridSearchOptions,
): Promise<HybridSearchResult[]> {
  const limit = opts?.limit ?? 10;
  const candidateLimit = Math.max(limit * 40, 200);
  if (opts?.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];
  let scoredChunks: VectorChunkHit[] = [];
  /** Counted over every scored chunk, not the capped display slice. */
  let totalChunksScored = 0;
  let totalFieldVectors = 0;
  let totalImageVectors = 0;
  const ftsResults = new Map<string, { rank: number; snippet: string | null }>();
  const vecResults = new Map<string, { rank: number; similarity: number; snippet: string | null }>();

  // ── 0. Build filter fragments ────────────────────────────────
  const fileIdFilter =
    opts?.fileIds && opts.fileIds.length > 0
      ? sql`AND indexed_files.id IN (${sql.join(
          opts.fileIds.map((id) => sql`${id}`),
          sql`,`,
        )})`
      : sql``;
  // Push `kind` and `sources` into FTS so candidates outside the requested
  // kind don't crowd out matches; we'd otherwise lose them past `limit * 3`.
  const kindFilter = opts?.kindRules?.length ? kindFilterSql(opts.kindRules) : sql``;
  const sourcesFilter =
    opts?.sources && opts.sources.length > 0
      ? sql`AND indexed_files.source IN (${sql.join(
          opts.sources.map((s) => sql`${s}`),
          sql`,`,
        )})`
      : sql``;

  // ── 1. FTS keyword search ───────────────────────────────────
  if (isPg(db)) {
    const tsQuery = sanitizeTsQuery(query);
    if (tsQuery) {
      const pgFtsRows = await sql<{ id: string; rank: number }>`
        SELECT indexed_files.id, ts_rank(indexed_files.search_vector, plainto_tsquery('english', ${query})) as rank
        FROM indexed_files
        WHERE indexed_files.search_vector @@ plainto_tsquery('english', ${query})
        AND indexed_files.is_archived = 0
        ${fileIdFilter}
        ${kindFilter}
        ${sourcesFilter}
        ORDER BY rank DESC
        LIMIT ${candidateLimit}
      `.execute(db);

      for (let i = 0; i < pgFtsRows.rows.length; i++) {
        const row = pgFtsRows.rows[i];
        ftsResults.set(row.id, { rank: i + 1, snippet: null });
      }
    }
  } else {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      /**
       * BM25 weights are positional over the FTS5 columns, which migration 196 changed
       * to (file_name, summary, source_path). The old 10/1/3 was written when column two
       * was `source`, and left unchanged it ranks a folder-name match above a summary
       * match — the opposite of the Postgres side. 10/4/2 mirrors the ts_rank ratio
       * there (A=1.0, B=0.4, C=0.2), so both dialects agree that name beats summary
       * beats path.
       */
      const ftsRows = await sql<{
        id: string;
        rank: number;
      }>`
        SELECT indexed_files.id, bm25(indexed_files_fts, 10.0, 4.0, 2.0) as rank
        FROM indexed_files
        INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
        WHERE indexed_files_fts MATCH ${ftsQuery}
        AND indexed_files.is_archived = 0
        ${fileIdFilter}
        ${kindFilter}
        ${sourcesFilter}
        ORDER BY rank
        LIMIT ${candidateLimit}
      `.execute(db);

      for (let i = 0; i < ftsRows.rows.length; i++) {
        const row = ftsRows.rows[i];
        ftsResults.set(row.id, { rank: i + 1, snippet: null });
      }
    }
  }

  // ── 2. Vector search (chunk embeddings + file embeddings) ───
  if (opts?.queryEmbedding) {
    const embeddingJson = JSON.stringify(opts.queryEmbedding);
    const vecLimit = candidateLimit;

    let chunkRows: { rows: Array<{ indexed_file_id: string; chunk_content: string; distance: number }> };
    let fileRows: { rows: Array<{ indexed_file_id: string; distance: number }> };
    let fieldRows: { rows: Array<{ indexed_file_id: string; field: string; source_text: string; distance: number }> } =
      {
        rows: [],
      };

    if (isPg(db)) {
      const dims = EMBEDDING_DIMENSIONS;
      const vectorFilter = vectorPredicateSql(opts);

      /**
       * Both KNN reads run inside one transaction, because `SET LOCAL` outside a
       * transaction block is a no-op — Postgres emits a WARNING and the setting never
       * applies. Without the transaction the two settings below silently do nothing and
       * the pool stays capped at the 40-row default.
       *
       * `ef_search` must be at least the requested LIMIT: a non-iterative HNSW scan
       * returns at most `ef_search` rows, so asking for 400 with the default 40 silently
       * truncates the candidate pool. `iterative_scan` then covers the filtered case,
       * where a plain scan would hand back `ef_search` tuples and let the WHERE discard
       * most of them. `relaxed_order` is safe here because candidates are re-sorted by
       * distance in JS before ranks are assigned.
       */
      const vectorRows = await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL hnsw.ef_search = ${sql.lit(hnswEfSearch(vecLimit))}`.execute(trx);
        await sql`SET LOCAL hnsw.iterative_scan = relaxed_order`.execute(trx);

        const chunks = await sql<{ indexed_file_id: string; chunk_content: string; distance: number }>`
          SELECT
            dc.indexed_file_id,
            dc.content as chunk_content,
            (ce.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
          FROM chunk_embeddings ce
          INNER JOIN document_chunks dc ON dc.id = ce.chunk_id
          INNER JOIN indexed_files ON indexed_files.id = dc.indexed_file_id
          WHERE indexed_files.is_archived = 0
          ${vectorFilter}
          ORDER BY ce.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
          LIMIT ${vecLimit}
        `.execute(trx);

        const files = await sql<{ indexed_file_id: string; distance: number }>`
          SELECT
            fe.indexed_file_id,
            (fe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
          FROM file_embeddings fe
          INNER JOIN indexed_files ON indexed_files.id = fe.indexed_file_id
          WHERE indexed_files.is_archived = 0
          ${vectorFilter}
          ORDER BY fe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
          LIMIT ${vecLimit}
        `.execute(trx);

        /** The file's own name and summary, as their own vectors. */
        const fields = await sql<{ indexed_file_id: string; field: string; source_text: string; distance: number }>`
          SELECT
            ffe.indexed_file_id,
            ffe.field,
            ffe.source_text,
            (ffe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
          FROM file_field_embeddings ffe
          INNER JOIN indexed_files ON indexed_files.id = ffe.indexed_file_id
          WHERE indexed_files.is_archived = 0
          ${vectorFilter}
          ORDER BY ffe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
          LIMIT ${vecLimit}
        `.execute(trx);

        return { chunks, files, fields };
      });
      chunkRows = vectorRows.chunks;
      fileRows = vectorRows.files;
      fieldRows = vectorRows.fields;
    } else {
      // Search chunk embeddings (text documents)
      chunkRows = await sql<{
        indexed_file_id: string;
        chunk_content: string;
        distance: number;
      }>`
        SELECT
          dc.indexed_file_id,
          dc.content as chunk_content,
          ce.distance
        FROM chunk_embeddings ce
        INNER JOIN document_chunks dc ON dc.id = ce.chunk_id
        WHERE ce.embedding MATCH ${embeddingJson}
          AND k = ${vecLimit}
        ORDER BY ce.distance ASC
      `.execute(db);

      // Search file embeddings (images)
      fileRows = await sql<{
        indexed_file_id: string;
        distance: number;
      }>`
        SELECT
          fe.indexed_file_id,
          fe.distance
        FROM file_embeddings fe
        WHERE fe.embedding MATCH ${embeddingJson}
          AND k = ${vecLimit}
        ORDER BY fe.distance ASC
      `.execute(db);
    }

    // Merge vector results — keep best distance per file
    let vecRank = 1;
    const allVecResults: Array<{
      fileId: string;
      distance: number;
      snippet: string | null;
    }> = [];

    // Deduplicate chunk results by file (keep best chunk per file)
    const bestChunkPerFile = new Map<string, { distance: number; snippet: string }>();
    for (const row of chunkRows.rows) {
      const existing = bestChunkPerFile.get(row.indexed_file_id);
      if (!existing || row.distance < existing.distance) {
        bestChunkPerFile.set(row.indexed_file_id, {
          distance: row.distance,
          snippet: row.chunk_content.slice(0, 200),
        });
      }
    }

    /**
     * One entry per file, at its best distance across every source: content chunks, the
     * image embedding, the file name and the summary. Taking the minimum matters — a
     * source-priority merge would let a mediocre content chunk mask a near-exact name
     * match, which is the case this whole change exists to fix.
     */
    const bestPerFile = new Map<string, { distance: number; snippet: string | null }>();
    const offer = (fileId: string, distance: number, snippet: string | null) => {
      const existing = bestPerFile.get(fileId);
      if (!existing || distance < existing.distance) bestPerFile.set(fileId, { distance, snippet });
    };
    for (const [fileId, data] of bestChunkPerFile) offer(fileId, data.distance, data.snippet);
    for (const row of fileRows.rows) offer(row.indexed_file_id, row.distance, null);
    for (const row of fieldRows.rows) offer(row.indexed_file_id, row.distance, row.source_text.slice(0, 200));
    for (const [fileId, data] of bestPerFile) {
      allVecResults.push({ fileId, distance: data.distance, snippet: data.snippet });
    }

    /**
     * Vector-grain capture for the trace, ranked across every source rather than per
     * source. A file is reachable through four independent vectors — its content chunks,
     * its name, its summary, and (for images) its file embedding — so a hit is only
     * legible if the trace says which one matched and with what text.
     *
     * `bestForFile` is read off `bestPerFile`, not off the chunk map: a content chunk
     * that lost the file to a closer summary vector has not survived into the fusion,
     * and marking it green would misreport exactly the case this change exists to show.
     */
    if (opts?.stageReport) {
      /**
       * Postgres pushes the entity scope into the KNN SQL, but the SQLite arm cannot and
       * filters in JS further down. Applying the scope here keeps the trace honest on
       * both dialects: without it a scoped SQLite search shows — and credits — vectors
       * belonging to files that never reach the result set. On Postgres this is a no-op,
       * because the rows arrived scoped already.
       */
      const scope = opts.fileIds && opts.fileIds.length > 0 ? new Set(opts.fileIds) : null;
      const inScope = (fileId: string) => !scope || scope.has(fileId);

      const hits: ScoredVector[] = [];
      for (const row of chunkRows.rows) {
        if (!inScope(row.indexed_file_id)) continue;
        totalChunksScored++;
        hits.push({
          fileId: row.indexed_file_id,
          source: "content",
          preview: row.chunk_content.slice(0, 240),
          distance: row.distance,
        });
      }
      for (const row of fieldRows.rows) {
        if (!inScope(row.indexed_file_id)) continue;
        totalFieldVectors++;
        hits.push({
          fileId: row.indexed_file_id,
          source: row.field === "file_name" ? "file_name" : "summary",
          preview: row.source_text.slice(0, 240),
          distance: row.distance,
        });
      }
      for (const row of fileRows.rows) {
        if (!inScope(row.indexed_file_id)) continue;
        totalImageVectors++;
        hits.push({ fileId: row.indexed_file_id, source: "image", preview: "", distance: row.distance });
      }
      scoredChunks = selectVectorHitsForDisplay(rankVectorHits(hits), VECTOR_HIT_DISPLAY_CAP);
    }

    // Filter by file IDs if entity-scoped
    const filteredVecResults =
      opts?.fileIds && opts.fileIds.length > 0
        ? allVecResults.filter((r) => opts.fileIds?.includes(r.fileId))
        : allVecResults;

    // Sort by distance (ascending) and assign ranks
    filteredVecResults.sort((a, b) => a.distance - b.distance);
    for (const item of filteredVecResults) {
      // Convert distance to similarity (cosine distance → similarity)
      const similarity = 1 - item.distance;
      vecResults.set(item.fileId, {
        rank: vecRank++,
        similarity: Math.max(0, similarity),
        snippet: item.snippet,
      });
    }
  }

  opts?.stageReport?.({
    stage: "ftsCandidates",
    label: "Keyword candidates",
    kind: "code",
    status: "done",
    summary: {
      candidates: ftsResults.size,
      dialect: isPg(db) ? "ts_rank" : "bm25",
      sanitisedQuery: isPg(db) ? sanitizeTsQuery(query) : sanitizeFtsQuery(query),
      candidateLimit,
    },
  });
  opts?.stageReport?.(
    opts?.queryEmbedding
      ? {
          stage: "vectorCandidates",
          label: "Vector candidates",
          kind: "code",
          status: "done",
          summary: {
            chunksScored: totalChunksScored,
            fieldVectorsScored: totalFieldVectors,
            imageVectorsScored: totalImageVectors,
            hitsShown: scoredChunks.length,
            filesAfterDedup: vecResults.size,
            candidateLimit,
          },
          vectorChunks: scoredChunks,
        }
      : {
          stage: "vectorCandidates",
          label: "Vector candidates",
          kind: "code",
          status: "skipped",
          error: "No query embedding — keyword-only search",
        },
  );

  // ── 3. Merge via RRF ───────────────────────────────────────
  const allFileIds = new Set([...ftsResults.keys(), ...vecResults.keys()]);
  const scored: Array<{ fileId: string; score: number; snippet: string | null; similarity: number | null }> = [];

  for (const fileId of allFileIds) {
    const fts = ftsResults.get(fileId);
    const vec = vecResults.get(fileId);

    // RRF: score = sum of 1/(k + rank) for each ranking the doc appears in
    let score = 0;
    if (fts) score += 1 / (RRF_K + fts.rank);
    if (vec) score += 1 / (RRF_K + vec.rank);

    // Entity boost: files linked to entities matching the query get a score bump
    if (opts?.entityFileIds?.has(fileId)) {
      score += ENTITY_BOOST;
    }

    scored.push({
      fileId,
      score,
      snippet: vec?.snippet ?? null,
      similarity: vec?.similarity ?? null,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  opts?.stageReport?.({
    stage: "fuse",
    label: "Fuse rankings",
    kind: "code",
    status: "done",
    summary: {
      rrfK: RRF_K,
      entityBoost: ENTITY_BOOST,
      boostedFiles: opts?.entityFileIds?.size ?? 0,
      scored: scored.length,
    },
  });

  // ── 4. Fetch file metadata and apply filters ────────────────
  const topFileIds = scored.slice(0, candidateLimit).map((s) => s.fileId);
  if (topFileIds.length === 0) {
    /**
     * Nothing scored, so the remaining stages never execute. They still report — a trace
     * that simply stops is indistinguishable from one that crashed, and "no candidates
     * survived scoring" is the answer someone opened the trace to find.
     */
    for (const [stage, label] of [
      ["filter", "Metadata filters"],
      ["rbac", "Access filter"],
      ["finalize", "Collapse and slice"],
    ] as const) {
      opts?.stageReport?.({
        stage,
        label,
        kind: "code",
        status: "skipped",
        error: "No candidates were scored — keyword and vector search both returned nothing",
      });
    }
    return [];
  }

  const scoreMap = new Map(scored.map((s) => [s.fileId, s]));

  // Build metadata query with filters
  let metaQuery = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "source",
      "content_category",
      "summary",
      "connector_config_id",
      "thread_id",
      "file_type",
      "provider_file_id",
      "provider_url",
      "source_path",
      "source_updated_at",
      "source_created_at",
      "access_scope_id",
    ])
    .where("id", "in", topFileIds)
    .where("is_archived", "=", 0);

  if (opts?.source) {
    metaQuery = metaQuery.where("source", "=", opts.source);
  }
  if (opts?.sources && opts.sources.length > 0) {
    metaQuery = metaQuery.where("source", "in", opts.sources);
  }
  if (opts?.kindRules?.length) {
    const rules = opts.kindRules;
    metaQuery = metaQuery.where((eb) =>
      eb.or(
        rules.map((r) => {
          const conds = [];
          if (r.sources?.length) conds.push(eb("indexed_files.source", "in", r.sources));
          if (r.fileTypes?.length) conds.push(eb("indexed_files.file_type", "in", r.fileTypes));
          if (conds.length === 0) return eb.val(true);
          return conds.length === 1 ? conds[0] : eb.and(conds);
        }),
      ),
    );
  }
  if (opts?.category) {
    metaQuery = metaQuery.where("content_category", "=", opts.category);
  }
  if (opts?.contentTypes && opts.contentTypes.length > 0) {
    metaQuery = metaQuery.where("content_category", "in", opts.contentTypes);
  }

  const files = await metaQuery.execute();

  // ── 5. Apply time filter ────────────────────────────────────
  let filteredFiles = files;
  if (opts?.timeFilter) {
    const { after, before } = opts.timeFilter;

    if (after || before) {
      // Get file IDs that match time filter via timeframes
      const timeframeFileIds = new Set<string>();

      if (after || before) {
        let tfQuery = db
          .selectFrom("document_timeframes")
          .select("indexed_file_id")
          .where("indexed_file_id", "in", topFileIds);

        if (after) {
          tfQuery = tfQuery.where("end_date", ">=", after);
        }
        if (before) {
          tfQuery = tfQuery.where("start_date", "<=", before);
        }
        const tfRows = await tfQuery.execute();
        for (const row of tfRows) {
          timeframeFileIds.add(row.indexed_file_id);
        }
      }

      filteredFiles = files.filter((f) => {
        // Match on file metadata dates OR content timeframes
        const fileDate = f.source_created_at || f.source_updated_at;
        const matchesFileDate = fileDate && (!after || fileDate >= after) && (!before || fileDate <= before);
        const matchesTimeframe = timeframeFileIds.has(f.id);
        return matchesFileDate || matchesTimeframe;
      });
    }
  }

  const dropAttribution = opts?.stageReport
    ? await attributeFilterDrops(db, topFileIds, files, filteredFiles, opts)
    : undefined;
  opts?.stageReport?.({
    stage: "filter",
    label: "Metadata filters",
    kind: "code",
    status: "done",
    summary: {
      scored: topFileIds.length,
      survivedSqlFilters: files.length,
      survivedTimeFilter: filteredFiles.length,
      attributionAvailable: dropAttribution !== undefined,
    },
    outcomes: describeFilters(opts).map((entry) => ({
      subject: entry.label,
      kind: entry.field,
      result: entry.applied ? ("kept" as const) : ("suppressed" as const),
      reason: entry.detail,
    })),
  });

  // ── 6. Apply RBAC (batch query — same pattern as searchFiles) ─
  const principalList = opts?.userPrincipals ?? [];
  let accessFiltered = filteredFiles;

  if (principalList.length > 0 && filteredFiles.length > 0) {
    const fileIds = filteredFiles.map((f) => f.id);

    const accessRows = await sql<{ id: string }>`
      SELECT indexed_files.id
      FROM indexed_files
      WHERE indexed_files.id IN (${sql.join(
        fileIds.map((id) => sql`${id}`),
        sql`,`,
      )})
      AND ${fileAccessFilterSql(principalList, opts?.slackEntitySyncEnabled ?? true)}
    `.execute(db);

    const allowedIds = new Set(accessRows.rows.map((r) => r.id));
    accessFiltered = filteredFiles.filter((f) => allowedIds.has(f.id));
  }

  if (opts?.stageReport && principalList.length > 0) {
    const allowed = new Set(accessFiltered.map((file) => file.id));
    opts.stageReport({
      stage: "rbac",
      label: "Access filter",
      kind: "code",
      status: "done",
      outcomes: filteredFiles.map((file) => ({
        subject: file.file_name,
        kind: file.source,
        result: allowed.has(file.id) ? ("kept" as const) : ("dropped" as const),
        reason: allowed.has(file.id) ? "visible to these principals" : "no matching access principal",
      })),
    });
  }
  opts?.stageReport?.({
    stage: "rbac",
    label: "Access filter",
    kind: "code",
    status: principalList.length > 0 ? "done" : "skipped",
    ...(principalList.length > 0
      ? {
          summary: {
            principals: principalList.length,
            allowed: accessFiltered.length,
            denied: filteredFiles.length - accessFiltered.length,
          },
        }
      : { error: "No principals supplied — access filter not applied" }),
  });

  // ── 7. Build final results ─────────────────────────────────
  const collapsed = await collapseEmailSearchResults(
    db,
    accessFiltered,
    scoreMap,
    opts?.userPrincipals,
    opts?.slackEntitySyncEnabled ?? true,
  );

  const results: HybridSearchResult[] = collapsed.sort((a, b) => b.score - a.score).slice(0, limit);

  if (opts?.stageReport) {
    opts.stageReport({
      stage: "finalize",
      label: "Collapse and slice",
      kind: "code",
      status: "done",
      summary: {
        beforeCollapse: accessFiltered.length,
        afterCollapse: collapsed.length,
        limit,
        returned: results.length,
        droppedByLimit: Math.max(0, collapsed.length - results.length),
      },
      outcomes: collapsed
        .slice()
        .sort((a, b) => b.score - a.score)
        .map((result, index) => ({
          subject: result.fileName,
          kind: result.resultKind === "email_thread" ? `thread of ${result.messageCount ?? "?"}` : result.source,
          result: index < limit ? ("kept" as const) : ("dropped" as const),
          reason:
            index < limit
              ? `returned at position ${index + 1}, score ${result.score.toFixed(5)}`
              : `cut by limit ${limit} (would have been ${index + 1})`,
        })),
      candidates: draftCandidates({
        scored,
        ftsResults,
        vecResults,
        entityFileIds: opts.entityFileIds,
        attribution: dropAttribution,
        accessFiltered,
        collapsed,
        filteredFiles,
      }),
    });
  }

  return results;
}

/**
 * The subset of the metadata predicates that can be pushed into the KNN query.
 *
 * Previously the vector arm carried no WHERE at all: it took the globally nearest rows and
 * filtered afterwards in JS, so a filtered search spent its whole candidate budget on rows
 * it was about to discard. Entity-scoped searches were the worst case — a scope covering a
 * small fraction of the corpus expected almost no surviving candidates.
 *
 * Time and RBAC stay out for now. Both are more expensive predicates and want a plan
 * measured against a real corpus before being pushed down.
 */
function vectorPredicateSql(opts: HybridSearchOptions) {
  const parts = [];
  if (opts.fileIds && opts.fileIds.length > 0) {
    parts.push(
      sql`AND indexed_files.id IN (${sql.join(
        opts.fileIds.map((id) => sql`${id}`),
        sql`,`,
      )})`,
    );
  }
  if (opts.source) parts.push(sql`AND indexed_files.source = ${opts.source}`);
  if (opts.sources && opts.sources.length > 0) {
    parts.push(
      sql`AND indexed_files.source IN (${sql.join(
        opts.sources.map((value) => sql`${value}`),
        sql`,`,
      )})`,
    );
  }
  if (opts.category) parts.push(sql`AND indexed_files.content_category = ${opts.category}`);
  if (opts.kindRules?.length) parts.push(kindFilterSql(opts.kindRules));
  return parts.length > 0 ? sql`${sql.join(parts, sql` `)}` : sql``;
}

/**
 * Which predicates the metadata query actually carried, and which were absent.
 *
 * "no filters set" and "filters set but nothing matched" look identical from counts alone,
 * so the trace states each predicate rather than leaving it to be inferred.
 */
function describeFilters(opts: HybridSearchOptions): Array<{
  field: string;
  label: string;
  applied: boolean;
  detail: string;
}> {
  return [
    { field: "source", label: "Source", value: opts.source ?? null, shown: opts.source ?? "" },
    {
      field: "sources",
      label: "Sources",
      value: opts.sources?.length ? opts.sources : null,
      shown: (opts.sources ?? []).join(", "),
    },
    {
      field: "kind",
      label: "Kind rules",
      value: opts.kindRules?.length ? opts.kindRules : null,
      shown: `${opts.kindRules?.length ?? 0} rule(s)`,
    },
    { field: "category", label: "Category", value: opts.category ?? null, shown: opts.category ?? "" },
    {
      field: "contentTypes",
      label: "Content types",
      value: opts.contentTypes?.length ? opts.contentTypes : null,
      shown: (opts.contentTypes ?? []).join(", "),
    },
    {
      field: "time",
      label: "Time range",
      value: opts.timeFilter?.after || opts.timeFilter?.before ? opts.timeFilter : null,
      shown: `${opts.timeFilter?.after ?? "…"} → ${opts.timeFilter?.before ?? "…"}`,
    },
    {
      field: "fileIds",
      label: "Entity file scope",
      value: opts.fileIds?.length ? opts.fileIds : null,
      shown: `${opts.fileIds?.length ?? 0} file(s)`,
    },
    { field: "archived", label: "Archived excluded", value: true, shown: "is_archived = 0" },
  ].map((entry) => ({
    field: entry.field,
    label: entry.label,
    applied: entry.value !== null,
    detail: entry.value !== null ? entry.shown : "not set",
  }));
}

/**
 * Why each scored file is missing from the metadata result set.
 *
 * Vector candidates are filtered by neither kind, source nor category — only by `fileIds`,
 * in JS — so a file of the wrong kind reaches the fuse and then vanishes when the metadata
 * SQL folds every predicate into one WHERE. At that point the row is gone and with it the
 * file's own name, so reconstructing the reason needs one deliberately unfiltered read.
 *
 * Runs only when a stage reporter is attached, and never propagates: a fault in
 * attribution must degrade the trace, not fail the search that is being traced.
 */
async function attributeFilterDrops(
  db: Kysely<DB>,
  scoredFileIds: string[],
  survivedSql: SearchMetadataFile[],
  survivedTime: SearchMetadataFile[],
  opts: HybridSearchOptions,
): Promise<Map<string, { fileName: string; source: string; droppedAt: StageKey; dropReason: string }> | undefined> {
  try {
    const attribution = new Map<
      string,
      { fileName: string; source: string; droppedAt: StageKey; dropReason: string }
    >();
    if (scoredFileIds.length === 0) return attribution;

    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name", "source", "content_category", "file_type", "is_archived"])
      .where("id", "in", scoredFileIds)
      .execute();

    const survivedSqlIds = new Set(survivedSql.map((file) => file.id));
    const survivedTimeIds = new Set(survivedTime.map((file) => file.id));

    for (const row of rows) {
      const identity = { fileName: row.file_name, source: row.source };
      if (!survivedSqlIds.has(row.id)) {
        attribution.set(row.id, {
          ...identity,
          droppedAt: "filter",
          dropReason: sqlFilterReason(row, opts),
        });
        continue;
      }
      if (!survivedTimeIds.has(row.id)) {
        attribution.set(row.id, { ...identity, droppedAt: "filter", dropReason: "outside the requested time range" });
        continue;
      }
      attribution.set(row.id, { ...identity, droppedAt: "filter", dropReason: "" });
    }
    return attribution;
  } catch {
    return undefined;
  }
}

/**
 * Mirrors the predicates the metadata query folds into its WHERE. Pinned by test against
 * the SQL on both dialects — the day these drift, the trace starts lying.
 */
function sqlFilterReason(
  row: { is_archived: number; source: string; content_category: string; file_type: string | null },
  opts: HybridSearchOptions,
): string {
  if (row.is_archived !== 0) return "archived";
  if (opts.source && row.source !== opts.source) return `source is ${row.source}, not ${opts.source}`;
  if (opts.sources?.length && !opts.sources.includes(row.source))
    return `source ${row.source} not in the requested set`;
  if (opts.category && row.content_category !== opts.category) {
    return `category is ${row.content_category}, not ${opts.category}`;
  }
  if (opts.contentTypes?.length && !opts.contentTypes.includes(row.content_category)) {
    return `content type ${row.content_category} not in the requested set`;
  }
  if (opts.kindRules?.length) {
    const matches = opts.kindRules.some((rule) => {
      const sourceOk = rule.sources?.length ? rule.sources.includes(row.source) : true;
      const typeOk = rule.fileTypes?.length ? rule.fileTypes.includes(row.file_type ?? "") : true;
      return rule.sources?.length || rule.fileTypes?.length ? sourceOk && typeOk : true;
    });
    if (!matches) return `does not match the requested kind (source ${row.source}, type ${row.file_type ?? "none"})`;
  }
  return "excluded by a metadata filter";
}

/**
 * One row per scored candidate, with positions left null.
 *
 * Final positions cannot be assigned here: `search()` may still re-sort for recency, and
 * the Search tool applies its own post-sort after that. The caller fills them in once the
 * order the caller actually received is known.
 */
function draftCandidates(input: {
  scored: Array<{ fileId: string; score: number; similarity: number | null }>;
  ftsResults: Map<string, { rank: number }>;
  vecResults: Map<string, { rank: number; similarity: number }>;
  entityFileIds?: Set<string>;
  attribution?: Map<string, { fileName: string; source: string; droppedAt: StageKey; dropReason: string }>;
  accessFiltered: SearchMetadataFile[];
  collapsed: HybridSearchResult[];
  filteredFiles: SearchMetadataFile[];
}): SearchCandidate[] {
  const allowedIds = new Set(input.accessFiltered.map((file) => file.id));
  const timeSurvivorIds = new Set(input.filteredFiles.map((file) => file.id));
  const identity = new Map(input.accessFiltered.map((file) => [file.id, file]));
  const survivingHits = new Set(input.collapsed.map((result) => result.hitFileId));
  const threadOf = new Map<string, string>();
  for (const file of input.accessFiltered) {
    if (file.file_type === "email_message") {
      threadOf.set(file.id, `${file.connector_config_id}:${file.thread_id ?? file.id}`);
    }
  }

  return input.scored.map((entry) => {
    const attributed = input.attribution?.get(entry.fileId);
    const file = identity.get(entry.fileId);
    const base: SearchCandidate = {
      fileId: entry.fileId,
      fileName: file?.file_name ?? attributed?.fileName ?? entry.fileId,
      source: file?.source ?? attributed?.source ?? "unknown",
      ftsRank: input.ftsResults.get(entry.fileId)?.rank ?? null,
      vecRank: input.vecResults.get(entry.fileId)?.rank ?? null,
      similarity: entry.similarity,
      boosted: input.entityFileIds?.has(entry.fileId) ?? false,
      score: entry.score,
      finalPosition: null,
      droppedAt: null,
      dropReason: null,
      mergedInto: null,
    };

    if (!timeSurvivorIds.has(entry.fileId)) {
      return {
        ...base,
        droppedAt: "filter",
        dropReason: attributed?.dropReason || "excluded by a metadata filter",
      };
    }
    if (!allowedIds.has(entry.fileId)) {
      return { ...base, droppedAt: "rbac", dropReason: "no matching access principal" };
    }
    if (!survivingHits.has(entry.fileId)) {
      const thread = threadOf.get(entry.fileId);
      return thread
        ? { ...base, mergedInto: thread }
        : { ...base, droppedAt: "finalize", dropReason: "below the result limit" };
    }
    return base;
  });
}

type SearchMetadataFile = {
  id: string;
  file_name: string;
  source: string;
  content_category: string;
  summary: string | null;
  connector_config_id: string;
  thread_id: string | null;
  file_type: string | null;
  provider_file_id: string;
  provider_url: string | null;
  source_path: string | null;
  source_updated_at: string | null;
  source_created_at: string | null;
  access_scope_id: string | null;
};

type SearchScoreData = { fileId: string; score: number; snippet: string | null; similarity: number | null };

type EmailEnvelopeSearchRow = {
  indexed_file_id: string;
  connector_config_id: string;
  thread_id: string | null;
  subject: string | null;
  sent_at: string | null;
  from_json: string;
  to_json: string;
  cc_json: string;
};

function emailLabel(addr: EmailAddr): string {
  return addr.name?.trim() || addr.email;
}

async function collapseEmailSearchResults(
  db: Kysely<DB>,
  files: SearchMetadataFile[],
  scoreMap: Map<string, SearchScoreData>,
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<HybridSearchResult[]> {
  const emailFiles = files.filter((file) => file.file_type === "email_message");
  const visibleThreadEnvelopes = await loadVisibleThreadEnvelopes(
    db,
    emailFiles,
    userPrincipals,
    slackEntitySyncEnabled,
  );
  const groups = new Map<string, SearchMetadataFile[]>();
  const output: HybridSearchResult[] = [];

  for (const file of files) {
    if (file.file_type !== "email_message") {
      const scoreData = scoreMap.get(file.id);
      output.push({
        resultKind: "file",
        id: file.id,
        hitFileId: file.id,
        fileName: file.file_name,
        source: file.source,
        contentCategory: file.content_category,
        summary: file.summary,
        providerFileId: file.provider_file_id,
        providerUrl: file.provider_url,
        sourcePath: file.source_path,
        sourceUpdatedAt: file.source_updated_at,
        sourceCreatedAt: file.source_created_at,
        snippet: scoreData?.snippet ?? null,
        similarity: scoreData?.similarity ?? null,
        score: scoreData?.score ?? 0,
      });
      continue;
    }

    const key = `${file.connector_config_id}:${file.thread_id ?? file.id}`;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }

  for (const [threadKey, group] of groups) {
    const best = [...group].sort((a, b) => (scoreMap.get(b.id)?.score ?? 0) - (scoreMap.get(a.id)?.score ?? 0))[0];
    const bestScore = scoreMap.get(best.id);
    const envelopes = visibleThreadEnvelopes.get(threadKey) ?? [];
    const latest = [...envelopes].sort((a, b) => {
      if (a.sent_at && b.sent_at && a.sent_at !== b.sent_at) return b.sent_at.localeCompare(a.sent_at);
      if (a.sent_at && !b.sent_at) return -1;
      if (!a.sent_at && b.sent_at) return 1;
      return b.indexed_file_id.localeCompare(a.indexed_file_id);
    })[0];
    const participants = new Map<string, string>();
    for (const envelope of envelopes) {
      for (const addr of [
        parseEmailAddrJson(envelope.from_json),
        ...parseEmailAddrListJson(envelope.to_json),
        ...parseEmailAddrListJson(envelope.cc_json),
      ]) {
        if (!participants.has(addr.email)) participants.set(addr.email, emailLabel(addr));
      }
    }

    output.push({
      resultKind: "email_thread",
      id: best.id,
      hitFileId: best.id,
      threadKey,
      messageCount: envelopes.length || group.length,
      latestSubject: latest?.subject ?? best.file_name,
      lastActivity: latest?.sent_at ?? best.source_created_at ?? best.source_updated_at,
      participants: [...participants.values()].slice(0, 6),
      fileName: latest?.subject ?? best.file_name,
      source: best.source,
      contentCategory: best.content_category,
      summary: best.summary,
      providerFileId: best.provider_file_id,
      providerUrl: best.provider_url,
      sourcePath: best.source_path,
      sourceUpdatedAt: best.source_updated_at,
      sourceCreatedAt: best.source_created_at,
      snippet: bestScore?.snippet ?? null,
      similarity: bestScore?.similarity ?? null,
      score: bestScore?.score ?? 0,
    });
  }

  return output;
}

async function loadVisibleThreadEnvelopes(
  db: Kysely<DB>,
  emailFiles: SearchMetadataFile[],
  userPrincipals?: AccessPrincipalInput[],
  slackEntitySyncEnabled = true,
): Promise<Map<string, EmailEnvelopeSearchRow[]>> {
  const rowsByThread = new Map<string, EmailEnvelopeSearchRow[]>();
  if (emailFiles.length === 0) return rowsByThread;

  const threadIds = [...new Set(emailFiles.map((file) => file.thread_id).filter((id): id is string => !!id))];
  const directRows =
    threadIds.length > 0
      ? await db
          .selectFrom("email_message_envelopes")
          .innerJoin("indexed_files", "indexed_files.id", "email_message_envelopes.indexed_file_id")
          .select([
            "email_message_envelopes.indexed_file_id",
            "email_message_envelopes.connector_config_id",
            "email_message_envelopes.thread_id",
            "email_message_envelopes.subject",
            "email_message_envelopes.sent_at",
            "email_message_envelopes.from_json",
            "email_message_envelopes.to_json",
            "email_message_envelopes.cc_json",
          ])
          .where("indexed_files.is_archived", "=", 0)
          .where("email_message_envelopes.thread_id", "in", threadIds)
          .execute()
      : [];

  const singletonFileIds = emailFiles.filter((file) => !file.thread_id).map((file) => file.id);
  const singletonRows =
    singletonFileIds.length > 0
      ? await db
          .selectFrom("email_message_envelopes")
          .select([
            "indexed_file_id",
            "connector_config_id",
            "thread_id",
            "subject",
            "sent_at",
            "from_json",
            "to_json",
            "cc_json",
          ])
          .where("indexed_file_id", "in", singletonFileIds)
          .execute()
      : [];

  const candidateKeys = new Set(emailFiles.map((file) => `${file.connector_config_id}:${file.thread_id ?? file.id}`));
  const allRows = [...directRows, ...singletonRows].filter((row) =>
    candidateKeys.has(`${row.connector_config_id}:${row.thread_id ?? row.indexed_file_id}`),
  );
  const visibleIds = await filterAccessibleFileIds(
    db,
    allRows.map((row) => row.indexed_file_id),
    userPrincipals,
    slackEntitySyncEnabled,
  );

  for (const row of allRows) {
    if (!visibleIds.has(row.indexed_file_id)) continue;
    const key = `${row.connector_config_id}:${row.thread_id ?? row.indexed_file_id}`;
    const group = rowsByThread.get(key) ?? [];
    group.push(row);
    rowsByThread.set(key, group);
  }

  return rowsByThread;
}

/**
 * Browse files by folder path and source. No search query needed.
 */
export async function browseFiles(
  db: Kysely<DB>,
  opts?: {
    source?: string;
    folderPath?: string;
    contentCategory?: string;
    limit?: number;
    userPrincipals?: AccessPrincipalInput[];
    slackEntitySyncEnabled?: boolean;
  },
): Promise<
  Array<{
    id: string;
    fileName: string;
    providerUrl: string | null;
    sourcePath: string | null;
    contentCategory: string;
    sourceUpdatedAt: string | null;
  }>
> {
  const limit = opts?.limit ?? 20;

  let query = db
    .selectFrom("indexed_files")
    .select(["id", "file_name", "provider_url", "source_path", "content_category", "source_updated_at"])
    .where("is_archived", "=", 0);

  if (opts?.source) {
    query = query.where("source", "=", opts.source);
  }
  if (opts?.folderPath) {
    const escaped = opts.folderPath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    query = query.where(sql<SqlBool>`source_path LIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }
  if (opts?.contentCategory) {
    query = query.where("content_category", "=", opts.contentCategory);
  }

  query = query.orderBy("source_updated_at", "desc").limit(limit);

  const rows = await query.execute();

  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    providerUrl: r.provider_url,
    sourcePath: r.source_path,
    contentCategory: r.content_category,
    sourceUpdatedAt: r.source_updated_at,
  }));
}

/**
 * Resolve a list of entity ids to the file ids that mention them.
 *
 * Mode:
 *  - "or"  → union: any file mentioning any of the entities
 *  - "and" → intersection: file must mention every entity
 *
 * For small `entityIds.length` (≤3) AND mode runs N small queries and intersects
 * Sets in app code — the planner consistently picks index scans for these and
 * the round-trip count is negligible. For larger N a single `GROUP BY ... HAVING
 * COUNT(DISTINCT entity_id)` query takes over (covered by the composite index
 * added in migration 042).
 */
export async function resolveEntityFileIds(db: Kysely<DB>, entityIds: string[], mode: "and" | "or"): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const uniqueIds = [...new Set(entityIds)];

  if (mode === "or" || uniqueIds.length === 1) {
    const rows = await db
      .selectFrom("entity_mentions")
      .select("indexed_file_id")
      .distinct()
      .where("entity_id", "in", uniqueIds)
      .execute();
    return rows.map((r) => r.indexed_file_id);
  }

  if (uniqueIds.length <= 3) {
    const sets = await Promise.all(
      uniqueIds.map(
        async (id) =>
          new Set(
            (
              await db.selectFrom("entity_mentions").select("indexed_file_id").where("entity_id", "=", id).execute()
            ).map((r) => r.indexed_file_id),
          ),
      ),
    );
    let out = sets[0];
    for (let i = 1; i < sets.length; i++) out = new Set([...out].filter((x) => sets[i].has(x)));
    return [...out];
  }

  const rows = await db
    .selectFrom("entity_mentions")
    .select(["indexed_file_id", db.fn.count<number>("entity_id").distinct().as("n")])
    .where("entity_id", "in", uniqueIds)
    .groupBy("indexed_file_id")
    .having((eb) => eb(eb.fn.count("entity_id").distinct(), "=", uniqueIds.length))
    .execute();
  return rows.map((r) => r.indexed_file_id);
}

/**
 * Coerce a date-like value (ISO string from SQLite, Date object from
 * node-postgres) to milliseconds since epoch. Returns null for null /
 * undefined / unparseable input so the caller can sort them last.
 */
function toMs(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Deterministic recency-DESC comparator: source_updated_at, then
 * source_created_at, then id. Null/undefined timestamps sort last.
 */
function byRecencyDesc(a: HybridSearchResult, b: HybridSearchResult): number {
  const at = toMs(a.sourceUpdatedAt) ?? toMs(a.sourceCreatedAt) ?? Number.NEGATIVE_INFINITY;
  const bt = toMs(b.sourceUpdatedAt) ?? toMs(b.sourceCreatedAt) ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  return b.id.localeCompare(a.id);
}

/**
 * Empty-query path: structural filters + RBAC + recency, no FTS / vector.
 *
 * Time filter mirrors hybridSearch (matches file dates OR a document_timeframes
 * overlap) so an `after`/`before` clause behaves the same way regardless of
 * whether the caller provided a query.
 */
async function browseLatest(
  db: Kysely<DB>,
  opts: {
    kindRules?: KindRule[];
    sources?: string[];
    fileIds?: string[];
    userPrincipals?: AccessPrincipalInput[];
    slackEntitySyncEnabled?: boolean;
    after?: string;
    before?: string;
    limit: number;
  },
): Promise<HybridSearchResult[]> {
  // Caller is responsible for the empty-fileIds short-circuit; selectFrom().where("id", "in", [])
  // emits invalid `IN ()` SQL on SQLite.
  if (opts.userPrincipals !== undefined && opts.userPrincipals.length === 0) return [];
  let q = db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "provider_url",
      "provider_file_id",
      "content_category",
      "source",
      "source_path",
      "source_updated_at",
      "source_created_at",
      "summary",
    ])
    .where("is_archived", "=", 0);

  if (opts.kindRules?.length) {
    const rules = opts.kindRules;
    q = q.where((eb) =>
      eb.or(
        rules.map((r) => {
          const conds = [];
          if (r.sources?.length) conds.push(eb("indexed_files.source", "in", r.sources));
          if (r.fileTypes?.length) conds.push(eb("indexed_files.file_type", "in", r.fileTypes));
          if (conds.length === 0) return eb.val(true);
          return conds.length === 1 ? conds[0] : eb.and(conds);
        }),
      ),
    );
  }
  if (opts.sources?.length) q = q.where("source", "in", opts.sources);
  if (opts.fileIds?.length) q = q.where("id", "in", opts.fileIds);

  if ((opts.userPrincipals ?? []).length > 0) {
    const userPrincipals = opts.userPrincipals ?? [];
    q = q.where(fileAccessFilterSql(userPrincipals, opts.slackEntitySyncEnabled ?? true));
  }

  if (opts.after || opts.before) {
    const after = opts.after;
    const before = opts.before;
    q = q.where((eb) => {
      const fileDateExpr = eb.fn.coalesce("source_updated_at", "source_created_at");
      const conds = [];
      if (after) conds.push(eb(fileDateExpr, ">=", after));
      if (before) conds.push(eb(fileDateExpr, "<=", before));
      const fileDateMatches = conds.length === 1 ? conds[0] : eb.and(conds);
      const tfMatches = eb.exists(
        eb
          .selectFrom("document_timeframes")
          .select("indexed_file_id")
          .whereRef("document_timeframes.indexed_file_id", "=", "indexed_files.id")
          .$if(!!after, (qb) => qb.where("end_date", ">=", after as string))
          .$if(!!before, (qb) => qb.where("start_date", "<=", before as string)),
      );
      return eb.or([fileDateMatches, tfMatches]);
    });
  }

  q = q
    .orderBy(sql`COALESCE(source_updated_at, source_created_at)`, "desc")
    .orderBy("source_created_at", "desc")
    .orderBy("id", "desc")
    .limit(opts.limit * 3);

  const rows = await q.execute();

  return rows.slice(0, opts.limit).map((f) => ({
    resultKind: "file" as const,
    id: f.id,
    hitFileId: f.id,
    fileName: f.file_name,
    providerUrl: f.provider_url,
    providerFileId: f.provider_file_id,
    source: f.source,
    sourcePath: f.source_path,
    contentCategory: f.content_category,
    summary: f.summary,
    sourceUpdatedAt: f.source_updated_at,
    sourceCreatedAt: f.source_created_at,
    score: 0,
    similarity: null,
    snippet: null,
  }));
}

/**
 * High-level search: embeds the query (best-effort) then runs hybridSearch.
 * Shared by the API endpoint and the agent Search tool.
 *
 * Routing:
 *   - empty query + at least one structural filter → browseLatest
 *   - non-empty query → hybridSearch
 *
 * sortBy: "recency" overfetches `max(limit*5, 50)` candidates from the hybrid
 * pipeline, then sorts the result set in JS so the truly-newest file isn't
 * dropped by RRF before the recency stage sees it.
 */
export async function search(
  db: Kysely<DB>,
  query: string,
  opts?: {
    source?: string;
    sources?: string[];
    kindRules?: KindRule[];
    category?: string;
    limit?: number;
    after?: string;
    before?: string;
    userPrincipals?: AccessPrincipalInput[];
    slackEntitySyncEnabled?: boolean;
    entityId?: string;
    entityIds?: string[];
    entityIdsMode?: "and" | "or";
    sortBy?: "relevance" | "recency";
    /** Suppress search()'s own auto-entity-boost (caller will manage entityFileIds itself). */
    skipAutoEntityBoost?: boolean;
    geminiMaxRpm?: number;
    geminiMaxRetries?: number;
    openRouterApiKey?: string;
    settingsEncryptionKey?: string;
    logger?: Logger;
    /** Dev-tools trace hook. Undefined in production. */
    stageReport?: StageReporter;
  },
): Promise<HybridSearchResult[]> {
  const limit = opts?.limit ?? 10;
  const isRecency = opts?.sortBy === "recency";
  const trimmedQuery = query.trim();

  // Resolve entityId / entityIds → fileIds for scoped search.
  // Single `entityId` folds into the `entityIds` path (n=1, mode collapses).
  const allEntityIds =
    opts?.entityIds && opts.entityIds.length > 0 ? opts.entityIds : opts?.entityId ? [opts.entityId] : [];
  let fileIds: string[] | undefined;
  if (allEntityIds.length > 0) {
    fileIds = await resolveEntityFileIds(db, allEntityIds, opts?.entityIdsMode ?? "and");
    opts?.stageReport?.({
      stage: "resolveEntities",
      label: "Resolve entity scope",
      kind: "code",
      status: "done",
      summary: {
        entityIds: allEntityIds.length,
        mode: opts?.entityIdsMode ?? "and",
        files: fileIds.length,
      },
    });
    // Empty-set short-circuit: avoid `IN ()` (invalid on SQLite) and skip the work.
    if (fileIds.length === 0) return [];
  } else {
    opts?.stageReport?.({
      stage: "resolveEntities",
      label: "Resolve entity scope",
      kind: "code",
      status: "skipped",
      error: "No entityIds supplied — search was not entity-scoped",
    });
  }

  // Empty-query path: skip FTS/vector entirely. Require at least one structural filter.
  if (trimmedQuery === "") {
    const hasFilter =
      !!opts?.kindRules?.length ||
      !!opts?.sources?.length ||
      !!opts?.source ||
      (fileIds !== undefined && fileIds.length > 0) ||
      !!opts?.after ||
      !!opts?.before;
    if (!hasFilter) return [];
    return browseLatest(db, {
      kindRules: opts?.kindRules,
      sources: opts?.sources ?? (opts?.source ? [opts.source] : undefined),
      fileIds,
      userPrincipals: opts?.userPrincipals,
      slackEntitySyncEnabled: opts?.slackEntitySyncEnabled,
      after: opts?.after,
      before: opts?.before,
      limit,
    });
  }

  let queryEmbedding: number[] | undefined;
  let embedSkippedReason: string | null = null;
  const embedStartedAt = Date.now();
  try {
    const settings = await createSettingsRepository(db, opts?.settingsEncryptionKey).get();
    if (settings?.enrichment_enabled === 0) embedSkippedReason = "Enrichment is disabled in settings";
    if (settings?.enrichment_enabled !== 0) {
      const openRouterConfig = resolveOpenRouterEnrichmentConfig(settings, opts?.openRouterApiKey);
      const embedQuery = createEnrichmentQueryEmbedder({
        geminiApiKey: settings?.gemini_api_key,
        embeddingProvider: settings?.embedding_provider,
        geminiMaxRpm: opts?.geminiMaxRpm,
        geminiMaxRetries: opts?.geminiMaxRetries,
        logger: opts?.logger,
        ...openRouterConfig,
      });
      if (embedQuery) queryEmbedding = await embedQuery(trimmedQuery);
      else embedSkippedReason = "No embedding provider is configured";
    }
  } catch (err) {
    // Vector search is best-effort — fall back to FTS5 only
    embedSkippedReason = err instanceof Error ? err.message : String(err);
  }

  /**
   * Losing the embedding silently turns every search into keyword-only matching, which on a
   * corpus with generated file names is close to no search at all. The stage reports are
   * dev-tools-only, so without this the degradation has no production signal whatsoever.
   */
  if (!queryEmbedding && trimmedQuery !== "") {
    opts?.logger?.error(
      { event: "search_query_embedding_unavailable", reason: embedSkippedReason },
      "Search fell back to keyword-only — no query embedding",
    );
  }

  opts?.stageReport?.(
    queryEmbedding
      ? {
          stage: "embedQuery",
          label: "Embed query",
          kind: "code",
          status: "done",
          summary: {
            dimensions: queryEmbedding.length,
            latencyMs: Date.now() - embedStartedAt,
            magnitude: Math.sqrt(queryEmbedding.reduce((sum, value) => sum + value * value, 0)),
            nonZero: queryEmbedding.filter((value) => value !== 0).length,
            /** First slice of the actual vector — enough to eyeball that it is real and not all zeros. */
            preview: queryEmbedding.slice(0, 24).map((value) => Number(value.toFixed(5))),
          },
        }
      : {
          stage: "embedQuery",
          label: "Embed query",
          kind: "code",
          status: "skipped",
          error: embedSkippedReason ?? "No embedding produced — keyword-only search",
        },
  );

  // Auto-entity-discovery boost. Suppressed when the caller already pinned
  // entityIds (would double-count) or asked to skip it.
  let entityFileIds: Set<string> | undefined;
  if (allEntityIds.length === 0 && !opts?.skipAutoEntityBoost) {
    try {
      const entityRepo = createEntityRepository(db);
      const matchingEntities = await entityRepo.searchEntities(trimmedQuery, { limit: 10 });
      if (matchingEntities.length > 0) {
        const entityIds = matchingEntities.map((e) => e.id);
        const mentions = await db
          .selectFrom("entity_mentions")
          .select("indexed_file_id")
          .where("entity_id", "in", entityIds)
          .execute();
        if (mentions.length > 0) {
          entityFileIds = new Set(mentions.map((m) => m.indexed_file_id));
        }
      }
      opts?.stageReport?.({
        stage: "discoverEntities",
        label: "Discover entities",
        kind: "code",
        status: "done",
        summary: {
          set: "fuse boost",
          entitiesMatched: matchingEntities.length,
          filesBoosted: entityFileIds?.size ?? 0,
          note: "search()'s own discovery, limit 10, not public-filtered. This is the set applied at RRF fuse.",
        },
        outcomes: matchingEntities.map((entity) => ({
          subject: entity.name,
          kind: entity.source_type,
          result: "linked" as const,
          reason: "boosts files mentioning this entity",
        })),
      });
    } catch (err) {
      // Entity boost is best-effort
      opts?.stageReport?.({
        stage: "discoverEntities",
        label: "Discover entities",
        kind: "code",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Recency: overfetch from the hybrid pipeline so the truly newest file isn't
  // dropped past `limit` by RRF, then sort in JS and trim.
  const fetchLimit = isRecency ? Math.max(limit * 5, 50) : limit;

  const results = await hybridSearch(db, trimmedQuery, {
    stageReport: opts?.stageReport,
    source: opts?.source,
    sources: opts?.sources,
    kindRules: opts?.kindRules,
    category: opts?.category,
    limit: fetchLimit,
    queryEmbedding,
    userPrincipals: opts?.userPrincipals,
    slackEntitySyncEnabled: opts?.slackEntitySyncEnabled,
    fileIds,
    entityFileIds,
    timeFilter: opts?.after || opts?.before ? { after: opts?.after, before: opts?.before } : undefined,
  });

  if (isRecency) {
    results.sort(byRecencyDesc);
    return results.slice(0, limit);
  }
  return results;
}
