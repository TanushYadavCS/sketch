import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tasks")
    .addColumn("revision", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable("task_field_protections")
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("protected_by_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .addColumn("activity_event_id", "text", (col) => col.references("task_activity_events.id").onDelete("set null"))
    .addColumn("protected_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("task_field_protections_pkey", ["task_id", "field"])
    .addCheckConstraint("task_field_protections_field_check", sql`field in ('status', 'title', 'priority', 'due_at')`)
    .execute();
  await db.schema
    .createIndex("idx_task_field_protections_field_time")
    .on("task_field_protections")
    .columns(["field", "protected_at", "task_id"])
    .execute();

  await sql`
    insert into task_field_protections (
      task_id,
      field,
      protected_by_user_id,
      activity_event_id,
      protected_at
    )
    select
      event.task_id,
      'status',
      event.actor_user_id,
      event.id,
      event.occurred_at
    from task_activity_events as event
    inner join tasks on tasks.id = event.task_id
    where event.actor_type = 'user'
      and event.event_kind = 'status_changed'
      and not exists (
        select 1
        from task_activity_events as newer
        where newer.task_id = event.task_id
          and newer.actor_type = 'user'
          and newer.event_kind = 'status_changed'
          and (
            newer.occurred_at > event.occurred_at
            or (newer.occurred_at = event.occurred_at and newer.id > event.id)
          )
      )
    on conflict (task_id, field) do nothing
  `.execute(db);

  await db.schema
    .createTable("task_change_proposals")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("logical_fingerprint", "text", (col) => col.notNull())
    .addColumn("dedupe_key", "text", (col) => col.notNull().unique())
    .addColumn("supersedes_proposal_id", "text", (col) =>
      col.references("task_change_proposals.id").onDelete("set null"),
    )
    .addColumn("reviewed_at", "text")
    .addColumn("reviewed_by_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .addColumn("review_surface", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addCheckConstraint(
      "task_change_proposals_state_check",
      sql`state in ('pending', 'accepted', 'rejected', 'superseded')`,
    )
    .execute();
  await db.schema
    .createIndex("idx_task_change_proposals_state_time")
    .on("task_change_proposals")
    .columns(["state", "created_at", "task_id"])
    .execute();
  await db.schema
    .createIndex("idx_task_change_proposals_fingerprint")
    .on("task_change_proposals")
    .columns(["task_id", "logical_fingerprint", "state"])
    .execute();
  await db.schema
    .createIndex("idx_task_change_proposals_supersedes")
    .unique()
    .on("task_change_proposals")
    .column("supersedes_proposal_id")
    .execute();
  await sql`
    create unique index idx_task_change_proposals_one_pending
    on task_change_proposals(task_id)
    where state = 'pending'
  `.execute(db);

  await db.schema
    .createTable("task_change_proposal_fields")
    .addColumn("proposal_id", "text", (col) => col.notNull().references("task_change_proposals.id").onDelete("cascade"))
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("observed_revision", "integer", (col) => col.notNull())
    .addColumn("base_value_json", "text", (col) => col.notNull())
    .addColumn("proposed_value_json", "text", (col) => col.notNull())
    .addColumn("rationale", "text", (col) => col.notNull())
    .addColumn("source_occurred_at", "text", (col) => col.notNull())
    .addColumn("origin_agent_output_id", "text", (col) => col.references("agent_outputs.id").onDelete("set null"))
    .addPrimaryKeyConstraint("task_change_proposal_fields_pkey", ["proposal_id", "field"])
    .addCheckConstraint("task_change_proposal_fields_field_check", sql`field in ('title', 'priority', 'due_at')`)
    .execute();

  await db.schema
    .createTable("task_change_proposal_evidence")
    .addColumn("proposal_id", "text", (col) => col.notNull())
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("ref_id", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("task_change_proposal_evidence_pkey", ["proposal_id", "field", "kind", "ref_id"])
    .addForeignKeyConstraint(
      "task_change_proposal_evidence_field_fkey",
      ["proposal_id", "field"],
      "task_change_proposal_fields",
      ["proposal_id", "field"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint(
      "task_change_proposal_evidence_kind_check",
      sql`kind in ('conversation_message', 'file', 'entity', 'fact', 'mention')`,
    )
    .execute();
  await db.schema
    .createIndex("idx_task_change_proposal_evidence_ref")
    .on("task_change_proposal_evidence")
    .columns(["kind", "ref_id", "proposal_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const state = await sql<{
    protection_count: number | string;
    proposal_count: number | string;
    revision_count: number | string;
  }>`
    select
      (select count(*) from task_field_protections) as protection_count,
      (select count(*) from task_change_proposals) as proposal_count,
      (select count(*) from tasks where revision <> 0) as revision_count
  `.execute(db);
  const counts = state.rows[0];
  if (
    Number(counts?.protection_count ?? 0) > 0 ||
    Number(counts?.proposal_count ?? 0) > 0 ||
    Number(counts?.revision_count ?? 0) > 0
  ) {
    throw new Error("Cannot remove task human-authority schema after authority or proposal state exists.");
  }

  await db.schema.dropTable("task_change_proposal_evidence").execute();
  await db.schema.dropTable("task_change_proposal_fields").execute();
  await db.schema.dropTable("task_change_proposals").execute();
  await db.schema.dropTable("task_field_protections").execute();
  await db.schema.alterTable("tasks").dropColumn("revision").execute();
}
