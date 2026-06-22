import type { Kysely } from "kysely";

type IndexedFilesTimestampDb = {
  indexed_files: {
    id: string;
    source_created_at: string | null;
    source_updated_at: string | null;
  };
};

const NAIVE_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

function normalizeExistingTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const naive = NAIVE_TIMESTAMP_PATTERN.exec(trimmed);
  const parsed = Date.parse(naive ? `${naive[1]}T${naive[2]}${naive[3] ?? ""}Z` : trimmed);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const typedDb = db as Kysely<IndexedFilesTimestampDb>;
  const rows = await typedDb
    .selectFrom("indexed_files")
    .select(["id", "source_created_at", "source_updated_at"])
    .execute();

  for (const row of rows) {
    const sourceCreatedAt = normalizeExistingTimestamp(row.source_created_at);
    const sourceUpdatedAt = normalizeExistingTimestamp(row.source_updated_at);
    if (sourceCreatedAt === row.source_created_at && sourceUpdatedAt === row.source_updated_at) continue;

    await typedDb
      .updateTable("indexed_files")
      .set({
        source_created_at: sourceCreatedAt,
        source_updated_at: sourceUpdatedAt,
      })
      .where("id", "=", row.id)
      .execute();
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
