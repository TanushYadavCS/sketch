/**
 * Slack group DMs (mpim) were captured with kind "channel" before capture
 * learned to record them under their own kind, which would put private group
 * DMs in scope for the channel indexing pipeline. Slack names every mpim
 * conversation "mpdm-<members>-<n>", so the name is a reliable discriminator
 * for the backfill. The channels rows need the same repair: getChannelInfo
 * used to store mpims as type "group", and the mention capture path derives
 * the conversation kind from that stored type, so a stale row would recreate
 * a kind "channel" conversation on the next mention. Down is a no-op:
 * reclassified rows are correct under the new capture semantics.
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

  await sql`
    UPDATE channels
    SET type = 'mpim'
    WHERE type IN ('group', 'private_channel', 'public_channel')
      AND name LIKE 'mpdm-%'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
