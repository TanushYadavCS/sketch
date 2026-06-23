import { createHash, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { fileAccessFilterSql } from "../../connectors/search";
import type { DB, TasksTable } from "../schema";
import type { AgentKnowledgeRefs, AgentOutputItemInput } from "./agent-outputs";
import type { FileViewer } from "./connectors";
import { fileVisibilityPredicate } from "./connectors";
import { whereLiveEntity } from "./entities";

export const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";
const BRIEF_TASK_ID_SEPARATOR = "\u001f";
const LLM_TASK_ID_SEPARATOR = "\u001f";

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
  assigneeName?: string | null;
  priority: string | null;
  dueAt: string | null;
  provenance: "structural" | "brief" | "llm";
  sourceTaskId: string;
  createdByUserId?: string | null;
}

export interface TaskListOptions {
  viewer: FileViewer;
  viewerUserId?: string | null;
  status?: TaskStatus;
  limit?: number;
}

export interface PromoteBriefTaskInput {
  userId: string;
  todo: AgentOutputItemInput;
  knowledgeRefs: AgentKnowledgeRefs;
}

export type PromoteBriefTaskResult =
  | { status: "skipped"; reason: "missing_file_id" }
  | { status: "collated"; taskId: string }
  | { status: "upserted"; taskId: string; created: boolean };

export interface LoadOpenDurableTasksForBriefOptions {
  userId: string;
  userEmails: string[];
  limit?: number;
}

export interface UpsertLlmTaskInput {
  candidate: { title: string; dueAt?: string | null; assigneeEntityId?: string | null; assigneeName?: string | null };
  ownerUserId: string;
  parentEntityId: string | null;
  parentKey: string;
  evidence: { fileIds: string[]; entityIds: string[]; factIds: string[] };
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
        assignee_name: input.assigneeName ?? null,
        priority: input.priority,
        due_at: input.dueAt,
        provenance: input.provenance,
        source_task_id: input.sourceTaskId,
        created_by_user_id: input.createdByUserId ?? null,
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

    async promoteBriefTask(input: PromoteBriefTaskInput): Promise<PromoteBriefTaskResult> {
      if (input.knowledgeRefs.fileIds.length === 0) return { status: "skipped", reason: "missing_file_id" };

      const parent = await resolveBriefTaskParent(db, input.knowledgeRefs.entityIds);
      const parentKey = parent?.id ?? "global";
      const normalizedTitle = normalizeName(input.todo.title);

      if (parent) {
        const structural = await db
          .selectFrom("tasks")
          .select("id")
          .where("provenance", "=", "structural")
          .where("valid_to", "is", null)
          .where("parent_entity_id", "=", parent.id)
          .where("normalized_title", "=", normalizedTitle)
          .executeTakeFirst();
        if (structural) {
          await promoteBriefTaskEvidence(db, structural.id, input.knowledgeRefs);
          return { status: "collated", taskId: structural.id };
        }
      }

      const result = await upsertBriefTask(db, {
        userId: input.userId,
        parentEntityId: parent?.id ?? null,
        parentKey,
        todo: input.todo,
        normalizedTitle,
      });
      await promoteBriefTaskEvidence(db, result.taskId, input.knowledgeRefs);
      return { status: "upserted", ...result };
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
        .where("provenance", "=", "structural")
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
      let query = visibleTaskQuery(db, opts.viewer, opts.viewerUserId)
        .where("tasks.parent_entity_id", "=", entityId)
        .orderBy("tasks.status", "asc")
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 100);
      if (opts.status) query = query.where("tasks.status", "=", opts.status);
      return query.execute();
    },

    async listTasksByAssignee(entityId: string, opts: TaskListOptions): Promise<Selectable<TasksTable>[]> {
      let query = visibleTaskQuery(db, opts.viewer, opts.viewerUserId)
        .where("tasks.assignee_entity_id", "=", entityId)
        .orderBy("tasks.status", "asc")
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 100);
      if (opts.status) query = query.where("tasks.status", "=", opts.status);
      return query.execute();
    },

    async loadOpenDurableTasksForBrief(opts: LoadOpenDurableTasksForBriefOptions): Promise<Selectable<TasksTable>[]> {
      if (opts.userEmails.length === 0) return [];
      return db
        .selectFrom("tasks")
        .selectAll("tasks")
        .where("tasks.valid_to", "is", null)
        .where("tasks.status", "in", ["open", "in_progress"])
        .where((eb) =>
          eb.or([eb("tasks.provenance", "=", "structural"), eb("tasks.created_by_user_id", "=", opts.userId)]),
        )
        .where((eb) =>
          eb.exists(sql<boolean>`(
            SELECT 1 FROM task_evidence
            INNER JOIN indexed_files ON indexed_files.id = task_evidence.ref_id
            WHERE task_evidence.task_id = tasks.id
              AND task_evidence.kind = 'file'
              AND ${fileAccessFilterSql(opts.userEmails)}
          )`),
        )
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 50)
        .execute();
    },
  };
}

