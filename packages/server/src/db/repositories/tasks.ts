import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB, TasksTable } from "../schema";
import type { FileViewer } from "./connectors";
import { fileVisibilityPredicate } from "./connectors";
import { whereLiveEntity } from "./entities";

export const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";

export type TaskStatus = "open" | "in_progress" | "done" | "dropped";

export interface UpsertTaskInput {
  parentEntityId: string | null;
  parentSourceRef: string | null;
  parentName: string | null;
  source: string;
  externalRef: string | null;
  title: string;
  status: TaskStatus;
  statusRaw: string | null;
  statusAuthority: "external" | "local";
  assigneeEntityId: string | null;
  priority: string | null;
  dueAt: string | null;
  provenance: "structural";
  sourceTaskId: string;
}

export interface TaskListOptions {
  viewer: FileViewer;
  status?: TaskStatus;
  limit?: number;
}

export function createTaskRepository(db: Kysely<DB>) {
  return {
    async upsertTask(input: UpsertTaskInput): Promise<{ taskId: string; created: boolean }> {
      const now = new Date().toISOString();
      const existing = await db
        .selectFrom("tasks")
        .selectAll()
        .where("source", "=", input.source)
        .where("source_task_id", "=", input.sourceTaskId)
        .executeTakeFirst();
      const statusChanged = existing ? existing.status !== input.status : true;
      const completedAt =
        input.status === "done"
          ? existing?.status === "done" && existing.completed_at
            ? existing.completed_at
            : now
          : null;
      const values = {
        parent_entity_id: input.parentEntityId,
        parent_source_ref: input.parentSourceRef,
        parent_name: input.parentName,
        source: input.source,
        external_ref: input.externalRef,
        title: input.title,
        normalized_title: normalizeName(input.title),
        status: input.status,
        status_raw: input.statusRaw,
        status_authority: input.statusAuthority,
        assignee_entity_id: input.assigneeEntityId,
        priority: input.priority,
        due_at: input.dueAt,
        provenance: input.provenance,
        source_task_id: input.sourceTaskId,
        status_changed_at: statusChanged ? now : (existing?.status_changed_at ?? null),
        completed_at: completedAt,
        valid_from: existing?.valid_from ?? now,
        valid_to: null,
        updated_at: now,
      };

      await db
        .insertInto("tasks")
        .values({
          id: existing?.id ?? randomUUID(),
          ...values,
        })
        .onConflict((oc) =>
          oc.columns(["source", "source_task_id"]).doUpdateSet({
            ...values,
          }),
        )
        .execute();

      const row = await db
        .selectFrom("tasks")
        .select("id")
        .where("source", "=", input.source)
        .where("source_task_id", "=", input.sourceTaskId)
        .executeTakeFirstOrThrow();
      return { taskId: row.id, created: !existing };
    },

    async upsertEvidence(taskId: string, kind: string, refId: string): Promise<void> {
      await db
        .insertInto("task_evidence")
        .values({ task_id: taskId, kind, ref_id: refId })
        .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
        .execute();
    },

    async reanchorNullParentTasks(): Promise<number> {
      const rows = await db
        .selectFrom("tasks")
        .select(["id", "parent_source_ref", "parent_name"])
        .where("parent_entity_id", "is", null)
        .where("valid_to", "is", null)
        .execute();
      let count = 0;
      for (const task of rows) {
        const parent = await findLiveProjectForTask(db, task.parent_source_ref, task.parent_name);
        if (!parent || parent.id === TEST_ACCOUNT_ENTITY_ID) continue;
        await db
          .updateTable("tasks")
          .set({ parent_entity_id: parent.id, updated_at: new Date().toISOString() })
          .where("id", "=", task.id)
          .where("parent_entity_id", "is", null)
          .execute();
        count++;
      }
      return count;
    },

    async expireOrphanedTasks(source?: string): Promise<number> {
      const now = new Date().toISOString();
      let query = db
        .updateTable("tasks")
        .set({ valid_to: now, updated_at: now })
        .where("valid_to", "is", null)
        .where((eb) =>
          eb.not(sql<boolean>`EXISTS (
            SELECT 1 FROM indexed_file_facts iff
            WHERE iff.source = tasks.source
              AND iff.subject_source_id = tasks.source_task_id
              AND iff.fact_type = 'structural_task'
              AND iff.deleted_at IS NULL
          )`),
        );
      if (source) query = query.where("source", "=", source);
      const result = await query.executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    async listTasksByParent(entityId: string, opts: TaskListOptions): Promise<Selectable<TasksTable>[]> {
      let query = visibleTaskQuery(db, opts.viewer)
        .where("tasks.parent_entity_id", "=", entityId)
        .orderBy("tasks.status", "asc")
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 100);
      if (opts.status) query = query.where("tasks.status", "=", opts.status);
      return query.execute();
    },

    async listTasksByAssignee(entityId: string, opts: TaskListOptions): Promise<Selectable<TasksTable>[]> {
      let query = visibleTaskQuery(db, opts.viewer)
        .where("tasks.assignee_entity_id", "=", entityId)
        .orderBy("tasks.status", "asc")
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 100);
      if (opts.status) query = query.where("tasks.status", "=", opts.status);
      return query.execute();
    },
  };
}

function visibleTaskQuery(db: Kysely<DB>, viewer: FileViewer) {
  return db
    .selectFrom("tasks")
    .selectAll("tasks")
    .where("tasks.valid_to", "is", null)
    .where((eb) =>
      eb.exists(sql<boolean>`(
        SELECT 1 FROM task_evidence
        INNER JOIN indexed_files ON indexed_files.id = task_evidence.ref_id
        WHERE task_evidence.task_id = tasks.id
          AND task_evidence.kind = 'file'
          AND ${fileVisibilityPredicate(viewer)}
      )`),
    );
}

async function findLiveProjectForTask(db: Kysely<DB>, parentSourceRef: string | null, parentName: string | null) {
  if (parentSourceRef) {
    const [source, ...sourceIdParts] = parentSourceRef.split(":");
    const sourceId = sourceIdParts.join(":");
    if (source && sourceId) {
      const byRef = await db
        .selectFrom("entity_source_refs")
        .innerJoin("entities", "entities.id", "entity_source_refs.entity_id")
        .selectAll("entities")
        .where("entity_source_refs.source", "=", source)
        .where("entity_source_refs.source_id", "=", sourceId)
        .where("entities.source_type", "=", "project")
        .where("entities.id", "!=", TEST_ACCOUNT_ENTITY_ID)
        .where(whereLiveEntity())
        .executeTakeFirst();
      if (byRef) return byRef;
    }
  }

  const nameKey = parentName ? normalizeName(parentName) : "";
  if (!nameKey) return null;
  const candidates = await db
    .selectFrom("entities")
    .selectAll()
    .where("source_type", "=", "project")
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity())
    .execute();
  return candidates.find((entity) => normalizeName(entity.name) === nameKey) ?? null;
}
