import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_window_keepalives")
    .addColumn("recipient_user_id", "text", (col) => col.primaryKey().references("users.id").onDelete("cascade"))
    .addColumn("sent_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("whatsapp_window_keepalives").execute();
}
