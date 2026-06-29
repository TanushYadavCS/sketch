import { type Kysely, sql } from "kysely";

type IndexedFilesTimestampDb = {
  indexed_files: {
    id: string;
    source_created_at: string | null;
    source_updated_at: string | null;
  };
};

type TimestampColumn = "source_created_at" | "source_updated_at";
type NormalizedTimestampRow = IndexedFilesTimestampDb["indexed_files"];

const UPDATE_BATCH_SIZE = 500;
const NAIVE_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

function normalizeExistingTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const naive = NAIVE_TIMESTAMP_PATTERN.exec(trimmed);
  const parsed = Date.parse(naive ? `${naive[1]}T${naive[2]}${naive[3] ?? ""}Z` : trimmed);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function timestampCase(column: TimestampColumn, rows: NormalizedTimestampRow[]) {
  const whens = rows.map((row) => sql`when ${sql.ref("id")} = ${row.id} then ${row[column]}`);
  return sql<string | null>`case ${sql.join(whens, sql` `)} else ${sql.ref(column)} end`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const typedDb = db as Kysely<IndexedFilesTimestampDb>;
  const rows = await typedDb
    .selectFrom("indexed_files")
    .select(["id", "source_created_at", "source_updated_at"])
    .execute();

  const changedRows = rows.flatMap((row) => {
    const normalized = {
      id: row.id,
      source_created_at: normalizeExistingTimestamp(row.source_created_at),
      source_updated_at: normalizeExistingTimestamp(row.source_updated_at),
    };
    return normalized.source_created_at === row.source_created_at &&
      normalized.source_updated_at === row.source_updated_at
      ? []
      : [normalized];
  });

  for (let i = 0; i < changedRows.length; i += UPDATE_BATCH_SIZE) {
    const batch = changedRows.slice(i, i + UPDATE_BATCH_SIZE);
    await typedDb
      .updateTable("indexed_files")
      .set({
        source_created_at: timestampCase("source_created_at", batch),
        source_updated_at: timestampCase("source_updated_at", batch),
      })
      .where(
        "id",
        "in",
        batch.map((row) => row.id),
      )
      .execute();
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
