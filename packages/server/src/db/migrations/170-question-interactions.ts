import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("question_interactions")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("public_code", "text", (column) => column.notNull().unique())
    .addColumn("state", "text", (column) => column.notNull())
    .addColumn("platform", "text", (column) => column.notNull())
    .addColumn("conversation_kind", "text", (column) => column.notNull())
    .addColumn("conversation_id", "text", (column) => column.notNull())
    .addColumn("thread_id", "text")
    .addColumn("requester_principal_id", "text", (column) => column.notNull())
    .addColumn("eligible_responder_principal_ids_json", "text", (column) => column.notNull())
    .addColumn("session_id", "text", (column) => column.notNull())
    .addColumn("task_id", "text")
    .addColumn("agent_run_id", "text")
    .addColumn("resume_context_json", "text", (column) => column.notNull())
    .addColumn("expires_at", "text", (column) => column.notNull())
    .addColumn("answered_at", "text")
    .addColumn("cancelled_at", "text")
    .addColumn("expired_at", "text")
    .addColumn("delivery_ref", "text")
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();
  await db.schema
    .createIndex("question_interactions_state_expiry")
    .on("question_interactions")
    .columns(["state", "expires_at"])
    .execute();
  await db.schema
    .createIndex("question_interactions_target_state")
    .on("question_interactions")
    .columns(["platform", "conversation_id", "thread_id", "state"])
    .execute();
  await db.schema
    .createTable("question_interaction_items")
    .addColumn("interaction_id", "text", (column) => column.notNull())
    .addColumn("ordinal", "integer", (column) => column.notNull())
    .addColumn("question_id", "text", (column) => column.notNull())
    .addColumn("prompt", "text", (column) => column.notNull())
    .addColumn("options_json", "text", (column) => column.notNull())
    .addColumn("allows_custom_response", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("selected_option_id", "text")
    .addColumn("custom_response", "text")
    .addColumn("answered_by_principal_id", "text")
    .addColumn("answered_at", "text")
    .addPrimaryKeyConstraint("question_interaction_items_question", ["interaction_id", "question_id"])
    .addUniqueConstraint("question_interaction_items_ordinal", ["interaction_id", "ordinal"])
    .execute();
  await db.schema
    .createTable("question_interaction_events")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("interaction_id", "text", (column) => column.notNull())
    .addColumn("event_type", "text", (column) => column.notNull())
    .addColumn("inbound_event_id", "text")
    .addColumn("event_key", "text", (column) => column.notNull())
    .addColumn("actor_principal_id", "text", (column) => column.notNull())
    .addColumn("payload_json", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addUniqueConstraint("question_interaction_events_event", ["interaction_id", "event_key"])
    .execute();
  await db.schema
    .createTable("question_interaction_deliveries")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("interaction_id", "text", (column) => column.notNull())
    .addColumn("attempt", "integer", (column) => column.notNull())
    .addColumn("transport", "text", (column) => column.notNull())
    .addColumn("capability", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("provider_message_ref", "text")
    .addColumn("request_key", "text", (column) => column.notNull().unique())
    .addColumn("error_code", "text")
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo("CURRENT_TIMESTAMP"))
    .execute();
  await db.schema
    .createIndex("question_interaction_deliveries_attempt")
    .on("question_interaction_deliveries")
    .columns(["interaction_id", "attempt"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("question_interaction_deliveries").ifExists().execute();
  await db.schema.dropTable("question_interaction_events").ifExists().execute();
  await db.schema.dropTable("question_interaction_items").ifExists().execute();
  await db.schema.dropTable("question_interactions").ifExists().execute();
}
