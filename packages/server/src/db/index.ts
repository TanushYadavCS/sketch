import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import pino from "pino";
import type { Config } from "../config";
import type { DB } from "./schema";

/** Embedding dimensions by provider. Used when creating vec0 virtual tables. */
export const EMBEDDING_DIMENSIONS = 3072;

/**
 * Whether sqlite-vec was successfully loaded on the last createDatabase() call.
 * Search falls back to FTS-only when false.
 */
export let sqliteVecAvailable = false;

export async function createDatabase(config: Config): Promise<Kysely<DB>> {
  if (config.DB_TYPE === "postgres") {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
    return new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });
  }

  const logger = pino({ level: "warn" });
  const Database = (await import("better-sqlite3")).default;
  mkdirSync(dirname(config.SQLITE_PATH), { recursive: true });
  const sqlite = new Database(config.SQLITE_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Load sqlite-vec extension for vector search. Treat as optional — the
  // extension may not be present in all environments. When unavailable, search
  // falls back to FTS-only and embedding operations are skipped.
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(sqlite);
    sqliteVecAvailable = true;

    // Create vec0 virtual tables. These live outside Kysely migrations because
    // they require the sqlite-vec extension to be loaded first. Drop and recreate
    // if dimensions changed.
    for (const table of ["chunk_embeddings", "file_embeddings"] as const) {
      const pk = table === "chunk_embeddings" ? "chunk_id" : "indexed_file_id";
      const existingDef = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
        | { sql: string }
        | undefined;

      if (existingDef) {
        // Check if dimensions match by inspecting the CREATE statement (e.g. "float[3072]")
        const dimMatch = existingDef.sql.match(/float\[(\d+)\]/);
        if (dimMatch && Number(dimMatch[1]) !== EMBEDDING_DIMENSIONS) {
          sqlite.exec(`DROP TABLE ${table}`);
          // Reset embedding status so enrichment re-runs with new dimensions
          sqlite.exec(
            `UPDATE indexed_files SET embedding_status = 'pending' WHERE embedding_status IN ('done', 'processing')`,
          );
        } else {
          continue; // Table exists with correct dimensions
        }
      }

      sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
          ${pk} TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIMENSIONS}]
        )
      `);
    }
  } catch (err) {
    sqliteVecAvailable = false;
    logger.warn({ err }, "sqlite-vec extension unavailable — vector search disabled, falling back to FTS-only");
  }

  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}
