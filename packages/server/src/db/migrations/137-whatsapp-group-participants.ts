import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_group_participants")
    .addColumn("group_jid", "text", (col) => col.notNull().references("whatsapp_groups.jid").onDelete("cascade"))
    .addColumn("participant_jid", "text", (col) => col.notNull())
    .addColumn("phone_e164", "text")
    .addColumn("lid", "text")
    .addColumn("admin_role", "text")
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("whatsapp_group_participants_group_participant_uidx", ["group_jid", "participant_jid"])
    .addCheckConstraint(
      "whatsapp_group_participants_admin_role_check",
      sql`admin_role IS NULL OR admin_role IN ('admin', 'superadmin')`,
    )
    .execute();

  await db.schema
    .createIndex("idx_whatsapp_group_participants_group")
    .on("whatsapp_group_participants")
    .column("group_jid")
    .execute();
  await db.schema
    .createIndex("idx_whatsapp_group_participants_phone")
    .on("whatsapp_group_participants")
    .columns(["group_jid", "phone_e164"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_whatsapp_group_participants_phone").execute();
  await db.schema.dropIndex("idx_whatsapp_group_participants_group").execute();
  await db.schema.dropTable("whatsapp_group_participants").execute();
}
