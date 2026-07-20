/**
 * Slack group DMs (mpim) were captured with kind "channel" before capture
 * learned to record them under their own kind, which would put private group
 * DMs in scope for the channel indexing pipeline. Slack names every mpim
 * conversation "mpdm-<members>-<n>", so the display name is a reliable
 * discriminator for the backfill. Down is a no-op: reclassified rows are
 * correct under the new capture semantics.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE conversations
    SET kind = 'mpim'
    WHERE platform = 'slack'
      AND kind = 'channel'
      AND display_name LIKE 'mpdm-%'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
