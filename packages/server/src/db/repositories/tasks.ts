import { createHash, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { EntityRedirectError } from "../../entities/redirect";
import type { DB, EntitiesTable, TasksTable } from "../schema";
import type { AgentKnowledgeRefs, AgentOutputItemInput } from "./agent-outputs";
import type { FileViewer } from "./connectors";
import { fileVisibilityPredicate } from "./connectors";
import { normalizeContactPointValue, whereLiveEntity } from "./entities";

export const TEST_ACCOUNT_ENTITY_ID = "24d4ef8a-47eb-4510-a951-7d9bae036786";
const BRIEF_TASK_ID_SEPARATOR = "\u001f";
const LLM_TASK_ID_SEPARATOR = "\u001f";
const SUMMARY_TASK_ID_SEPARATOR = "\u001f";

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
  proposedAssigneeName?: string | null;
  priority: string | null;
  dueAt: string | null;
  provenance: "structural" | "brief" | "summary" | "llm";
  sourceTaskId: string;
  createdByUserId?: string | null;
}

export interface TaskListOptions {
  viewer: FileViewer;
  userId?: string | null;
  assigneeEntityIds?: string[];
  canReadAllLocalTasks?: boolean;
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
  | { status: "skipped"; reason: "ineligible_assignee" }
  | { status: "collated"; taskId: string }
  | { status: "upserted"; taskId: string; created: boolean };

export interface PromoteSummaryTaskInput {
  userId: string;
  item: AgentOutputItemInput;
}

export type PromoteSummaryTaskResult =
  | { status: "skipped"; reason: "ineligible_assignee" }
  | { status: "collated"; taskId: string }
  | { status: "upserted"; taskId: string; created: boolean };

export interface UpdateLocalTaskStatusInput {
  taskId: string;
  userId: string;
  assigneeEntityIds?: string[];
  canEditAllLocalTasks?: boolean;
  status: TaskStatus;
}

export interface ReanchorNullParentTasksResult {
  count: number;
  taskIds: string[];
  indexedFileIds: string[];
  parentEntityIds: string[];
}

export interface LoadOpenDurableTasksForBriefOptions {
  userId: string;
  userEmails: string[];
  assigneeEntityIds?: string[];
  limit?: number;
}

export interface LoadSummaryTasksForBriefOptions {
  userId: string;
  assigneeEntityIds?: string[];
  since: string;
  limit?: number;
}

export type BriefTaskEntityIdentity = Pick<Selectable<EntitiesTable>, "id" | "name" | "source_type">;

export type DurableTaskForBrief = Selectable<TasksTable> & {
  createdByReader: boolean;
  assignedToReader: boolean;
  parentEntity: BriefTaskEntityIdentity | null;
  assigneeEntity: BriefTaskEntityIdentity | null;
  knowledgeRefs: {
    entityIds: string[];
    fileIds: string[];
  };
};

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
        proposed_assignee_name: input.proposedAssigneeName ?? null,
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
      const parent = await resolveBriefTaskParent(db, input.knowledgeRefs.entityIds);
      const parentKey = parent?.id ?? "global";
      const normalizedTitle = normalizeName(input.todo.title);
      const existing = await findBriefCollationTarget(db, {
        userId: input.userId,
        parentEntityId: parent?.id ?? null,
        normalizedTitle,
      });
      if (existing) {
        await promoteBriefTaskEvidence(db, existing.id, input.knowledgeRefs);
        return { status: "collated", taskId: existing.id };
      }

      if (input.knowledgeRefs.fileIds.length === 0) return { status: "skipped", reason: "missing_file_id" };

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

      const assignee = await resolveSummaryTaskAssignee(db, input.todo);
      if (!assignee.entityId || !assignee.name) return { status: "skipped", reason: "ineligible_assignee" };

