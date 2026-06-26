import type { Kysely } from "kysely";
import { sql } from "kysely";
import { decrypt } from "../../auth/encryption";

const TABLE = "settings";

interface SettingsRow {
  id: string;
  gemini_api_key: string | null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (!columns.has("embedding_provider")) {
    await db.schema.alterTable(TABLE).addColumn("embedding_provider", "text").execute();
  }

  const rows = await sql<SettingsRow>`
    SELECT id, gemini_api_key
    FROM settings
    WHERE embedding_provider IS NULL
      AND gemini_api_key IS NOT NULL
  `.execute(db);

  for (const row of rows.rows) {
    if (!hasUsableGeminiKey(row.gemini_api_key)) continue;
    await sql`
      UPDATE settings
      SET embedding_provider = 'gemini'
      WHERE id = ${row.id}
        AND embedding_provider IS NULL
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumns(db);
  if (columns.has("embedding_provider")) {
    await db.schema.alterTable(TABLE).dropColumn("embedding_provider").execute();
  }
}

async function getColumns(db: Kysely<unknown>): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((candidate) => candidate.name === TABLE);
  return new Set(table?.columns.map((column) => column.name) ?? []);
}

function hasUsableGeminiKey(value: string | null): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith("enc:")) return true;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) return false;
  try {
    return decrypt(trimmed, encryptionKey).trim().length > 0;
  } catch {
    return false;
  }
}
