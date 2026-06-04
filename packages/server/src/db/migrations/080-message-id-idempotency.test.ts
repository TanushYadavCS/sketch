import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./080-message-id-idempotency";

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createPrerequisites(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("connector_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .execute();

  await db.schema
    .createTable("indexed_files")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) => col.notNull())
    .addColumn("provider_file_id", "text", (col) => col.notNull())
    .addColumn("file_name", "text", (col) => col.notNull())
    .addColumn("content_category", "text", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("synced_at", "text", (col) => col.notNull())
    .execute();

  await sql`CREATE UNIQUE INDEX idx_indexed_files_source_provider ON indexed_files(source, provider_file_id)`.execute(
    db,
  );
}

async function insertFile(
  db: Kysely<unknown>,
  params: {
    id: string;
    connectorConfigId: string;
    source: string;
    providerFileId: string;
    providerMessageId?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO indexed_files (
      id,
      connector_config_id,
      provider_file_id,
      provider_message_id,
      file_name,
      content_category,
      source,
      synced_at
    )
    VALUES (
      ${params.id},
      ${params.connectorConfigId},
      ${params.providerFileId},
      ${params.providerMessageId ?? null},
      ${`${params.id}.txt`},
      'document',
      ${params.source},
      '2026-06-02T00:00:00.000Z'
    )
  `.execute(db);
}

describe("080-message-id-idempotency migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createPrerequisites(db);
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("scopes provider_message_id uniqueness to connector_config_id", async () => {
    await insertFile(db, {
      id: "gmail-a",
      connectorConfigId: "connector-a",
      source: "gmail",
      providerFileId: "gmail-provider-a",
      providerMessageId: "<m1@example.com>",
    });
    await insertFile(db, {
      id: "gmail-b",
      connectorConfigId: "connector-b",
      source: "gmail",
      providerFileId: "gmail-provider-b",
      providerMessageId: "<m1@example.com>",
    });

    await expect(
      insertFile(db, {
        id: "gmail-duplicate",
        connectorConfigId: "connector-a",
        source: "gmail",
        providerFileId: "gmail-provider-c",
        providerMessageId: "<m1@example.com>",
      }),
    ).rejects.toThrow();
  });

  it("keeps legacy source/provider-file uniqueness only for null message-id rows", async () => {
    await insertFile(db, {
      id: "gmail-a",
      connectorConfigId: "connector-a",
      source: "gmail",
      providerFileId: "same-provider-id",
      providerMessageId: "<m1@example.com>",
    });
    await insertFile(db, {
      id: "gmail-b",
      connectorConfigId: "connector-b",
      source: "gmail",
      providerFileId: "same-provider-id",
      providerMessageId: "<m2@example.com>",
    });

    await insertFile(db, {
      id: "notion-a",
      connectorConfigId: "connector-a",
      source: "notion",
      providerFileId: "same-page-id",
      providerMessageId: null,
    });

    await expect(
      insertFile(db, {
        id: "notion-b",
        connectorConfigId: "connector-b",
        source: "notion",
        providerFileId: "same-page-id",
        providerMessageId: null,
      }),
    ).rejects.toThrow();

    await insertFile(db, {
      id: "notion-c",
      connectorConfigId: "connector-c",
      source: "notion",
      providerFileId: "different-page-id",
      providerMessageId: null,
    });
  });

  it("down reverses the migration before comms rows exist", async () => {
    const cleanDb = createBlankDb();
    try {
      await createPrerequisites(cleanDb);
      await up(cleanDb);
      await down(cleanDb);

      const columns = await sql<{ name: string }>`PRAGMA table_info(indexed_files)`.execute(cleanDb);
      expect(columns.rows.map((row) => row.name)).not.toContain("provider_message_id");
      expect(columns.rows.map((row) => row.name)).not.toContain("thread_id");
    } finally {
      await cleanDb.destroy();
    }
  });
});
