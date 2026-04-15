/**
 * Extend scheduled_tasks for unified automation model + create automation tracking tables.
 *
 * Every automation is a workflow (simple tasks are single-step workflows).
 * New columns on scheduled_tasks: title, description, steps (JSON), edges (JSON),
 * output_target, output_platform.
 *
 * New tables:
 * - automation_runs: per-execution tracking with step outputs
 * - automation_step_content: prompts/scripts stored separately from workflow structure
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Extend scheduled_tasks with workflow columns
  await db.schema.alterTable("scheduled_tasks").addColumn("title", "text").execute();
  await db.schema.alterTable("scheduled_tasks").addColumn("description", "text").execute();
  await db.schema.alterTable("scheduled_tasks").addColumn("steps", "text").execute();
  await db.schema.alterTable("scheduled_tasks").addColumn("edges", "text").execute();
  await db.schema.alterTable("scheduled_tasks").addColumn("output_target", "text").execute();
  await db.schema.alterTable("scheduled_tasks").addColumn("output_platform", "text").execute();

  // Automation runs — per-execution tracking with step outputs
  await db.schema
    .createTable("automation_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull())
    .addColumn("trigger_data", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("step_outputs", "text")
    .addColumn("error_message", "text")
    .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("completed_at", "text")
    .execute();

  await db.schema.createIndex("idx_automation_runs_task_id").on("automation_runs").columns(["task_id"]).execute();
  await db.schema.createIndex("idx_automation_runs_status").on("automation_runs").columns(["status"]).execute();

  // Step content — prompts and scripts stored separately from workflow structure
  await db.schema
    .createTable("automation_step_content")
    .addColumn("task_id", "text", (col) => col.notNull())
    .addColumn("step_id", "text", (col) => col.notNull())
    .addColumn("content_type", "text", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("apps", "text")
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_automation_step_content_pk")
    .on("automation_step_content")
    .columns(["task_id", "step_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("automation_step_content").execute();
  await db.schema.dropTable("automation_runs").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("output_platform").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("output_target").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("edges").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("steps").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("description").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("title").execute();
}
