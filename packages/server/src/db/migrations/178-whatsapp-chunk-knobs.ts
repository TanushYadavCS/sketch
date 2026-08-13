import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_window_messages", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_window_tokens", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_min_messages", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_target_messages", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_max_messages", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_max_tokens", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_tick_minutes", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_idle_close_hours", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_provisional_refresh_messages", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_model", "text").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_reasoning_effort", "text").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_burst_threshold_messages", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_topic_registry_cap", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_group_worker_pool", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("chunk_last_llm_attempt_at", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_last_llm_attempt_at").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_group_worker_pool").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_topic_registry_cap").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_burst_threshold_messages").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_reasoning_effort").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_model").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_provisional_refresh_messages").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_idle_close_hours").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_tick_minutes").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_max_tokens").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_max_messages").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_target_messages").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_min_messages").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_window_tokens").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("chunk_window_messages").execute();
}
