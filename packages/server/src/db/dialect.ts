import { PostgresAdapter } from "kysely";
import type { Kysely } from "kysely";

// biome-ignore lint/suspicious/noExplicitAny: generic adapter check works for any DB schema
export function isPg(db: Kysely<any>): boolean {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}
