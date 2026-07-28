/**
 * Repository for the scheduled_tasks table.
 *
 * All operations use Kysely query builder. The add() method generates a UUID for the
 * new task so the caller receives a stable ID immediately (useful for croner instance
 * management). update() returns the updated row or undefined if the ID was not found,
 * allowing callers to distinguish "no such task" from a no-op update.
 *
 * UpdatableFields covers only the columns that make sense to change post-creation.
 * Delivery target, platform, context type, created_by, and origin chat are fixed
 * at creation time.
 */
import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { DB, ScheduledTasksTable } from "../schema";

export type ScheduledTaskRow = Selectable<ScheduledTasksTable>;

export type NewScheduledTask = Omit<Insertable<ScheduledTasksTable>, "id"> & { id?: string };

export interface UpdatableFields {
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  timezone: string;
  session_mode: string;
  next_run_at: string | null;
  title: string | null;
  description: string | null;
  steps: string | null;
  edges: string | null;
  output_target: string | null;
  output_platform: string | null;
  output_thread_ts: string | null;
  output_mode: string;
  last_edited_by: string | null;
}

export function createScheduledTaskRepository(db: Kysely<DB>) {
  return {
    async add(task: NewScheduledTask): Promise<ScheduledTaskRow> {
      const id = task.id ?? randomUUID();
      await db
        .insertInto("scheduled_tasks")
        .values({ ...task, id })
        .execute();
      return db.selectFrom("scheduled_tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async getById(id: string): Promise<ScheduledTaskRow | undefined> {
      return db.selectFrom("scheduled_tasks").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async listAll(): Promise<ScheduledTaskRow[]> {
      return db.selectFrom("scheduled_tasks").selectAll().orderBy("created_at", "desc").execute();
    },

    async listByDeliveryTarget(deliveryTarget: string): Promise<ScheduledTaskRow[]> {
      return db
        .selectFrom("scheduled_tasks")
        .selectAll()
        .where("delivery_target", "=", deliveryTarget)
        .orderBy("created_at", "asc")
        .execute();
    },

    async listByCreatedBy(createdBy: string): Promise<ScheduledTaskRow[]> {
      return db
        .selectFrom("scheduled_tasks")
        .selectAll()
        .where("created_by", "=", createdBy)
        .orderBy("created_at", "asc")
        .execute();
    },

    async listActive(): Promise<ScheduledTaskRow[]> {
      return db
        .selectFrom("scheduled_tasks")
        .selectAll()
        .where("status", "=", "active")
        .orderBy("created_at", "asc")
        .execute();
    },

    async listActiveSlackChannelMessageTriggers(): Promise<ScheduledTaskRow[]> {
      return db
        .selectFrom("scheduled_tasks")
        .selectAll()
        .where("status", "=", "active")
        .where("schedule_type", "=", "external")
        .where("schedule_value", "=", "slack_channel_message")
        .orderBy("created_at", "asc")
        .execute();
    },

    async countActiveForUserWithin(userId: string, startAt: string, endAt: string): Promise<number> {
      const row = await db
        .selectFrom("scheduled_tasks")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("created_by", "=", userId)
        .where("status", "=", "active")
        .where("next_run_at", "is not", null)
        .where("next_run_at", ">=", startAt)
        .where("next_run_at", "<=", endAt)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async update(
      id: string,
      fields: Partial<UpdatableFields>,
      options: { incrementRevision?: boolean } = {},
    ): Promise<ScheduledTaskRow | undefined> {
      const existing = await db.selectFrom("scheduled_tasks").select("id").where("id", "=", id).executeTakeFirst();
      if (!existing) return undefined;

      if (Object.keys(fields).length > 0 || options.incrementRevision) {
        const updateFields = options.incrementRevision
          ? { ...fields, updated_at: sql<string>`CURRENT_TIMESTAMP`, revision: sql<number>`revision + 1` }
          : { ...fields, updated_at: sql<string>`CURRENT_TIMESTAMP` };
        await db.updateTable("scheduled_tasks").set(updateFields).where("id", "=", id).execute();
      }

      return db.selectFrom("scheduled_tasks").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async updateRunTimestamps(id: string, lastRunAt: string, nextRunAt: string | null): Promise<void> {
      await db
        .updateTable("scheduled_tasks")
        .set({ last_run_at: lastRunAt, next_run_at: nextRunAt })
        .where("id", "=", id)
        .execute();
    },

    async updateStatus(
      id: string,
      status: "active" | "paused" | "completed",
      options: { incrementRevision?: boolean } = {},
    ): Promise<void> {
      const fields = options.incrementRevision
        ? { status, updated_at: sql<string>`CURRENT_TIMESTAMP`, revision: sql<number>`revision + 1` }
        : { status, updated_at: sql<string>`CURRENT_TIMESTAMP` };
      await db.updateTable("scheduled_tasks").set(fields).where("id", "=", id).execute();
    },

    async remove(id: string): Promise<boolean> {
      const result = await db.deleteFrom("scheduled_tasks").where("id", "=", id).executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    },
  };
}
