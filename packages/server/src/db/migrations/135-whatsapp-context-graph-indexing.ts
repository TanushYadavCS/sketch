import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("conversation_slices")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "integer", (col) => col.notNull().references("conversations.id").onDelete("cascade"))
    .addColumn("first_message_id", "integer", (col) => col.notNull())
    .addColumn("last_message_id", "integer", (col) => col.notNull())
    .addColumn("started_at", "text", (col) => col.notNull())
    .addColumn("ended_at", "text", (col) => col.notNull())
    .addColumn("message_count", "integer", (col) => col.notNull())
    .addColumn("flush_reason", "text", (col) => col.notNull())
    .addColumn("roster_snapshot", "text", (col) => col.notNull())
    .addColumn("salience_verdict", "text")
    .addColumn("salience_signals", "text")
    .addColumn("salience_claim_token", "text")
    .addColumn("salience_claimed_at", "text")
    .addColumn("indexed_file_id", "text", (col) => col.references("indexed_files.id").onDelete("set null"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("conversation_slices_conversation_first_uidx", ["conversation_id", "first_message_id"])
    .addCheckConstraint("conversation_slices_flush_reason_check", sql`flush_reason IN ('gap', 'max_age', 'max_size')`)
    .addCheckConstraint(
      "conversation_slices_salience_verdict_check",
      sql`salience_verdict IS NULL OR salience_verdict IN ('kept', 'dropped')`,
    )
    .execute();

  await db.schema
    .createIndex("idx_conversation_slices_conversation_time")
    .on("conversation_slices")
    .columns(["conversation_id", "started_at", "first_message_id"])
    .execute();
  await db.schema
    .createIndex("idx_conversation_slices_indexed_file")
    .on("conversation_slices")
    .column("indexed_file_id")
    .execute();

  await db.schema
    .createTable("conversation_slice_cursors")
    .addColumn("conversation_id", "integer", (col) =>
      col.primaryKey().references("conversations.id").onDelete("cascade"),
    )
    .addColumn("last_effective_at", "text")
    .addColumn("last_message_id", "integer")
    .addColumn("claim_token", "text")
    .addColumn("claimed_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("whatsapp_group_member_labels")
    .addColumn("group_jid", "text", (col) => col.notNull())
    .addColumn("phone_e164", "text", (col) => col.notNull())
    .addColumn("display_name", "text", (col) => col.notNull())
    .addColumn("company_name", "text")
    .addColumn("created_by", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("whatsapp_group_member_labels_pk", ["group_jid", "phone_e164"])
    .execute();

  await db.schema
    .createTable("whatsapp_backfill_checkpoints")
    .addColumn("group_jid", "text", (col) => col.primaryKey())
    .addColumn("last_fetched_key", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addCheckConstraint(
      "whatsapp_backfill_checkpoints_status_check",
      sql`status IN ('in_progress', 'complete', 'failed')`,
    )
    .execute();

  await db.schema
    .alterTable("whatsapp_groups")
    .addColumn("index_enabled", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("slice_gap_minutes", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("slice_max_age_minutes", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("slice_max_messages", "integer").execute();
  await db.schema
    .createIndex("idx_whatsapp_groups_index_enabled")
    .on("whatsapp_groups")
    .column("index_enabled")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_whatsapp_groups_index_enabled").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("slice_max_messages").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("slice_max_age_minutes").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("slice_gap_minutes").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("index_enabled").execute();
  await db.schema.dropTable("whatsapp_backfill_checkpoints").execute();
  await db.schema.dropTable("whatsapp_group_member_labels").execute();
  await db.schema.dropTable("conversation_slice_cursors").execute();
  await db.schema.dropTable("conversation_slices").execute();
}
