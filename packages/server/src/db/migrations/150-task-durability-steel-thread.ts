import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("tasks").addColumn("source_platform", "text").execute();
  await db.schema
    .alterTable("tasks")
    .addColumn("source_conversation_id", "integer", (col) => col.references("conversations.id").onDelete("set null"))
    .execute();
  await db.schema.alterTable("tasks").addColumn("source_provider_thread_id", "text").execute();
  await db.schema.alterTable("tasks").addColumn("source_anchor_key", "text").execute();
  await db.schema
    .alterTable("tasks")
    .addColumn("origin_agent_output_id", "text", (col) => col.references("agent_outputs.id").onDelete("set null"))
    .execute();

  await db.schema
    .createIndex("idx_tasks_conversation_anchor_status")
    .on("tasks")
    .columns(["source_platform", "source_conversation_id", "source_provider_thread_id", "status"])
    .execute();

  await db.schema
    .createTable("task_message_evidence")
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("conversation_message_id", "integer", (col) =>
      col.notNull().references("conversation_messages.id").onDelete("cascade"),
    )
    .addColumn("source_platform", "text", (col) => col.notNull())
    .addColumn("source_conversation_id", "integer", (col) =>
      col.notNull().references("conversations.id").onDelete("cascade"),
    )
    .addColumn("source_provider_thread_id", "text")
    .addColumn("source_anchor_key", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("task_message_evidence_pkey", ["task_id", "conversation_message_id"])
    .execute();

  await db.schema
    .createIndex("idx_task_message_evidence_anchor")
    .on("task_message_evidence")
    .columns(["source_anchor_key", "task_id"])
    .execute();
  await db.schema
    .createIndex("idx_task_message_evidence_message")
    .on("task_message_evidence")
    .column("conversation_message_id")
    .execute();

  await db.schema
    .createTable("task_completion_recommendations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("proposed_status", "text", (col) => col.notNull())
    .addColumn("review_state", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("review_code", "text", (col) => col.notNull())
    .addColumn("evidence_fingerprint", "text", (col) => col.notNull())
    .addColumn("origin_agent_output_id", "text", (col) => col.references("agent_outputs.id").onDelete("set null"))
    .addColumn("rationale", "text", (col) => col.notNull())
    .addColumn("delivery_count", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("reviewed_at", "text")
    .addColumn("reviewed_by_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .addColumn("review_surface", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("task_completion_recommendations_review_code_uidx")
    .on("task_completion_recommendations")
    .column("review_code")
    .unique()
    .execute();
  await db.schema
    .createIndex("task_completion_recommendations_fingerprint_uidx")
    .on("task_completion_recommendations")
    .columns(["task_id", "proposed_status", "evidence_fingerprint"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_task_completion_recommendations_task_state_expiry")
    .on("task_completion_recommendations")
    .columns(["task_id", "review_state", "expires_at"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX task_completion_recommendations_pending_task_uidx
      ON task_completion_recommendations (task_id)
     WHERE review_state = 'pending'
  `.execute(db);

  await db.schema
    .createTable("task_completion_recommendation_evidence")
    .addColumn("recommendation_id", "text", (col) =>
      col.notNull().references("task_completion_recommendations.id").onDelete("cascade"),
    )
    .addColumn("conversation_message_id", "integer", (col) =>
      col.notNull().references("conversation_messages.id").onDelete("cascade"),
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("task_completion_recommendation_evidence_pkey", [
      "recommendation_id",
      "conversation_message_id",
    ])
    .execute();

  await db.schema
    .createIndex("idx_task_completion_recommendation_evidence_message")
    .on("task_completion_recommendation_evidence")
    .column("conversation_message_id")
    .execute();

  await db.schema
    .createTable("task_completion_recommendation_deliveries")
    .addColumn("recommendation_id", "text", (col) =>
      col.notNull().references("task_completion_recommendations.id").onDelete("cascade"),
    )
    .addColumn("agent_output_delivery_id", "text", (col) =>
      col.notNull().references("agent_output_deliveries.id").onDelete("cascade"),
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("task_completion_recommendation_deliveries_uidx")
    .on("task_completion_recommendation_deliveries")
    .columns(["recommendation_id", "agent_output_delivery_id"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_task_completion_recommendation_deliveries_delivery")
    .on("task_completion_recommendation_deliveries")
    .column("agent_output_delivery_id")
    .execute();

  await db.schema
    .createTable("task_durability_route_state")
    .addColumn("agent_key", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("route_id", "text", (col) => col.notNull())
    .addColumn("source_key", "text", (col) => col.notNull())
    .addColumn("mode", "text", (col) => col.notNull().defaultTo("hybrid"))
    .addColumn("seed_state", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("seed_started_at", "text")
    .addColumn("seed_reviewed_at", "text")
    .addColumn("incremental_success_at", "text")
    .addColumn("last_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("task_durability_route_state_uidx")
    .on("task_durability_route_state")
    .columns(["agent_key", "user_id", "route_id"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_task_durability_route_state_source")
    .on("task_durability_route_state")
    .columns(["agent_key", "user_id", "source_key"])
    .execute();

  await db.schema
    .createTable("task_seed_candidates")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("agent_key", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("route_id", "text", (col) => col.notNull())
    .addColumn("source_key", "text", (col) => col.notNull())
    .addColumn("origin_agent_output_id", "text", (col) => col.references("agent_outputs.id").onDelete("set null"))
    .addColumn("origin_agent_output_item_id", "text", (col) =>
      col.references("agent_output_items.id").onDelete("set null"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("normalized_title", "text", (col) => col.notNull())
    .addColumn("proposed_assignee_name", "text")
    .addColumn("source_platform", "text", (col) => col.notNull())
    .addColumn("source_conversation_id", "integer", (col) =>
      col.notNull().references("conversations.id").onDelete("cascade"),
    )
    .addColumn("source_provider_thread_id", "text")
    .addColumn("source_anchor_key", "text", (col) => col.notNull())
    .addColumn("evidence_fingerprint", "text", (col) => col.notNull())
    .addColumn("review_code", "text", (col) => col.notNull())
    .addColumn("review_state", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("accepted_task_id", "text", (col) => col.references("tasks.id").onDelete("set null"))
    .addColumn("reviewed_at", "text")
    .addColumn("reviewed_by_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("task_seed_candidates_review_code_uidx")
    .on("task_seed_candidates")
    .column("review_code")
    .unique()
    .execute();
  await db.schema
    .createIndex("task_seed_candidates_fingerprint_uidx")
    .on("task_seed_candidates")
    .columns(["agent_key", "user_id", "route_id", "evidence_fingerprint"])
    .unique()
    .execute();
  await db.schema
    .createIndex("idx_task_seed_candidates_route_state")
    .on("task_seed_candidates")
    .columns(["agent_key", "user_id", "route_id", "review_state"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_seed_candidates").execute();
  await db.schema.dropTable("task_durability_route_state").execute();
  await db.schema.dropTable("task_completion_recommendation_deliveries").execute();
  await db.schema.dropTable("task_completion_recommendation_evidence").execute();
  await db.schema.dropTable("task_completion_recommendations").execute();
  await db.schema.dropTable("task_message_evidence").execute();
  await db.schema.dropIndex("idx_tasks_conversation_anchor_status").execute();
  await db.schema.alterTable("tasks").dropColumn("origin_agent_output_id").execute();
  await db.schema.alterTable("tasks").dropColumn("source_anchor_key").execute();
  await db.schema.alterTable("tasks").dropColumn("source_provider_thread_id").execute();
  await db.schema.alterTable("tasks").dropColumn("source_conversation_id").execute();
  await db.schema.alterTable("tasks").dropColumn("source_platform").execute();
}
