import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("conversation_slices").addColumn("denoised_message_ids", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("conversation_slices").dropColumn("denoised_message_ids").execute();
}