export async function upsertLlmTask(
  db: Kysely<DB>,
  input: UpsertLlmTaskInput,
): Promise<{ taskId: string; created: boolean }> {
  const normalizedTitle = normalizeName(input.candidate.title);
  const sourceTaskId = createHash("sha256")
    .update(["llm", input.ownerUserId, input.parentKey, normalizedTitle].join(LLM_TASK_ID_SEPARATOR))
    .digest("hex");
  const result = await createTaskRepository(db).upsertTask({
    parentEntityId: input.parentEntityId,
    parentSourceRef: null,
    parentName: null,
    source: "llm",
    externalRef: null,
    title: input.candidate.title,
    status: "open",
    statusRaw: null,
    statusAuthority: "local",
    assigneeEntityId: input.candidate.assigneeEntityId ?? null,
    assigneeName: input.candidate.assigneeName ?? null,
    priority: null,
    dueAt: input.candidate.dueAt ?? null,
    provenance: "llm",
    sourceTaskId,
    createdByUserId: input.ownerUserId,
  });
  await promoteLlmTaskEvidence(db, result.taskId, input.evidence);
  return result;
}

export async function retireLlmTasksForTombstonedFacts(db: Kysely<DB>, factIds: string[]): Promise<number> {
  if (factIds.length === 0) return 0;
  const now = new Date().toISOString();
  const result = await db
    .updateTable("tasks")
    .set({ valid_to: now, updated_at: now })
    .where("valid_to", "is", null)
    .where("provenance", "=", "llm")
    .where("source", "=", "llm")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("task_evidence as tombstoned_evidence")
          .select(sql`1`.as("x"))
          .whereRef("tombstoned_evidence.task_id", "=", "tasks.id")
          .where("tombstoned_evidence.kind", "=", "fact")
          .where("tombstoned_evidence.ref_id", "in", factIds),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("task_evidence as active_evidence")
            .innerJoin("indexed_file_facts as active_fact", "active_fact.id", "active_evidence.ref_id")
            .select(sql`1`.as("x"))
            .whereRef("active_evidence.task_id", "=", "tasks.id")
            .where("active_evidence.kind", "=", "fact")
            .where("active_fact.fact_type", "=", "llm_task")
            .where("active_fact.deleted_at", "is", null),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

async function promoteLlmTaskEvidence(
  db: Kysely<DB>,
  taskId: string,
  refs: UpsertLlmTaskInput["evidence"],
): Promise<void> {
  const edges = [
    ...refs.fileIds.map((refId) => ({ kind: "file", refId })),
    ...refs.entityIds.map((refId) => ({ kind: "entity", refId })),
    ...refs.factIds.map((refId) => ({ kind: "fact", refId })),
  ];
  for (const edge of edges) {
    await db
      .insertInto("task_evidence")
      .values({ task_id: taskId, kind: edge.kind, ref_id: edge.refId })
      .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
      .execute();
  }
}

function briefStatusFromLabel(label: string): TaskStatus {
  if (label === "in_progress") return "in_progress";
  if (label === "done") return "done";
  return "open";
}

async function upsertBriefTask(
  db: Kysely<DB>,
  input: {
    userId: string;
    parentEntityId: string | null;
    parentKey: string;
    todo: AgentOutputItemInput;
    normalizedTitle: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  const sourceTaskId = createHash("sha256")
    .update([input.userId, input.parentKey, input.normalizedTitle].join(BRIEF_TASK_ID_SEPARATOR))
    .digest("hex");
  const now = new Date().toISOString();
  const existing = await db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "brief")
    .where("source_task_id", "=", sourceTaskId)
    .executeTakeFirst();
  const status = briefStatusFromLabel(input.todo.label);
  const statusChanged = existing ? existing.status !== status : true;
  const completedAt =
    status === "done" ? (existing?.status === "done" && existing.completed_at ? existing.completed_at : now) : null;
  const values = {
    parent_entity_id: input.parentEntityId,
    parent_source_ref: null,
    parent_name: null,
    source: "brief",
    external_ref: null,
    title: input.todo.title,
    normalized_title: input.normalizedTitle,
    status,
    status_raw: input.todo.label,
    status_authority: "local",
    assignee_entity_id: null,
    priority: input.todo.priority,
    due_at: null,
    provenance: "brief",
    source_task_id: sourceTaskId,
    created_by_user_id: input.userId,
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
    .where("source", "=", "brief")
    .where("source_task_id", "=", sourceTaskId)
    .executeTakeFirstOrThrow();
  return { taskId: row.id, created: !existing };
}

async function resolveBriefTaskParent(db: Kysely<DB>, entityIds: string[]) {
  if (entityIds.length === 0) return null;
  const rows = await db
    .selectFrom("entities")
    .select(["id", "source_type"])
    .where("id", "in", entityIds)
    .where("source_type", "=", "project")
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity())
    .execute();
  const liveProjects = new Set(rows.map((row) => row.id));
  const id = entityIds.find((entityId) => liveProjects.has(entityId));
  return id ? { id } : null;
}

async function promoteBriefTaskEvidence(db: Kysely<DB>, taskId: string, refs: AgentKnowledgeRefs): Promise<void> {
  const edges = [
    ...refs.fileIds.map((refId) => ({ kind: "file", refId })),
    ...refs.entityIds.map((refId) => ({ kind: "entity", refId })),
    ...(refs.factIds ?? []).map((refId) => ({ kind: "fact", refId })),
    ...(refs.mentionIds ?? []).map((refId) => ({ kind: "mention", refId })),
  ];
  for (const edge of edges) {
    await db
      .insertInto("task_evidence")
      .values({ task_id: taskId, kind: edge.kind, ref_id: edge.refId })
      .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
      .execute();
  }
}

function visibleTaskQuery(db: Kysely<DB>, viewer: FileViewer, viewerUserId?: string | null) {
  let query = db.selectFrom("tasks").selectAll("tasks").where("tasks.valid_to", "is", null);

  if (!viewer.isAdmin) {
    query = query.where((eb) =>
      eb.exists(sql<boolean>`(
          SELECT 1 FROM task_evidence
          INNER JOIN indexed_files ON indexed_files.id = task_evidence.ref_id
          WHERE task_evidence.task_id = tasks.id
            AND task_evidence.kind = 'file'
            AND ${fileVisibilityPredicate(viewer)}
        )`),
    );
  }

  if (!viewerUserId) return query.where("tasks.provenance", "!=", "brief");

  return query.where((eb) =>
    eb.or([eb("tasks.provenance", "!=", "brief"), eb("tasks.created_by_user_id", "=", viewerUserId)]),
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
