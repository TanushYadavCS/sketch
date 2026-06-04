import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import { createScheduledTaskRepository } from "../repositories/scheduled-tasks";
import { up } from "./077-scheduled-task-output-thread";

describe("077-scheduled-task-output-thread migration", () => {
  let db: Kysely<{
    scheduled_tasks: {
      id: string;
      platform: string;
      context_type: string;
      delivery_target: string;
      thread_ts: string | null;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      timezone: string | null;
      session_mode: string | null;
      next_run_at: string | null;
      last_run_at: string | null;
      status: string | null;
      created_by: string | null;
      created_at: string | null;
      output_target: string | null;
      output_platform: string | null;
      output_mode: string | null;
      output_thread_ts?: string | null;
    };
  }>;

  beforeEach(async () => {
    db = new Kysely({ dialect: new SqliteDialect({ database: new SQLite(":memory:") }) });
    await db.schema
      .createTable("scheduled_tasks")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("platform", "text", (col) => col.notNull())
      .addColumn("context_type", "text", (col) => col.notNull())
      .addColumn("delivery_target", "text", (col) => col.notNull())
      .addColumn("thread_ts", "text")
      .addColumn("prompt", "text", (col) => col.notNull())
      .addColumn("schedule_type", "text", (col) => col.notNull())
      .addColumn("schedule_value", "text", (col) => col.notNull())
      .addColumn("timezone", "text")
      .addColumn("session_mode", "text")
      .addColumn("next_run_at", "text")
      .addColumn("last_run_at", "text")
      .addColumn("status", "text")
      .addColumn("created_by", "text")
      .addColumn("created_at", "text")
      .addColumn("output_target", "text")
      .addColumn("output_platform", "text")
      .addColumn("output_mode", "text")
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("backfills output_thread_ts only for rows that previously delivered to the source thread", async () => {
    await db
      .insertInto("scheduled_tasks")
      .values([
        {
          id: "thread-default",
          platform: "slack",
          context_type: "channel",
          delivery_target: "C1",
          thread_ts: "111.222",
          prompt: "A",
          schedule_type: "cron",
          schedule_value: "* * * * *",
        },
        {
          id: "thread-output-channel",
          platform: "slack",
          context_type: "channel",
          delivery_target: "C1",
          thread_ts: "111.222",
          output_target: "C2",
          prompt: "B",
          schedule_type: "cron",
          schedule_value: "* * * * *",
        },
        {
          id: "dm",
          platform: "slack",
          context_type: "dm",
          delivery_target: "D1",
          thread_ts: "111.222",
          prompt: "C",
          schedule_type: "cron",
          schedule_value: "* * * * *",
        },
      ])
      .execute();

    await up(db as Kysely<unknown>);

    const rows = await db
      .selectFrom("scheduled_tasks")
      .select(["id", "output_thread_ts"])
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { id: "dm", output_thread_ts: null },
      { id: "thread-default", output_thread_ts: "111.222" },
      { id: "thread-output-channel", output_thread_ts: null },
    ]);
  });

  it("keeps repository reads compatible after the new column exists", async () => {
    const db = await createTestDb();
    const repo = createScheduledTaskRepository(db);
    const task = await repo.add({
      id: "task-1",
      platform: "slack",
      context_type: "channel",
      delivery_target: "C1",
      thread_ts: "111.222",
      prompt: "A",
      schedule_type: "cron",
      schedule_value: "* * * * *",
      output_thread_ts: null,
    });
    expect(task.output_thread_ts).toBeNull();
    await db.destroy();
  });
});
