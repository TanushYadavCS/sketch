/**
 * Slice file content changed from roster-block-plus-transcript to
 * transcript-only. Emission's content-hash upsert only reaches kept slices
 * that are unlinked or inside the refresh window (7 days), so already-linked
 * older slices would keep their roster-polluted content forever. Clearing
 * indexed_file_id requeues kept slices for re-emission: the emitter
 * re-renders clean content and upserts the SAME file row by provider_file_id
 * (the slice id), then relinks. Salience verdicts are untouched, so no LLM
 * re-judging happens.
 *
 * Scope is limited to slices an emitter will actually process — Slack
 * channel conversations and WhatsApp groups with indexing enabled. Slices of
 * index-disabled groups keep their link: emission never selects them, so
 * unlinking would strand both the link and the retained file. Their requeue
 * happens at enable time instead (setIndexEnabled/applyIndexSelection
 * clear kept-slice links when a group turns on). Down is a no-op: relinking
 * is the emitter's job either way.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE conversation_slices
    SET indexed_file_id = NULL
    WHERE salience_verdict = 'kept'
      AND indexed_file_id IS NOT NULL
      AND conversation_id IN (
        SELECT c.id FROM conversations c
        WHERE (c.platform = 'slack' AND c.kind = 'channel')
           OR (
             c.platform = 'whatsapp' AND c.kind = 'group'
             AND EXISTS (
               SELECT 1 FROM whatsapp_groups g
               WHERE g.jid = c.provider_conversation_id AND g.index_enabled = 1
             )
           )
      )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
