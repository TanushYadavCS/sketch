import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB, TaskActivitySurface, TaskProtectedField, TasksTable } from "../schema";
import { createTaskActivityRepository } from "./task-activity";
import type { TaskStatus } from "./tasks";

export interface HumanTaskChanges {
  title?: string;
  priority?: "high" | "medium" | "low" | null;
  dueAt?: string | null;
  status?: TaskStatus;
}

export interface HumanTaskMutationInput {
  taskId: string;
  userId: string;
  assigneeEntityIds?: string[];
  canEditAllLocalTasks?: boolean;
  expectedRevision?: number;
  changes: HumanTaskChanges;
  surface: TaskActivitySurface;
  mutationId?: string;
  now?: string;
}

export type HumanTaskMutationResult =
  | { status: "unchanged"; task: Selectable<TasksTable> }
  | { status: "applied"; task: Selectable<TasksTable> }
  | { status: "conflict"; task: Selectable<TasksTable> }
  | { status: "not_editable" };

export function createLocalTaskMutationPolicy(db: Kysely<DB>) {
  return {
    mutateHumanTask(input: HumanTaskMutationInput): Promise<HumanTaskMutationResult> {
      return db.transaction().execute((trx) => mutateHumanTaskInTransaction(trx, input));
    },
  };
}

export async function mutateHumanTaskInTransaction(
  trx: Transaction<DB>,
  input: HumanTaskMutationInput,
): Promise<HumanTaskMutationResult> {
  const existing = await trx
    .selectFrom("tasks")
    .selectAll()
    .where("id", "=", input.taskId)
    .where("valid_to", "is", null)
    .executeTakeFirst();
  if (!existing || !canHumanEditLocalTask(existing, input)) return { status: "not_editable" };

  const changes = logicalChanges(existing, input.changes);
  if (Object.keys(changes).length === 0) return { status: "unchanged", task: existing };
  if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    return { status: "conflict", task: existing };
  }

  const now = mutationTime(existing, input.now);
  const values = taskUpdateValues(existing, input.changes, now);
  let update = trx
    .updateTable("tasks")
    .set({
      ...values,
      revision: sql<number>`revision + 1`,
      updated_at: now,
    })
    .where("id", "=", input.taskId)
    .where("valid_to", "is", null)
    .where("revision", "=", existing.revision)
    .where("status_authority", "=", "local")
    .where("provenance", "in", ["brief", "summary"]);
  if (input.canEditAllLocalTasks !== true) {
    const assigneeEntityIds = [...new Set(input.assigneeEntityIds ?? [])].filter(Boolean);
    update = update.where((eb) =>
      eb.or([
        eb("created_by_user_id", "=", input.userId),
        ...(assigneeEntityIds.length > 0 ? [eb("assignee_entity_id", "in", assigneeEntityIds)] : []),
      ]),
    );
  }
  const updated = await update.executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) === 0) {
    const current = await trx
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", input.taskId)
      .where("valid_to", "is", null)
      .executeTakeFirst();
    if (!current || !canHumanEditLocalTask(current, input)) return { status: "not_editable" };
    if (Object.keys(logicalChanges(current, input.changes)).length === 0) {
      return { status: "unchanged", task: current };
    }
    return { status: "conflict", task: current };
  }

  const eventKind = Object.keys(changes).length === 1 && changes.status ? "status_changed" : "fields_changed";
  const activity = await createTaskActivityRepository(trx).append({
    taskId: existing.id,
    eventKind,
    actorType: "user",
    actorUserId: input.userId,
    surface: input.surface,
    changes,
    identityParts: [existing.id, input.mutationId ?? randomUUID()],
    occurredAt: now,
  });
  const protectedFields = Object.keys(changes).map(logicalFieldToProtectedField);
  for (const field of protectedFields) {
    await trx
      .insertInto("task_field_protections")
      .values({
        task_id: existing.id,
        field,
        protected_by_user_id: input.userId,
        activity_event_id: activity.id,
        protected_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["task_id", "field"]).doUpdateSet({
          protected_by_user_id: input.userId,
          activity_event_id: activity.id,
          protected_at: now,
        }),
      )
      .execute();
  }

  const task = await trx.selectFrom("tasks").selectAll().where("id", "=", existing.id).executeTakeFirstOrThrow();
  return { status: "applied", task };
}

function canHumanEditLocalTask(
  task: Selectable<TasksTable>,
  input: Pick<HumanTaskMutationInput, "userId" | "assigneeEntityIds" | "canEditAllLocalTasks">,
): boolean {
  if (task.status_authority !== "local" || (task.provenance !== "brief" && task.provenance !== "summary")) {
    return false;
  }
  if (input.canEditAllLocalTasks === true) return true;
  if (task.created_by_user_id === input.userId) return true;
  return Boolean(task.assignee_entity_id && input.assigneeEntityIds?.includes(task.assignee_entity_id));
}

function logicalChanges(task: Selectable<TasksTable>, requested: HumanTaskChanges) {
  const entries: Array<[string, { before: unknown; after: unknown }]> = [];
  if (requested.title !== undefined && requested.title !== task.title) {
    entries.push(["title", { before: task.title, after: requested.title }]);
  }
  if (Object.hasOwn(requested, "priority") && requested.priority !== task.priority) {
    entries.push(["priority", { before: task.priority, after: requested.priority }]);
  }
  if (Object.hasOwn(requested, "dueAt") && requested.dueAt !== task.due_at) {
    entries.push(["dueAt", { before: task.due_at, after: requested.dueAt }]);
  }
  if (requested.status !== undefined && requested.status !== task.status) {
    entries.push(["status", { before: task.status, after: requested.status }]);
  }
  return Object.fromEntries(entries);
}

function taskUpdateValues(task: Selectable<TasksTable>, changes: HumanTaskChanges, now: string) {
  const values: Partial<{
    title: string;
    normalized_title: string;
    priority: string | null;
    due_at: string | null;
    status: TaskStatus;
    status_raw: TaskStatus;
    status_authority: "local";
    status_changed_at: string;
    completed_at: string | null;
  }> = {};
  if (changes.title !== undefined) {
    values.title = changes.title;
    values.normalized_title = normalizeName(changes.title);
  }
  if (Object.hasOwn(changes, "priority")) values.priority = changes.priority ?? null;
  if (Object.hasOwn(changes, "dueAt")) values.due_at = changes.dueAt ?? null;
  if (changes.status !== undefined && changes.status !== task.status) {
    values.status = changes.status;
    values.status_raw = changes.status;
    values.status_authority = "local";
    values.status_changed_at = now;
    values.completed_at = changes.status === "done" ? now : null;
  }
  return values;
}

function mutationTime(task: Selectable<TasksTable>, requested: string | undefined): string {
  if (requested) return requested;
  const previousStatusChangedAt = Date.parse(task.status_changed_at ?? "");
  return new Date(
    Number.isFinite(previousStatusChangedAt) ? Math.max(Date.now(), previousStatusChangedAt + 1) : Date.now(),
  ).toISOString();
}

function logicalFieldToProtectedField(field: string): TaskProtectedField {
  if (field === "dueAt") return "due_at";
  if (field === "title" || field === "priority" || field === "status") return field;
  throw new Error(`Unsupported task field: ${field}`);
}
