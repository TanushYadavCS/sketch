import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_identity_candidates")
    .addColumn("group_jid", "text", (col) => col.notNull().references("whatsapp_groups.jid").onDelete("cascade"))
    .addColumn("candidate_ref", "text", (col) => col.notNull())
    .addColumn("participant_jid_ref", "text", (col) => col.notNull())
    .addColumn("display_name", "text")
    .addColumn("kept_slice_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("first_seen_at", "text", (col) => col.notNull())
    .addColumn("last_seen_at", "text", (col) => col.notNull())
    .addColumn("last_slice_id", "text", (col) => col.notNull().references("conversation_slices.id").onDelete("cascade"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("whatsapp_identity_candidates_pk", ["group_jid", "candidate_ref"])
    .execute();

  await db.schema
    .createIndex("idx_whatsapp_identity_candidates_last_seen")
    .on("whatsapp_identity_candidates")
    .columns(["last_seen_at", "group_jid"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_whatsapp_identity_candidates_last_seen").execute();
  await db.schema.dropTable("whatsapp_identity_candidates").execute();
}
