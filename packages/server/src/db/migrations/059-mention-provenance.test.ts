import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../schema";
import * as migration from "./059-mention-provenance";

function createDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createMentionTable(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE entity_mentions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      indexed_file_id TEXT NOT NULL,
      chunk_index INTEGER,
      context_snippet TEXT,
      mentioned_at TEXT NOT NULL
    )
  `.execute(db);
}

async function insertLegacyMention(
  db: Kysely<DB>,
  row: {
    id: string;
    entityId: string;
    indexedFileId: string;
    contextSnippet?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO entity_mentions (id, entity_id, indexed_file_id, chunk_index, context_snippet, mentioned_at)
    VALUES (${row.id}, ${row.entityId}, ${row.indexedFileId}, NULL, ${row.contextSnippet ?? null}, '2026-01-01T00:00:00.000Z')
  `.execute(db);
}

describe("059-mention-provenance", () => {
  let db: Kysely<DB>;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs up, down, up on a fresh table", async () => {
    await createMentionTable(db);

    await migration.up(db);
    await migration.down(db);
    await migration.up(db);

    const columns = await sql<{ name: string }>`PRAGMA table_info(entity_mentions)`.execute(db);
    expect(columns.rows.map((c) => c.name)).toEqual(expect.arrayContaining(["confidence", "source", "relation"]));
  });

  it("backfills assignee snippets and keeps normal mentions unchanged", async () => {
    await createMentionTable(db);
    await insertLegacyMention(db, {
      id: "m-assigned",
      entityId: "e-1",
      indexedFileId: "f-1",
      contextSnippet: "Assigned to Beetu",
    });
    await insertLegacyMention(db, {
      id: "m-mentioned",
      entityId: "e-2",
      indexedFileId: "f-2",
      contextSnippet: "mentioned in transcript",
    });

    await migration.up(db);

    const rows = await db
      .selectFrom("entity_mentions")
      .select(["id", "confidence", "source", "relation"])
      .orderBy("id")
      .execute();

    expect(rows).toEqual([
      { id: "m-assigned", confidence: "INFERRED", source: "llm_extraction", relation: "assigned" },
      { id: "m-mentioned", confidence: "INFERRED", source: "llm_extraction", relation: "mentioned" },
    ]);
  });

  it("widens the old unique index to relation-aware uniqueness", async () => {
    await createMentionTable(db);
    await sql`
      CREATE UNIQUE INDEX idx_entity_mentions_entity_file_unique
      ON entity_mentions(entity_id, indexed_file_id)
    `.execute(db);

    await migration.up(db);

    await sql`
      INSERT INTO entity_mentions (
        id,
        entity_id,
        indexed_file_id,
        chunk_index,
        context_snippet,
        confidence,
        source,
        relation,
        mentioned_at
      )
      VALUES
        ('m-1', 'e-1', 'f-1', NULL, NULL, 'EXTRACTED', 'assignee', 'assigned', '2026-01-01T00:00:00.000Z'),
        ('m-2', 'e-1', 'f-1', NULL, NULL, 'EXTRACTED', 'fireflies_attendee', 'attended', '2026-01-01T00:00:00.000Z')
    `.execute(db);

    await expect(
      sql`
      INSERT INTO entity_mentions (
        id,
        entity_id,
        indexed_file_id,
        chunk_index,
        context_snippet,
        confidence,
        source,
        relation,
        mentioned_at
      )
      VALUES ('m-3', 'e-1', 'f-1', NULL, NULL, 'EXTRACTED', 'assignee', 'assigned', '2026-01-01T00:00:00.000Z')
    `.execute(db),
    ).rejects.toThrow();

    const indexes = await sql<{ name: string }>`PRAGMA index_list(entity_mentions)`.execute(db);
    expect(indexes.rows.map((i) => i.name)).toContain("uq_entity_mentions_entity_file_relation");
    expect(indexes.rows.map((i) => i.name)).not.toContain("idx_entity_mentions_entity_file_unique");
  });

  it("aborts when duplicate relation edges already exist", async () => {
    await createMentionTable(db);
    await insertLegacyMention(db, { id: "m-1", entityId: "e-1", indexedFileId: "f-1" });
    await insertLegacyMention(db, { id: "m-2", entityId: "e-1", indexedFileId: "f-1" });

    await expect(migration.up(db)).rejects.toThrow(
      "migration 059-mention-provenance: duplicate (entity_id, indexed_file_id, relation) rows found",
    );
  });
});
