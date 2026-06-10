import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_workspace_key", "text").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_workspace_dir", "text").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_active_queue_key", "text").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_conversation_id", "integer").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_provider_thread_id", "text").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_agent_instructions", "text").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_agent_allowed_tools", "text").execute();
  await db.schema.alterTable("local_claude_sessions").addColumn("origin_org_context_enabled", "integer").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_org_context_enabled").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_agent_allowed_tools").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_agent_instructions").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_provider_thread_id").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_conversation_id").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_active_queue_key").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_workspace_dir").execute();
  await db.schema.alterTable("local_claude_sessions").dropColumn("origin_workspace_key").execute();
}
