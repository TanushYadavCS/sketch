import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("conversation_topics")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("conversation_id", "integer", (col) => col.notNull().references("conversations.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("one_liner", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("open"))
    .addColumn("last_activity_at", "text", (col) => col.notNull())
    .addColumn("canonical_topic_id", "text", (col) => col.references("conversation_topics.id").onDelete("set null"))
    .addCheckConstraint("conversation_topics_status_check", sql`status IN ('open', 'stale')`)
    .execute();

  await db.schema
    .createTable("slice_topics")
    .addColumn("slice_id", "text", (col) => col.notNull().references("conversation_slices.id").onDelete("cascade"))
    .addColumn("topic_id", "text", (col) => col.notNull().references("conversation_topics.id").onDelete("cascade"))
    .addPrimaryKeyConstraint("slice_topics_pk", ["slice_id", "topic_id"])
    .execute();

  await db.schema
    .createTable("topic_merges")
    .addColumn("merged_topic_id", "text", (col) =>
      col.primaryKey().references("conversation_topics.id").onDelete("restrict"),
    )
    .addColumn("canonical_topic_id", "text", (col) =>
      col.notNull().references("conversation_topics.id").onDelete("restrict"),
    )
    .addColumn("merged_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("reason", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("conversation_topics_conversation_activity_idx")
    .on("conversation_topics")
    .columns(["conversation_id", "last_activity_at"])
    .execute();
  await db.schema.createIndex("slice_topics_topic_idx").on("slice_topics").column("topic_id").execute();
  await db.schema.createIndex("topic_merges_merged_idx").on("topic_merges").column("merged_topic_id").execute();
  await db.schema.createIndex("topic_merges_canonical_idx").on("topic_merges").column("canonical_topic_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("topic_merges_canonical_idx").execute();
  await db.schema.dropIndex("topic_merges_merged_idx").execute();
  await db.schema.dropIndex("slice_topics_topic_idx").execute();
  await db.schema.dropIndex("conversation_topics_conversation_activity_idx").execute();
  await db.schema.dropTable("topic_merges").execute();
  await db.schema.dropTable("slice_topics").execute();
  await db.schema.dropTable("conversation_topics").execute();
}
