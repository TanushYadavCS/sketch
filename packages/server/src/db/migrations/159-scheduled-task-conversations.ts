import { type Kysely, sql } from "kysely";

const TABLE = "scheduled_task_conversations";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(TABLE)
    .addColumn("task_id", "text", (col) => col.notNull())
    .addColumn("conversation_id", "text", (col) => col.notNull())
    .addColumn("transcript_user_id", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("builder"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_active_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("archived_at", "text")
    .addPrimaryKeyConstraint("scheduled_task_conversations_pkey", [
      "task_id",
      "conversation_id",
      "transcript_user_id",
      "kind",
    ])
    .execute();

  await db.schema
    .createIndex("idx_scheduled_task_conversations_task_user_active")
    .on(TABLE)
    .columns(["task_id", "transcript_user_id", "archived_at", "last_active_at"])
    .execute();

  await db.schema
    .createIndex("idx_scheduled_task_conversations_conversation_user")
    .on(TABLE)
    .columns(["conversation_id", "transcript_user_id", "task_id"])
    .execute();

  await sql`
    INSERT INTO scheduled_task_conversations (
      task_id,
      conversation_id,
      transcript_user_id,
      kind,
      created_at,
      updated_at,
      last_active_at
    )
    SELECT
      id,
      origin_conversation_id,
      created_by,
      'web_chat',
      created_at,
      updated_at,
      updated_at
    FROM scheduled_tasks
    WHERE origin_platform = 'web'
      AND origin_conversation_id IS NOT NULL
      AND created_by IS NOT NULL
    ON CONFLICT (task_id, conversation_id, transcript_user_id, kind) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_scheduled_task_conversations_conversation_user`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_scheduled_task_conversations_task_user_active`.execute(db);
  await db.schema.dropTable(TABLE).execute();
}
