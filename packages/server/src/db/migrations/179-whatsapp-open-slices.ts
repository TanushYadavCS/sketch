import { type Kysely, sql } from "kysely";

const OPEN_SLICE_INDEX = "conversation_slices_one_open_per_conversation_uidx";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE conversation_slices
    ADD COLUMN status TEXT NOT NULL DEFAULT 'closed'
    CHECK (status IN ('open', 'closed'))
  `.execute(db);
  await sql`
    UPDATE conversation_slices
    SET status = 'closed'
    WHERE status IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE conversation_slices
    ADD COLUMN facts_enriched_content_hash TEXT
  `.execute(db);
  await sql
    .raw(`
    CREATE UNIQUE INDEX ${OPEN_SLICE_INDEX}
    ON conversation_slices(conversation_id)
    WHERE status = 'open'
  `)
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP INDEX IF EXISTS ${OPEN_SLICE_INDEX}`).execute(db);
  await db.schema.alterTable("conversation_slices").dropColumn("facts_enriched_content_hash").execute();
  await db.schema.alterTable("conversation_slices").dropColumn("status").execute();
}
