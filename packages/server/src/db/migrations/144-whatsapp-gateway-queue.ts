import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`CREATE TABLE whatsapp_inbound_events (
      id serial PRIMARY KEY,
      kind text NOT NULL,
      origin text NOT NULL,
      event_key text,
      provider_message_id text,
      batch_id text,
      chunk_index integer,
      chunk_count integer,
      envelope text NOT NULL,
      received_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempts integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      claim_token text,
      claimed_at text,
      next_attempt_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at text,
      last_error text,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT whatsapp_inbound_events_kind_check
        CHECK (kind IN ('message', 'history_message', 'history_batch')),
      CONSTRAINT whatsapp_inbound_events_origin_check
        CHECK (origin IN ('gateway', 'inprocess')),
      CONSTRAINT whatsapp_inbound_events_status_check
        CHECK (status IN ('pending', 'processing', 'captured', 'consumed', 'dead'))
    )`.execute(db);
  } else {
    await db.schema
      .createTable("whatsapp_inbound_events")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("kind", "text", (col) => col.notNull())
      .addColumn("origin", "text", (col) => col.notNull())
      .addColumn("event_key", "text")
      .addColumn("provider_message_id", "text")
      .addColumn("batch_id", "text")
      .addColumn("chunk_index", "integer")
      .addColumn("chunk_count", "integer")
      .addColumn("envelope", "text", (col) => col.notNull())
      .addColumn("received_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
      .addColumn("claim_token", "text")
      .addColumn("claimed_at", "text")
      .addColumn("next_attempt_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("consumed_at", "text")
      .addColumn("last_error", "text")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addCheckConstraint(
        "whatsapp_inbound_events_kind_check",
        sql`kind IN ('message', 'history_message', 'history_batch')`,
      )
      .addCheckConstraint("whatsapp_inbound_events_origin_check", sql`origin IN ('gateway', 'inprocess')`)
      .addCheckConstraint(
        "whatsapp_inbound_events_status_check",
        sql`status IN ('pending', 'processing', 'captured', 'consumed', 'dead')`,
      )
      .execute();
  }

  await sql`CREATE UNIQUE INDEX whatsapp_inbound_events_event_key_uidx
    ON whatsapp_inbound_events(event_key) WHERE event_key IS NOT NULL`.execute(db);
  await sql`CREATE INDEX whatsapp_inbound_events_status_id_idx
    ON whatsapp_inbound_events(status, id)`.execute(db);
  await sql`CREATE INDEX whatsapp_inbound_events_provider_message_id_idx
    ON whatsapp_inbound_events(provider_message_id)`.execute(db);

  await db.schema
    .createTable("whatsapp_session_lease")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("owner_kind", "text", (col) => col.notNull())
    .addColumn("owner_token", "text", (col) => col.notNull())
    .addColumn("generation", "integer", (col) => col.notNull())
    .addColumn("gateway_http_token", "text")
    .addColumn("host_id", "text", (col) => col.notNull())
    .addColumn("boot_id", "text", (col) => col.notNull())
    .addColumn("pid", "integer", (col) => col.notNull())
    .addColumn("pid_start_time", "text", (col) => col.notNull())
    .addColumn("script_hash", "text", (col) => col.notNull())
    .addColumn("contract_version", "text", (col) => col.notNull())
    .addColumn("heartbeat_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("acquired_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_live_at", "text")
    .addColumn("disconnected_at", "text")
    .addCheckConstraint("whatsapp_session_lease_owner_kind_check", sql`owner_kind IN ('gateway', 'inprocess')`)
    .execute();

  await db.schema.alterTable("conversation_messages").addColumn("event_key", "text").execute();
  await sql`CREATE UNIQUE INDEX conversation_messages_event_key_uidx
    ON conversation_messages(event_key) WHERE event_key IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS conversation_messages_event_key_uidx`.execute(db);
  await db.schema.alterTable("conversation_messages").dropColumn("event_key").execute();
  await db.schema.dropTable("whatsapp_session_lease").execute();
  await db.schema.dropTable("whatsapp_inbound_events").execute();
}
