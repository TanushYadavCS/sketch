import { type Kysely, sql } from "kysely";

const MANIFEST_GROUP_INDEX = "chunk_conversion_manifest_group_idx";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE whatsapp_groups
    ADD COLUMN chunker_mode TEXT NOT NULL DEFAULT 'deterministic'
    CHECK (chunker_mode IN ('deterministic', 'converting', 'llm_backfill', 'llm_live'))
  `.execute(db);
  await db.schema.alterTable("whatsapp_groups").addColumn("chunker_conversion_claim", "text").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunker_conversion_claimed_at", "text").execute();

  await db.schema
    .createTable("chunk_conversion_manifest")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("group_jid", "text", (col) => col.notNull().references("whatsapp_groups.jid").onDelete("cascade"))
    .addColumn("artifact_type", "text", (col) => col.notNull())
    .addColumn("artifact_id", "text", (col) => col.notNull())
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("payload", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("restored_at", "text")
    .execute();
  await db.schema.createIndex(MANIFEST_GROUP_INDEX).on("chunk_conversion_manifest").column("group_jid").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(MANIFEST_GROUP_INDEX).execute();
  await db.schema.dropTable("chunk_conversion_manifest").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunker_conversion_claimed_at").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunker_conversion_claim").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunker_mode").execute();
}
