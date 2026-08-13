import type { Kysely } from "kysely";

const TABLE = "entity_review_queue";
const COLUMN = "pass_reason";

/**
 * Adds the column the reconcile and structural passes write.
 *
 * No status enum is added: `status` is plain text on both dialects, so the new
 * `deferred` value needs no schema change. What it does need is to stay OUT of
 * TERMINAL_STATUSES — a terminal row stops accruing evidence, which would freeze
 * the signal both passes re-read on every run.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(TABLE).addColumn(COLUMN, "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(TABLE).dropColumn(COLUMN).execute();
}