      const result = await upsertBriefTask(db, {
        userId: input.userId,
        parentEntityId: parent?.id ?? null,
        parentKey,
        assigneeEntityId: assignee.entityId,
        assigneeName: assignee.name,
        todo: input.todo,
        normalizedTitle,
      });
      await promoteBriefTaskEvidence(db, result.taskId, input.knowledgeRefs);
      return { status: "upserted", ...result };
    },

    async promoteSummaryTask(input: PromoteSummaryTaskInput): Promise<PromoteSummaryTaskResult> {
      const parent = await resolveSummaryTaskParent(db, input.item);
      const parentKey = parent?.id ?? parent?.parentSourceRef ?? parent?.parentName ?? "global";
      const normalizedTitle = normalizeName(input.item.title);

      if (parent?.id) {
        const structural = await db
          .selectFrom("tasks")
          .select("id")
          .where("provenance", "=", "structural")
          .where("valid_to", "is", null)
          .where("parent_entity_id", "=", parent.id)
          .where("normalized_title", "=", normalizedTitle)
          .executeTakeFirst();
        if (structural) {
          await promoteSummaryTaskEvidence(db, structural.id, input.item);
          return { status: "collated", taskId: structural.id };
        }
      }

      const assignee = await resolveSummaryTaskAssignee(db, input.item);
      if (!assignee.entityId || !assignee.name) return { status: "skipped", reason: "ineligible_assignee" };

      const result = await upsertSummaryTask(db, {
        userId: input.userId,
        parentEntityId: parent?.id ?? null,
        parentSourceRef: parent?.parentSourceRef ?? null,
        parentName: parent?.parentName ?? null,
        parentKey,
        assigneeEntityId: assignee.entityId,
        assigneeName: assignee.name,
        proposedAssigneeName: null,
        item: input.item,
        normalizedTitle,
      });
      await promoteSummaryTaskEvidence(db, result.taskId, input.item);
      return { status: "upserted", ...result };
    },

    async reanchorNullParentTasks(): Promise<ReanchorNullParentTasksResult> {
      const rows = await db
        .selectFrom("tasks")
        .select(["id", "parent_source_ref", "parent_name"])
        .where("parent_entity_id", "is", null)
        .where("valid_to", "is", null)
        .execute();
      let count = 0;
      const taskIds: string[] = [];
      const parentEntityIds = new Set<string>();
      for (const task of rows) {
        const parent = await findLiveProjectForTask(db, task.parent_source_ref, task.parent_name);
        if (!parent || parent.id === TEST_ACCOUNT_ENTITY_ID) continue;
        const result = await db
          .updateTable("tasks")
          .set({ parent_entity_id: parent.id, updated_at: new Date().toISOString() })
          .where("id", "=", task.id)
          .where("parent_entity_id", "is", null)
          .execute();
        const updated = Number(result[0]?.numUpdatedRows ?? 0);
        if (updated === 0) continue;
        count += updated;
        taskIds.push(task.id);
        parentEntityIds.add(parent.id);
      }
      const evidenceRows =
        taskIds.length > 0
          ? await db
              .selectFrom("task_evidence")
              .select("ref_id")
              .distinct()
              .where("task_id", "in", taskIds)
              .where("kind", "=", "file")
              .execute()
          : [];
      return {
        count,
        taskIds,
        indexedFileIds: evidenceRows.map((row) => row.ref_id),
        parentEntityIds: [...parentEntityIds],
      };
    },

    async listStructuralTaskIdsByParentEntityIds(parentEntityIds: string[]): Promise<string[]> {
      if (parentEntityIds.length === 0) return [];
      const rows = await db
        .selectFrom("tasks")
        .select("id")
        .where("provenance", "=", "structural")
        .where("valid_to", "is", null)
        .where("parent_entity_id", "in", parentEntityIds)
        .execute();
      return rows.map((row) => row.id);
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
      let query = visibleTaskQuery(db, opts.viewer, {
        userId: opts.userId,
        assigneeEntityIds: opts.assigneeEntityIds,
        canReadAllLocalTasks: opts.canReadAllLocalTasks === true,
      })
        .where("tasks.parent_entity_id", "=", entityId)
        .orderBy("tasks.status", "asc")
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 100);
      if (opts.status) query = query.where("tasks.status", "=", opts.status);
      return query.execute();
    },

    async listTasksByAssignee(entityId: string, opts: TaskListOptions): Promise<Selectable<TasksTable>[]> {
      let query = visibleTaskQuery(db, opts.viewer, {
        userId: opts.userId,
        assigneeEntityIds: opts.assigneeEntityIds,
        canReadAllLocalTasks: opts.canReadAllLocalTasks === true,
      })
        .where("tasks.assignee_entity_id", "=", entityId)
        .orderBy("tasks.status", "asc")
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 100);
      if (opts.status) query = query.where("tasks.status", "=", opts.status);
      return query.execute();
    },

    async loadOpenDurableTasksForBrief(opts: LoadOpenDurableTasksForBriefOptions): Promise<DurableTaskForBrief[]> {
      const assigneeEntityIds = [...new Set(opts.assigneeEntityIds ?? [])].filter(Boolean);
      const canonicalAssigneeEntityIds = [
        ...new Set((await resolveCanonicalEntityIds(db, assigneeEntityIds)).values()),
      ];
      const eligibleAssigneeEntityIds = await loadMergedEntityPredecessorIds(db, canonicalAssigneeEntityIds);
      const visibleFileEvidence =
        opts.userEmails.length === 0
          ? sql<boolean>`false`
          : sql<boolean>`EXISTS (
            SELECT 1 FROM task_evidence
            INNER JOIN indexed_files ON indexed_files.id = task_evidence.ref_id
            WHERE task_evidence.task_id = tasks.id
              AND task_evidence.kind = 'file'
              AND indexed_files.is_archived = 0
              AND ${fileVisibilityForEmails(opts.userEmails)}
          )`;
      let query = db
        .selectFrom("tasks")
        .selectAll("tasks")
        .where("tasks.valid_to", "is", null)
        .where("tasks.status", "in", ["open", "in_progress"])
        .where((eb) => {
          const assignedToReader =
            eligibleAssigneeEntityIds.length === 0
              ? sql<boolean>`false`
              : eb("tasks.assignee_entity_id", "in", eligibleAssigneeEntityIds);
          return eb.or([
            eb.and([eb("tasks.provenance", "=", "structural"), assignedToReader, visibleFileEvidence]),
            eb.and([
              eb("tasks.provenance", "in", ["brief", "summary"]),
              eb("tasks.status_authority", "=", "local"),
              eb.or([eb("tasks.created_by_user_id", "=", opts.userId), assignedToReader]),
            ]),
          ]);
        })
        .orderBy("tasks.updated_at", "desc")
        .orderBy("tasks.id", "asc");
      if (opts.limit !== undefined) query = query.limit(opts.limit);
      const tasks = await query.execute();
      return loadDurableTaskMetadata(db, tasks, {
        userId: opts.userId,
        userEmails: opts.userEmails,
        assigneeEntityIds: canonicalAssigneeEntityIds,
      });
    },

    async loadSummaryTasksForBrief(opts: LoadSummaryTasksForBriefOptions): Promise<Selectable<TasksTable>[]> {
      const assigneeEntityIds = [...new Set(opts.assigneeEntityIds ?? [])].filter(Boolean);
      const canonicalAssigneeEntityIds = [
        ...new Set((await resolveCanonicalEntityIds(db, assigneeEntityIds)).values()),
      ];
      const eligibleAssigneeEntityIds = await loadMergedEntityPredecessorIds(db, canonicalAssigneeEntityIds);
      return db
        .selectFrom("tasks")
        .selectAll()
        .where("valid_to", "is", null)
        .where((eb) =>
          eb.or([
            eb("created_by_user_id", "=", opts.userId),
            ...(eligibleAssigneeEntityIds.length > 0
              ? [eb("assignee_entity_id", "in", eligibleAssigneeEntityIds)]
              : []),
          ]),
        )
        .where("provenance", "=", "summary")
        .where("updated_at", ">=", opts.since)
        .where("status", "in", ["open", "in_progress", "done", "dropped"])
        .orderBy("updated_at", "desc")
        .orderBy("id", "asc")
        .limit(opts.limit ?? 50)
        .execute();
    },

    async updateLocalTaskStatus(input: UpdateLocalTaskStatusInput): Promise<Selectable<TasksTable> | null> {
      const existing = await db
        .selectFrom("tasks")
        .selectAll()
        .where("id", "=", input.taskId)
        .where("valid_to", "is", null)
        .executeTakeFirst();
      if (
        !existing ||
        !canEditLocalTask(existing, input.userId, input.assigneeEntityIds ?? [], input.canEditAllLocalTasks === true) ||
        existing.status_authority !== "local" ||
        (existing.provenance !== "brief" && existing.provenance !== "summary")
      ) {
        return null;
      }

      const now = new Date().toISOString();
      const completedAt =
        input.status === "done"
          ? existing.status === "done" && existing.completed_at
            ? existing.completed_at
            : now
          : null;
      await db
        .updateTable("tasks")
        .set({
          status: input.status,
          status_raw: input.status,
          status_authority: "local",
          status_changed_at: existing.status === input.status ? existing.status_changed_at : now,
          completed_at: completedAt,
          updated_at: now,
        })
        .where("id", "=", input.taskId)
        .execute();

      return db.selectFrom("tasks").selectAll().where("id", "=", input.taskId).executeTakeFirstOrThrow();
    },
  };
}

