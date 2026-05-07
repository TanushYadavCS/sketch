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
import { isPg } from "../db/dialect";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createQueryEmbedder } from "./embeddings";

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

export interface SearchOptions {
  /** Filter by source provider. */
  source?: string;
  /** Max results (default 10). */
  limit?: number;
  /** Content category filter: "document" or "structured". */
  category?: string;
  /**
   * RBAC (user-level): restrict results to files the user can access.
   * Email addresses to match against access_scope_members and file_access.
   * Files with no scope AND no file_access rows are unrestricted (visible to all).
   * When omitted, no user-level filtering is applied.
   */
  userEmails?: string[];
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

  // Build user-level access filter (3-tier model):
  // 1. Unrestricted: no scope AND no file_access rows → visible to all
  // 2. Scope-level: user's email in access_scope_members for the file's scope
  // 3. Per-file: user's email in file_access
  const emailList = opts?.userEmails ?? [];
  const userFilter =
    emailList.length > 0
      ? sql`AND (
				(indexed_files.access_scope_id IS NULL
				 AND NOT EXISTS (SELECT 1 FROM file_access WHERE file_access.indexed_file_id = indexed_files.id))
				OR EXISTS (
					SELECT 1 FROM access_scope_members
					WHERE access_scope_members.access_scope_id = indexed_files.access_scope_id
					AND access_scope_members.email IN (${sql.join(
            emailList.map((e) => sql`${e}`),
            sql`,`,
          )})
				)
				OR EXISTS (
					SELECT 1 FROM file_access
					WHERE file_access.indexed_file_id = indexed_files.id
					AND file_access.email IN (${sql.join(
            emailList.map((e) => sql`${e}`),
            sql`,`,
          )})
				)
			)`
      : sql``;

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
			bm25(indexed_files_fts, 10.0, 1.0, 3.0) as relevance
		FROM indexed_files
		INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
		WHERE indexed_files_fts MATCH ${ftsQuery}
		AND indexed_files.is_archived = 0
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
 * Access control: 3-tier model (unrestricted / scope / per-file) via userEmails.
 */
export async function getFileContent(
  db: Kysely<DB>,
  fileId: string,
  userEmails?: string[],
): Promise<{
  id: string;
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
  const file = await db
    .selectFrom("indexed_files")
    .select([
      "id",
      "file_name",
      "file_type",
      "source",
      "source_path",
      "content",
      "summary",
      "context_note",
      "provider_url",
      "enrichment_status",
      "access_scope_id",
    ])
    .where("id", "=", fileId)
    .executeTakeFirst();

  if (!file) return null;

  // User-level RBAC: 3-tier access check
  if (userEmails && userEmails.length > 0) {
    // Tier 1: unrestricted — no scope and no file_access rows
    const hasScope = file.access_scope_id != null;
    const hasFileAccess = await db
      .selectFrom("file_access")
      .select("email")
      .where("indexed_file_id", "=", fileId)
      .limit(1)
      .execute();

    if (hasScope || hasFileAccess.length > 0) {
      let allowed = false;

      // Tier 2: scope-level access
      if (hasScope && file.access_scope_id) {
        const scopeMatch = await db
          .selectFrom("access_scope_members")
          .select("email")
          .where("access_scope_id", "=", file.access_scope_id)
          .where("email", "in", userEmails)
          .limit(1)
          .execute();
        if (scopeMatch.length > 0) allowed = true;
      }

      // Tier 3: per-file access
      if (!allowed && hasFileAccess.length > 0) {
        const fileMatch = await db
          .selectFrom("file_access")
          .select("email")
          .where("indexed_file_id", "=", fileId)
          .where("email", "in", userEmails)
          .limit(1)
          .execute();
        if (fileMatch.length > 0) allowed = true;
      }

      if (!allowed) return null;
    }
  }

  return {
    id: file.id,
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
 * Applies the 3-tier RBAC model (unrestricted / scope-level / per-file).
 * Returns the input set unchanged when userEmails is empty (no filtering).
 */
export async function filterAccessibleFileIds(
  db: Kysely<DB>,
  fileIds: string[],
  userEmails: string[],
): Promise<Set<string>> {
  if (fileIds.length === 0) return new Set();
  if (userEmails.length === 0) return new Set(fileIds);

  const files = await db
    .selectFrom("indexed_files")
    .select(["id", "access_scope_id"])
    .where("id", "in", fileIds)
    .execute();

  const [fileAccessRows, scopeMemberRows] = await Promise.all([
    db.selectFrom("file_access").select(["indexed_file_id", "email"]).where("indexed_file_id", "in", fileIds).execute(),
    (async () => {
      const scopeIds = files.map((f) => f.access_scope_id).filter((s): s is string => !!s);
      if (scopeIds.length === 0) return [];
      return db
        .selectFrom("access_scope_members")
        .select(["access_scope_id", "email"])
        .where("access_scope_id", "in", scopeIds)
        .where("email", "in", userEmails)
        .execute();
    })(),
  ]);

  const fileAccessByFile = new Map<string, Set<string>>();
  for (const row of fileAccessRows) {
    const set = fileAccessByFile.get(row.indexed_file_id) ?? new Set<string>();
    set.add(row.email);
    fileAccessByFile.set(row.indexed_file_id, set);
  }
  const scopeMemberByScope = new Map<string, Set<string>>();
  for (const row of scopeMemberRows) {
    const set = scopeMemberByScope.get(row.access_scope_id) ?? new Set<string>();
    set.add(row.email);
    scopeMemberByScope.set(row.access_scope_id, set);
  }

  const emailSet = new Set(userEmails);
  const allowed = new Set<string>();
  for (const file of files) {
    const perFile = fileAccessByFile.get(file.id);
    const hasScope = file.access_scope_id != null;
    const hasFileAccess = (perFile?.size ?? 0) > 0;

    if (!hasScope && !hasFileAccess) {
      allowed.add(file.id);
      continue;
    }

    if (hasScope && file.access_scope_id) {
      const scopeMembers = scopeMemberByScope.get(file.access_scope_id);
      if (scopeMembers && scopeMembers.size > 0) {
        allowed.add(file.id);
        continue;
      }
    }

    if (hasFileAccess && perFile) {
      for (const email of emailSet) {
        if (perFile.has(email)) {
          allowed.add(file.id);
          break;
        }
      }
    }
  }
  return allowed;
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
  meeting: [{ sources: ["fireflies"] }],
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
  message: [{ sources: ["conversation"] }],
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
}

export interface HybridSearchResult {
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
  /** Source-side creation date — used by recency tie-break when sourceUpdatedAt ties. */
  sourceCreatedAt: string | null;
  /** Text snippet from the best matching chunk (null for images). */
  snippet: string | null;
  /** Vector similarity score 0-1 (null if no vector match). */
  similarity: number | null;
  /** Combined score (higher = more relevant). */
  score: number;
}

/** RRF constant — standard value from the original paper. */
const RRF_K = 60;

/** Score boost for files linked to entities matching the search query. */
const ENTITY_BOOST = 0.005;

/**
 * Hybrid search combining FTS5 keyword search and vector similarity.
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
        LIMIT ${limit * 3}
      `.execute(db);

      for (let i = 0; i < pgFtsRows.rows.length; i++) {
        const row = pgFtsRows.rows[i];
        ftsResults.set(row.id, { rank: i + 1, snippet: null });
      }
    }
  } else {
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      // BM25 weights: file_name=10, source=1, source_path=3
      const ftsRows = await sql<{
        id: string;
        rank: number;
      }>`
        SELECT indexed_files.id, bm25(indexed_files_fts, 10.0, 1.0, 3.0) as rank
        FROM indexed_files
        INNER JOIN indexed_files_fts ON indexed_files.rowid = indexed_files_fts.rowid
        WHERE indexed_files_fts MATCH ${ftsQuery}
        AND indexed_files.is_archived = 0
        ${fileIdFilter}
        ${kindFilter}
        ${sourcesFilter}
        ORDER BY rank
        LIMIT ${limit * 3}
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
    const vecLimit = limit * 3;

    let chunkRows: { rows: Array<{ indexed_file_id: string; chunk_content: string; distance: number }> };
    let fileRows: { rows: Array<{ indexed_file_id: string; distance: number }> };

    if (isPg(db)) {
      const dims = EMBEDDING_DIMENSIONS;
      chunkRows = await sql<{ indexed_file_id: string; chunk_content: string; distance: number }>`
        SELECT
          dc.indexed_file_id,
          dc.content as chunk_content,
          (ce.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
        FROM chunk_embeddings ce
        INNER JOIN document_chunks dc ON dc.id = ce.chunk_id
        ORDER BY ce.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
        LIMIT ${vecLimit}
      `.execute(db);

      fileRows = await sql<{ indexed_file_id: string; distance: number }>`
        SELECT
          fe.indexed_file_id,
          (fe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})) as distance
        FROM file_embeddings fe
        ORDER BY fe.embedding::halfvec(${sql.lit(dims)}) <=> ${embeddingJson}::halfvec(${sql.lit(dims)})
        LIMIT ${vecLimit}
      `.execute(db);
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

    for (const [fileId, data] of bestChunkPerFile) {
      allVecResults.push({ fileId, distance: data.distance, snippet: data.snippet });
    }
    for (const row of fileRows.rows) {
      if (!bestChunkPerFile.has(row.indexed_file_id)) {
        allVecResults.push({ fileId: row.indexed_file_id, distance: row.distance, snippet: null });
      }
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

  // ── 4. Fetch file metadata and apply filters ────────────────
  const topFileIds = scored.slice(0, limit * 2).map((s) => s.fileId);
  if (topFileIds.length === 0) return [];

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

  // ── 6. Apply RBAC (batch query — same pattern as searchFiles) ─
  const emailList = opts?.userEmails ?? [];
  let accessFiltered = filteredFiles;

  if (emailList.length > 0 && filteredFiles.length > 0) {
    const fileIds = filteredFiles.map((f) => f.id);
    const emailSql = sql.join(
      emailList.map((e) => sql`${e}`),
      sql`,`,
    );

    // Single query: returns IDs of files the user can access.
    // Mirrors the 3-tier model in searchFiles:
    //   T1 — unrestricted (no scope AND no per-file rows)
    //   T2 — user is in the file's access scope
    //   T3 — user has a direct per-file access entry
    const accessRows = await sql<{ id: string }>`
      SELECT indexed_files.id
      FROM indexed_files
      WHERE indexed_files.id IN (${sql.join(
        fileIds.map((id) => sql`${id}`),
        sql`,`,
      )})
      AND (
        (indexed_files.access_scope_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM file_access WHERE file_access.indexed_file_id = indexed_files.id))
        OR EXISTS (
          SELECT 1 FROM access_scope_members
          WHERE access_scope_members.access_scope_id = indexed_files.access_scope_id
          AND access_scope_members.email IN (${emailSql})
        )
        OR EXISTS (
          SELECT 1 FROM file_access
          WHERE file_access.indexed_file_id = indexed_files.id
          AND file_access.email IN (${emailSql})
        )
      )
    `.execute(db);

    const allowedIds = new Set(accessRows.rows.map((r) => r.id));
    accessFiltered = filteredFiles.filter((f) => allowedIds.has(f.id));
  }

  // ── 7. Build final results ─────────────────────────────────
  const results: HybridSearchResult[] = accessFiltered
    .map((f) => {
      const scoreData = scoreMap.get(f.id);
      return {
        id: f.id,
        fileName: f.file_name,
        source: f.source,
        contentCategory: f.content_category,
        summary: f.summary,
        providerFileId: f.provider_file_id,
        providerUrl: f.provider_url,
        sourcePath: f.source_path,
        sourceUpdatedAt: f.source_updated_at,
        sourceCreatedAt: f.source_created_at,
        snippet: scoreData?.snippet ?? null,
        similarity: scoreData?.similarity ?? null,
        score: scoreData?.score ?? 0,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results;
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
    userEmails?: string[];
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
    userEmails?: string[];
    after?: string;
    before?: string;
    limit: number;
  },
): Promise<HybridSearchResult[]> {
  // Caller is responsible for the empty-fileIds short-circuit; selectFrom().where("id", "in", [])
  // emits invalid `IN ()` SQL on SQLite.
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

  if ((opts.userEmails ?? []).length > 0) {
    const userEmails = opts.userEmails ?? [];
    q = q.where((eb) =>
      eb.or([
        eb.and([
          eb("indexed_files.access_scope_id", "is", null),
          eb.not(
            eb.exists(
              eb
                .selectFrom("file_access")
                .select("indexed_file_id")
                .whereRef("file_access.indexed_file_id", "=", "indexed_files.id"),
            ),
          ),
        ]),
        eb.exists(
          eb
            .selectFrom("access_scope_members")
            .select("access_scope_id")
            .whereRef("access_scope_members.access_scope_id", "=", "indexed_files.access_scope_id")
            .where("access_scope_members.email", "in", userEmails),
        ),
        eb.exists(
          eb
            .selectFrom("file_access")
            .select("indexed_file_id")
            .whereRef("file_access.indexed_file_id", "=", "indexed_files.id")
            .where("file_access.email", "in", userEmails),
        ),
      ]),
    );
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
    id: f.id,
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
    userEmails?: string[];
    entityId?: string;
    entityIds?: string[];
    entityIdsMode?: "and" | "or";
    sortBy?: "relevance" | "recency";
    /** Suppress search()'s own auto-entity-boost (caller will manage entityFileIds itself). */
    skipAutoEntityBoost?: boolean;
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
    // Empty-set short-circuit: avoid `IN ()` (invalid on SQLite) and skip the work.
    if (fileIds.length === 0) return [];
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
      userEmails: opts?.userEmails,
      after: opts?.after,
      before: opts?.before,
      limit,
    });
  }

  let queryEmbedding: number[] | undefined;
  try {
    const settings = await db
      .selectFrom("settings")
      .select(["gemini_api_key", "enrichment_enabled"])
      .where("id", "=", "default")
      .executeTakeFirst();
    if (settings?.gemini_api_key && settings.enrichment_enabled !== 0) {
      const embedQuery = createQueryEmbedder({ provider: "gemini", apiKey: settings.gemini_api_key });
      queryEmbedding = await embedQuery(trimmedQuery);
    }
  } catch {
    // Vector search is best-effort — fall back to FTS5 only
  }

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
    } catch {
      // Entity boost is best-effort
    }
  }

  // Recency: overfetch from the hybrid pipeline so the truly newest file isn't
  // dropped past `limit` by RRF, then sort in JS and trim.
  const fetchLimit = isRecency ? Math.max(limit * 5, 50) : limit;

  const results = await hybridSearch(db, trimmedQuery, {
    source: opts?.source,
    sources: opts?.sources,
    kindRules: opts?.kindRules,
    category: opts?.category,
    limit: fetchLimit,
    queryEmbedding,
    userEmails: opts?.userEmails,
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
