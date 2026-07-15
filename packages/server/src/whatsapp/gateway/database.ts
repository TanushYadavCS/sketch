import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import type { Config } from "../../config";
import type { DB } from "../../db/schema";

/** Opens the gateway's independent, low-concurrency database handle. */
export async function createWhatsAppGatewayDatabase(config: Config): Promise<Kysely<DB>> {
  if (config.DB_TYPE === "postgres") {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 2,
      ssl: { rejectUnauthorized: false },
    });
    return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }

  const Database = (await import("better-sqlite3")).default;
  mkdirSync(dirname(config.SQLITE_PATH), { recursive: true });
  const sqlite = new Database(config.SQLITE_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 1000");
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
}