async function loadDurableTaskMetadata(
  db: Kysely<DB>,
  tasks: Selectable<TasksTable>[],
  opts: { userId: string; userEmails: string[]; assigneeEntityIds: string[] },
): Promise<DurableTaskForBrief[]> {
  if (tasks.length === 0) return [];

  const taskIds = tasks.map((task) => task.id);
  const evidenceRows = await db
    .selectFrom("task_evidence")
    .select(["task_id", "kind", "ref_id"])
    .where("task_id", "in", taskIds)
    .where("kind", "in", ["entity", "file"])
    .execute();
  const entityIds = [
    ...new Set([
      ...tasks.flatMap((task) => [task.parent_entity_id, task.assignee_entity_id]),
      ...evidenceRows.filter((row) => row.kind === "entity").map((row) => row.ref_id),
    ]),
  ].filter((id): id is string => Boolean(id));
  const canonicalEntityIdsById = await resolveCanonicalEntityIds(db, entityIds);
  const canonicalEntityIds = [...new Set(canonicalEntityIdsById.values())];
  const entities =
    canonicalEntityIds.length === 0
      ? []
      : await db
          .selectFrom("entities")
          .select(["id", "name", "source_type"])
          .where("id", "in", canonicalEntityIds)
          .where(whereLiveEntity())
          .execute();
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));

  const evidenceFileIds = [...new Set(evidenceRows.filter((row) => row.kind === "file").map((row) => row.ref_id))];
  const visibleFiles =
    evidenceFileIds.length === 0 || opts.userEmails.length === 0
      ? []
      : await db
          .selectFrom("indexed_files")
          .select("id")
          .where("id", "in", evidenceFileIds)
          .where("is_archived", "=", 0)
          .where(fileVisibilityForEmails(opts.userEmails))
          .execute();
  const visibleFileIds = new Set(visibleFiles.map((file) => file.id));
  const evidenceByTaskId = new Map<string, Array<{ kind: string; ref_id: string }>>();
  for (const evidence of evidenceRows) {
    const taskEvidence = evidenceByTaskId.get(evidence.task_id) ?? [];
    taskEvidence.push(evidence);
    evidenceByTaskId.set(evidence.task_id, taskEvidence);
  }
  const assigneeEntityIds = new Set(opts.assigneeEntityIds);

  return tasks.map((task) => {
    const parentEntityId = task.parent_entity_id ? canonicalEntityIdsById.get(task.parent_entity_id) : null;
    const assigneeEntityId = task.assignee_entity_id ? canonicalEntityIdsById.get(task.assignee_entity_id) : null;
    const parentEntity = parentEntityId ? (entitiesById.get(parentEntityId) ?? null) : null;
    const assigneeEntity = assigneeEntityId ? (entitiesById.get(assigneeEntityId) ?? null) : null;
    const taskEvidence = evidenceByTaskId.get(task.id) ?? [];
    const entityRefs = new Set<string>();
    if (parentEntity) entityRefs.add(parentEntity.id);
    if (assigneeEntity) entityRefs.add(assigneeEntity.id);
    for (const evidence of taskEvidence) {
      const canonicalEntityId = canonicalEntityIdsById.get(evidence.ref_id);
      if (evidence.kind === "entity" && canonicalEntityId && entitiesById.has(canonicalEntityId)) {
        entityRefs.add(canonicalEntityId);
      }
    }
    const fileRefs = new Set(
      taskEvidence
        .filter((evidence) => evidence.kind === "file" && visibleFileIds.has(evidence.ref_id))
        .map((evidence) => evidence.ref_id),
    );
    return {
      ...task,
      createdByReader: task.created_by_user_id === opts.userId,
      assignedToReader: Boolean(assigneeEntityId && assigneeEntityIds.has(assigneeEntityId)),
      parentEntity,
      assigneeEntity,
      knowledgeRefs: {
        entityIds: [...entityRefs].sort(),
        fileIds: [...fileRefs].sort(),
      },
    };
  });
}

