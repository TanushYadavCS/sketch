import { type Kysely, sql } from "kysely";

const PENDING_SLICES_INDEX = "idx_conversation_slices_pending_salience";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex(PENDING_SLICES_INDEX)
    .on("conversation_slices")
    .column("salience_verdict")
    .where(sql.ref("salience_verdict"), "is", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(PENDING_SLICES_INDEX).ifExists().execute();
}
