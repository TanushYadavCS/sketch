/**
 * Slice file content changed from roster-block-plus-transcript to
 * transcript-only. Emission's content-hash upsert only reaches kept slices
 * that are unlinked or inside the refresh window (7 days), so already-linked
 * older slices would keep their roster-polluted content forever. Clearing
 * indexed_file_id requeues every kept slice for re-emission: the emitter
 * re-renders clean content and upserts the SAME file row by provider_file_id
 * (the slice id), then relinks. Salience verdicts are untouched, so no LLM
 * re-judging happens. Covers both Slack and WhatsApp slices. Down is a no-op:
 * relinking is the emitter's job either way.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE conversation_slices
    SET indexed_file_id = NULL
    WHERE salience_verdict = 'kept'
      AND indexed_file_id IS NOT NULL
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