function fileVisibilityForEmails(userEmails: string[], alias = "indexed_files") {
  const emails = [...new Set(userEmails)].filter(Boolean);
  if (emails.length === 0) return sql<boolean>`false`;
  return sql<boolean>`(${sql.join(
    emails.map((email) => fileVisibilityPredicate({ email, isAdmin: false }, alias)),
    sql` OR `,
  )})`;
}

async function resolveCanonicalEntityIds(db: Kysely<DB>, entityIds: string[]): Promise<Map<string, string>> {
  const sourceIds = [...new Set(entityIds)].filter(Boolean);
  if (sourceIds.length === 0) return new Map();

  const redirects = new Map<string, string | null>();
  let frontier = sourceIds;
  for (let depth = 0; depth < 32 && frontier.length > 0; depth++) {
    const rows = await db
      .selectFrom("entities")
      .select(["id", "merged_into_entity_id"])
      .where("id", "in", frontier)
      .execute();
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const next = new Set<string>();
    for (const entityId of frontier) {
      const mergedIntoEntityId = rowsById.get(entityId)?.merged_into_entity_id ?? null;
      redirects.set(entityId, mergedIntoEntityId);
      if (mergedIntoEntityId && !redirects.has(mergedIntoEntityId)) next.add(mergedIntoEntityId);
    }
    frontier = [...next];
  }
  if (frontier.length > 0) {
    throw new EntityRedirectError("ENTITY_REDIRECT_TOO_DEEP", "entity merge redirect chain exceeded limit", {
      entityIds: sourceIds,
    });
  }

  const canonicalIds = new Map<string, string>();
  for (const sourceId of sourceIds) {
    let current = sourceId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current)) {
        throw new EntityRedirectError("ENTITY_REDIRECT_CYCLE", "entity merge redirect cycle detected", {
          entityId: sourceId,
        });
      }
      seen.add(current);
      const target = redirects.get(current);
      if (!target) {
        canonicalIds.set(sourceId, current);
        break;
      }
      current = target;
    }
    if (!canonicalIds.has(sourceId)) {
      throw new EntityRedirectError("ENTITY_REDIRECT_TOO_DEEP", "entity merge redirect chain exceeded limit", {
        entityId: sourceId,
      });
    }
  }
  return canonicalIds;
}

async function loadMergedEntityPredecessorIds(db: Kysely<DB>, entityIds: string[]): Promise<string[]> {
  const resolvedIds = new Set(entityIds);
  let frontier = [...resolvedIds];
  for (let depth = 0; depth < 32 && frontier.length > 0; depth++) {
    const rows = await db.selectFrom("entities").select("id").where("merged_into_entity_id", "in", frontier).execute();
    frontier = rows.map((row) => row.id).filter((id) => !resolvedIds.has(id));
    for (const id of frontier) resolvedIds.add(id);
  }
  if (frontier.length > 0) {
    throw new EntityRedirectError("ENTITY_REDIRECT_TOO_DEEP", "entity merge redirect chain exceeded limit", {
      entityIds,
    });
  }
  return [...resolvedIds];
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
    assigneeEntityId: string;
    assigneeName: string;
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
  const newStatus = briefStatusFromLabel(input.todo.label);
  const status = (existing?.status as TaskStatus | undefined) ?? newStatus;
  const statusRaw = existing?.status_raw ?? input.todo.label;
  const statusAuthority = existing?.status_authority ?? "local";
  const statusChanged = !existing;
  const completedAt = existing ? existing.completed_at : status === "done" ? now : null;
  const values = {
    parent_entity_id: input.parentEntityId,
    parent_source_ref: null,
    parent_name: null,
    source: "brief",
    external_ref: null,
    title: input.todo.title,
    normalized_title: input.normalizedTitle,
    status,
    status_raw: statusRaw,
    status_authority: statusAuthority,
    assignee_entity_id: input.assigneeEntityId,
    assignee_name: input.assigneeName,
    proposed_assignee_name: null,
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

async function upsertSummaryTask(
  db: Kysely<DB>,
  input: {
    userId: string;
    parentEntityId: string | null;
    parentSourceRef: string | null;
    parentName: string | null;
    parentKey: string;
    assigneeEntityId: string | null;
    assigneeName: string | null;
    proposedAssigneeName: string | null;
    item: AgentOutputItemInput;
    normalizedTitle: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  const sourceTaskId = createHash("sha256")
    .update([input.userId, input.parentKey, input.normalizedTitle].join(SUMMARY_TASK_ID_SEPARATOR))
    .digest("hex");
  const now = new Date().toISOString();
  let existing = await db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "summary")
    .where("source_task_id", "=", sourceTaskId)
    .executeTakeFirst();
  if (!existing && input.parentEntityId) {
    existing = await findSummaryTaskByResolvedParent(db, {
      userId: input.userId,
      parentEntityId: input.parentEntityId,
      normalizedTitle: input.normalizedTitle,
    });
  }
  if (!existing && input.parentEntityId) {
    existing = await findReanchorableSummaryTask(db, {
      userId: input.userId,
      normalizedTitle: input.normalizedTitle,
    });
  }
  const status = (existing?.status as TaskStatus | undefined) ?? "open";
  const statusRaw = existing?.status_raw ?? input.item.label;
  const statusAuthority = existing?.status_authority ?? "local";
  const hasAssigneeSignal = Boolean(input.assigneeEntityId || input.assigneeName || input.proposedAssigneeName);
  const values = {
    parent_entity_id: input.parentEntityId,
    parent_source_ref: input.parentSourceRef,
    parent_name: input.parentName,
    source: "summary",
    external_ref: null,
    title: input.item.title,
    normalized_title: input.normalizedTitle,
    status,
    status_raw: statusRaw,
    status_authority: statusAuthority,
    assignee_entity_id: hasAssigneeSignal ? input.assigneeEntityId : (existing?.assignee_entity_id ?? null),
    assignee_name: hasAssigneeSignal ? input.assigneeName : (existing?.assignee_name ?? null),
    proposed_assignee_name: hasAssigneeSignal ? input.proposedAssigneeName : (existing?.proposed_assignee_name ?? null),
    priority: input.item.priority,
    due_at: null,
    provenance: "summary",
    source_task_id: sourceTaskId,
    created_by_user_id: input.userId,
    status_changed_at: existing?.status_changed_at ?? now,
    completed_at: existing?.completed_at ?? null,
    valid_from: existing?.valid_from ?? now,
    valid_to: null,
    updated_at: now,
  };

  if (existing) {
    await db.updateTable("tasks").set(values).where("id", "=", existing.id).execute();
    return { taskId: existing.id, created: false };
  }

  const taskId = randomUUID();
  await db
    .insertInto("tasks")
    .values({
      id: taskId,
      ...values,
    })
    .execute();
  return { taskId, created: true };
}

async function findBriefCollationTarget(
  db: Kysely<DB>,
  input: { userId: string; parentEntityId: string | null; normalizedTitle: string },
): Promise<Pick<Selectable<TasksTable>, "id"> | undefined> {
  if (input.parentEntityId) {
    const structural = await db
      .selectFrom("tasks")
      .select("id")
      .where("provenance", "=", "structural")
      .where("valid_to", "is", null)
      .where("parent_entity_id", "=", input.parentEntityId)
      .where("normalized_title", "=", input.normalizedTitle)
      .executeTakeFirst();
    if (structural) return structural;
  }

  let summaryQuery = db
    .selectFrom("tasks")
    .select("id")
    .where("provenance", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("valid_to", "is", null);
  summaryQuery = input.parentEntityId
    ? summaryQuery.where((eb) =>
        eb.or([eb("parent_entity_id", "=", input.parentEntityId), eb("parent_entity_id", "is", null)]),
      )
    : summaryQuery.where("parent_entity_id", "is", null);
  if (input.parentEntityId) {
    return summaryQuery
      .orderBy(sql<number>`CASE
        WHEN parent_entity_id = ${input.parentEntityId} THEN 0
        WHEN parent_entity_id IS NULL THEN 1
        ELSE 2
      END`)
      .orderBy("updated_at", "desc")
      .orderBy("id", "asc")
      .executeTakeFirst();
  }
  return summaryQuery.orderBy("updated_at", "desc").orderBy("id", "asc").executeTakeFirst();
}

async function findReanchorableSummaryTask(
  db: Kysely<DB>,
  input: { userId: string; normalizedTitle: string },
): Promise<Selectable<TasksTable> | undefined> {
  return db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("parent_entity_id", "is", null)
    .where("valid_to", "is", null)
    .executeTakeFirst();
}

async function findSummaryTaskByResolvedParent(
  db: Kysely<DB>,
  input: { userId: string; parentEntityId: string; normalizedTitle: string },
): Promise<Selectable<TasksTable> | undefined> {
  return db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("parent_entity_id", "=", input.parentEntityId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("valid_to", "is", null)
    .executeTakeFirst();
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

type SummaryTaskParent = { id: string | null; parentSourceRef: string | null; parentName: string | null };
type SummaryTaskAssignee = { entityId: string | null; name: string | null; proposedName: string | null };
type TaskPersonCandidate = Pick<Selectable<EntitiesTable>, "id" | "name" | "aliases" | "metadata">;

async function resolveSummaryTaskParent(db: Kysely<DB>, item: AgentOutputItemInput): Promise<SummaryTaskParent | null> {
  const payload = item.structuredPayload ?? {};
  const parentEntityId = readPayloadString(payload, "parentEntityId");
  if (parentEntityId) {
    const row = await db
      .selectFrom("entities")
      .select(["id", "name"])
      .where("id", "=", parentEntityId)
      .where("source_type", "=", "project")
      .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
      .where(whereLiveEntity())
      .executeTakeFirst();
    if (row) return { id: row.id, parentSourceRef: null, parentName: row.name };
  }

  const parentSourceRef = readPayloadString(payload, "parentSourceRef");
  const parentName = readPayloadString(payload, "parentName");
  const parent = await findLiveProjectForTask(db, parentSourceRef, parentName);
  if (parent) return { id: parent.id, parentSourceRef, parentName: parent.name };

  const knowledgeParent = await resolveBriefTaskParent(db, item.knowledgeRefs.entityIds);
  if (knowledgeParent) return { id: knowledgeParent.id, parentSourceRef: null, parentName: null };
  if (parentSourceRef || parentName) return { id: null, parentSourceRef, parentName };
  return null;
}

async function resolveSummaryTaskAssignee(db: Kysely<DB>, item: AgentOutputItemInput): Promise<SummaryTaskAssignee> {
  const payload = item.structuredPayload ?? {};
  const assigneeName =
    readPayloadString(payload, "assigneeName") ??
    readPayloadString(payload, "ownerName") ??
    readPayloadString(payload, "owner");
  const assigneeEmail =
    readPayloadString(payload, "assigneeEmail") ??
    readPayloadString(payload, "ownerEmail") ??
    readPayloadString(payload, "email");
  const assigneeEntityId =
    readPayloadString(payload, "assigneeEntityId") ?? readPayloadString(payload, "ownerEntityId");
  const assigneeSlackUserId =
    readPayloadString(payload, "assigneeSlackUserId") ??
    readPayloadString(payload, "ownerSlackUserId") ??
    readPayloadString(payload, "slackUserId");
  const assigneeWhatsappNumber =
    readPayloadString(payload, "assigneeWhatsappNumber") ??
    readPayloadString(payload, "ownerWhatsappNumber") ??
    readPayloadString(payload, "whatsappNumber");

  const proposedName = assigneeName ?? normalizeAssigneeEmail(assigneeEmail);
  const eligibilityHints = { assigneeName, assigneeSlackUserId, assigneeWhatsappNumber };

  if (assigneeEntityId) {
    const row = await db
      .selectFrom("entities")
      .select(["id", "name", "aliases", "metadata"])
      .where("id", "=", assigneeEntityId)
      .where("source_type", "=", "person")
      .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
      .where(whereLiveEntity())
      .executeTakeFirst();
    if (row && (await isEligibleTaskAssignee(db, row, eligibilityHints))) {
      return { entityId: row.id, name: assigneeName ?? row.name, proposedName: null };
    }
    if (row) return { entityId: null, name: null, proposedName: proposedName ?? row.name };
  }

  if (assigneeEmail) {
    const matches = await findLivePeopleByEmailForTask(db, assigneeEmail);
    if (matches.length === 1 && (await isEligibleTaskAssignee(db, matches[0], eligibilityHints))) {
      return { entityId: matches[0].id, name: assigneeName ?? matches[0].name, proposedName: null };
    }
    return { entityId: null, name: null, proposedName };
  }

  if (assigneeName) {
    const matches = await findLivePeopleByNameForTask(db, assigneeName);
    if (matches.length === 1 && (await isEligibleTaskAssignee(db, matches[0], eligibilityHints))) {
      return { entityId: matches[0].id, name: assigneeName, proposedName: null };
    }
    return { entityId: null, name: null, proposedName: assigneeName };
  }

  return { entityId: null, name: null, proposedName };
}

async function promoteSummaryTaskEvidence(db: Kysely<DB>, taskId: string, item: AgentOutputItemInput): Promise<void> {
  const refs = item.knowledgeRefs;
  const edges = [
    ...refs.fileIds.map((refId) => ({ kind: "file", refId })),
    ...refs.entityIds.map((refId) => ({ kind: "entity", refId })),
    ...(refs.factIds ?? []).map((refId) => ({ kind: "fact", refId })),
    ...(refs.mentionIds ?? []).map((refId) => ({ kind: "mention", refId })),
    ...readMessageIds(item.structuredPayload).map((refId) => ({ kind: "conversation_message", refId })),
  ];
  for (const edge of edges) {
    await db
      .insertInto("task_evidence")
      .values({ task_id: taskId, kind: edge.kind, ref_id: edge.refId })
      .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
      .execute();
  }
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function findLivePeopleByNameForTask(db: Kysely<DB>, name: string): Promise<TaskPersonCandidate[]> {
  const nameKey = normalizeName(name);
  if (!nameKey) return [];
  const candidates = await listLivePeopleForTask(db);
  return candidates.filter((entity) => personNameKeys(entity).some((key) => key === nameKey));
}

async function findLivePeopleByEmailForTask(db: Kysely<DB>, rawEmail: string): Promise<TaskPersonCandidate[]> {
  const email = normalizeAssigneeEmail(rawEmail);
  if (!email) return [];
  const byContactPoint = await db
    .selectFrom("entity_contact_points")
    .innerJoin("entities", "entities.id", "entity_contact_points.entity_id")
    .select(["entities.id", "entities.name", "entities.aliases", "entities.metadata"])
    .where("entity_contact_points.kind", "=", "email")
    .where("entity_contact_points.value", "=", email)
    .where("entities.source_type", "=", "person")
    .where("entities.id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity())
    .execute();
  const byMetadataOrAlias = (await listLivePeopleForTask(db)).filter((entity) =>
    personEmailKeys(entity).some((key) => key === email),
  );
  return dedupePeopleForTask([...byContactPoint, ...byMetadataOrAlias]);
}

async function isEligibleTaskAssignee(
  db: Kysely<DB>,
  person: TaskPersonCandidate,
  hints: { assigneeName: string | null; assigneeSlackUserId: string | null; assigneeWhatsappNumber: string | null },
): Promise<boolean> {
  const emailUserIds = new Set(await findEligibleUserIdsByPersonEmails(db, person));
  const providerUserIds = new Set(
    await findEligibleUserIdsByProviderIds(db, hints.assigneeSlackUserId, hints.assigneeWhatsappNumber),
  );
  if (providerUserIds.size > 0) {
    const confirmed = [...emailUserIds].filter((id) => providerUserIds.has(id));
    return confirmed.length === 1;
  }
  return emailUserIds.size === 1;
}

async function findEligibleUserIdsByPersonEmails(db: Kysely<DB>, person: TaskPersonCandidate): Promise<string[]> {
  const contactRows = await db
    .selectFrom("entity_contact_points")
    .select("value")
    .where("entity_id", "=", person.id)
    .where("kind", "=", "email")
    .execute();
  const emails = [
    ...personEmailKeys(person),
    ...contactRows.flatMap((row) => {
      const email = normalizeAssigneeEmail(row.value);
      return email ? [email] : [];
    }),
  ];
  const normalized = [...new Set(emails)];
  if (normalized.length === 0) return [];
  const values = sql.join(
    normalized.map((email) => sql`${email}`),
    sql`,`,
  );
  const userRows = await sql<{ id: string }>`
    SELECT id
    FROM users
    WHERE type != 'external'
      AND email IS NOT NULL
      AND email_verified_at IS NOT NULL
      AND lower(trim(email)) IN (${values})
  `.execute(db);
  const providerRows = await sql<{ id: string }>`
    SELECT users.id AS id
    FROM user_provider_identities
    INNER JOIN users ON users.id = user_provider_identities.user_id
    WHERE users.type != 'external'
      AND user_provider_identities.provider_email IS NOT NULL
      AND lower(trim(user_provider_identities.provider_email)) IN (${values})
  `.execute(db);
  return [...new Set([...userRows.rows, ...providerRows.rows].map((row) => row.id))];
}

async function findEligibleUserIdsByProviderIds(
  db: Kysely<DB>,
  slackUserId: string | null,
  whatsappNumber: string | null,
): Promise<string[]> {
  const rows: Array<{ id: string }> = [];
  if (slackUserId) {
    rows.push(
      ...(await db
        .selectFrom("users")
        .select("id")
        .where("type", "!=", "external")
        .where("slack_user_id", "=", slackUserId)
        .execute()),
    );
  }
  if (whatsappNumber) {
    rows.push(
      ...(await db
        .selectFrom("users")
        .select("id")
        .where("type", "!=", "external")
        .where("whatsapp_number", "=", whatsappNumber)
        .execute()),
    );
  }
  return [...new Set(rows.map((row) => row.id))];
}

async function listLivePeopleForTask(db: Kysely<DB>): Promise<TaskPersonCandidate[]> {
  return db
    .selectFrom("entities")
    .select(["id", "name", "aliases", "metadata"])
    .where("source_type", "=", "person")
    .where("id", "!=", TEST_ACCOUNT_ENTITY_ID)
    .where(whereLiveEntity())
    .execute();
}

function dedupePeopleForTask(people: TaskPersonCandidate[]): TaskPersonCandidate[] {
  return [...new Map(people.map((person) => [person.id, person])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function readMessageIds(payload: AgentOutputItemInput["structuredPayload"]): string[] {
  const ids = payload?.messageIds;
  if (!Array.isArray(ids)) return [];
  return ids.flatMap((id) => {
    if (typeof id === "string" && id.trim().length > 0) return [id.trim()];
    if (typeof id === "number" && Number.isFinite(id)) return [String(id)];
    return [];
  });
}

function visibleTaskQuery(
  db: Kysely<DB>,
  viewer: FileViewer,
  opts: { userId?: string | null; assigneeEntityIds?: string[]; canReadAllLocalTasks?: boolean } = {},
) {
  const assigneeEntityIds = [...new Set(opts.assigneeEntityIds ?? [])].filter(Boolean);
  return db
    .selectFrom("tasks")
    .selectAll("tasks")
    .where("tasks.valid_to", "is", null)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("tasks.provenance", "=", "structural"),
          eb.exists(sql<boolean>`(
            SELECT 1 FROM task_evidence
            INNER JOIN indexed_files ON indexed_files.id = task_evidence.ref_id
            WHERE task_evidence.task_id = tasks.id
              AND task_evidence.kind = 'file'
              AND ${fileVisibilityPredicate(viewer)}
          )`),
        ]),
        ...(opts.userId
          ? [
              eb.and([
                eb("tasks.created_by_user_id", "=", opts.userId),
                eb("tasks.status_authority", "=", "local"),
                eb("tasks.provenance", "in", ["brief", "summary"]),
              ]),
            ]
          : []),
        ...(assigneeEntityIds.length > 0
          ? [
              eb.and([
                eb("tasks.assignee_entity_id", "in", assigneeEntityIds),
                eb("tasks.status_authority", "=", "local"),
                eb("tasks.provenance", "in", ["brief", "summary"]),
              ]),
            ]
          : []),
        ...(opts.canReadAllLocalTasks
          ? [eb.and([eb("tasks.status_authority", "=", "local"), eb("tasks.provenance", "in", ["brief", "summary"])])]
          : []),
      ]),
    );
}

function canEditLocalTask(
  task: Selectable<TasksTable>,
  userId: string,
  assigneeEntityIds: string[],
  canEditAllLocalTasks = false,
): boolean {
  if (canEditAllLocalTasks) return true;
  if (task.created_by_user_id === userId) return true;
  return Boolean(task.assignee_entity_id && assigneeEntityIds.includes(task.assignee_entity_id));
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
  const exactMatches = candidates.filter((entity) => projectNameKeys(entity).some((key) => key === nameKey));
  if (exactMatches.length > 0) return exactMatches.length === 1 ? exactMatches[0] : null;

  const qualifiedMatches = candidates.filter((entity) =>
    projectNameKeys(entity).some((key) => isQualifiedProjectNameMatch(key, nameKey)),
  );
  return qualifiedMatches.length === 1 ? qualifiedMatches[0] : null;
}

function projectNameKeys(entity: { name: string; aliases: string | null }): string[] {
  return [...new Set([entity.name, ...parseEntityAliases(entity.aliases)].map(normalizeName).filter(Boolean))];
}

function personNameKeys(entity: TaskPersonCandidate): string[] {
  return [...new Set([entity.name, ...parseEntityAliases(entity.aliases)].map(normalizeName).filter(Boolean))];
}

function personEmailKeys(entity: TaskPersonCandidate): string[] {
  const keys = [...parseEntityAliases(entity.aliases), readMetadataEmail(entity.metadata)]
    .flatMap((value) => {
      const email = normalizeAssigneeEmail(value);
      return email ? [email] : [];
    })
    .filter(Boolean);
  return [...new Set(keys)];
}

function parseEntityAliases(aliases: string | null): string[] {
  if (!aliases) return [];
  try {
    const parsed: unknown = JSON.parse(aliases);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function readMetadataEmail(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object") return null;
    const email = (parsed as { email?: unknown }).email;
    return typeof email === "string" && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

function normalizeAssigneeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeContactPointValue("email", value);
  } catch {
    return null;
  }
}

function isQualifiedProjectNameMatch(projectKey: string, parentKey: string): boolean {
  const parentTokens = parentKey.split(" ").filter(Boolean);
  const projectTokens = projectKey.split(" ").filter(Boolean);
  if (parentTokens.length < 2 || projectTokens.length <= parentTokens.length) return false;
  return parentTokens.every((token, index) => projectTokens[index] === token);
}
