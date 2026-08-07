import { createHash, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { fileAccessFilterSql } from "../../connectors/search";
import type { AccessPrincipalInput } from "../../connectors/types";
import type { DB, EntitiesTable, TasksTable } from "../schema";
import type { AgentKnowledgeRefs, AgentOutputItemInput } from "./agent-outputs";
import type { FileViewer } from "./connectors";
import { fileVisibilityPredicate } from "./connectors";
import { normalizeContactPointValue, whereLiveEntity } from "./entities";
import { type TaskActivityChanges, type TaskActivitySurface, createTaskActivityRepository } from "./task-activity";

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

export interface TaskAccessOptions {
  viewer: FileViewer;
  userId?: string | null;
  assigneeEntityIds?: string[];
  canReadAllLocalTasks?: boolean;
}

export interface PromoteBriefTaskInput {
  userId: string;
  todo: AgentOutputItemInput;
  knowledgeRefs: AgentKnowledgeRefs;
}

export type PromoteBriefTaskResult =
  | { status: "skipped"; reason: "missing_file_id" }
  | { status: "skipped"; reason: "ineligible_assignee" }
  | { status: "collated"; taskId: string; evidenceFileIds: string[] }
  | {
      status: "upserted";
      taskId: string;
      created: boolean;
      changes: TaskActivityChanges;
      evidenceFileIds: string[];
    };

export interface PromoteSummaryTaskInput {
  userId: string;
  item: AgentOutputItemInput;
  sourceAnchor?: ConversationTaskSourceAnchor | null;
  originOutputId?: string | null;
  dueAt?: string | null;
}

export interface ConversationTaskSourceAnchor {
  platform: "slack" | "whatsapp";
  conversationId: number;
  providerThreadId: string | null;
  key: string;
}

export type PromoteSummaryTaskResult =
  | { status: "collated"; taskId: string }
  | { status: "upserted"; taskId: string; created: boolean };

export interface UpdateLocalTaskStatusInput {
  taskId: string;
  userId: string;
  assigneeEntityIds?: string[];
  canEditAllLocalTasks?: boolean;
  status: TaskStatus;
  surface?: TaskActivitySurface;
}

export interface ReanchorNullParentTasksResult {
  count: number;
  taskIds: string[];
  indexedFileIds: string[];
  parentEntityIds: string[];
}

export interface LoadOpenDurableTasksForBriefOptions {
  userId: string;
  userPrincipals: AccessPrincipalInput[];
  slackEntitySyncEnabled?: boolean;
  assigneeEntityIds?: string[];
  activeSummarySourceKeys?: string[];
  activeSummaryConversationIds?: number[];
  limit?: number;
}

export interface LoadSummaryTasksForBriefOptions {
  userId: string;
  since: string;
  activeSummarySourceKeys?: string[];
  activeSummaryConversationIds?: number[];
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
      const assignee = await resolveSummaryTaskAssignee(db, input.todo);
      const existing = await findBriefCollationTarget(db, {
        userId: input.userId,
        parentEntityId: parent?.id ?? null,
        normalizedTitle,
        owner: summaryTaskOwnerIdentity({
          assigneeEntityId: assignee.entityId,
          assigneeName: assignee.name,
          proposedAssigneeName: assignee.proposedName,
        }),
      });
      if (existing) {
        const evidenceFileIds = await promoteBriefTaskEvidence(db, existing.id, input.knowledgeRefs);
        return { status: "collated", taskId: existing.id, evidenceFileIds };
      }

      if (input.knowledgeRefs.fileIds.length === 0) return { status: "skipped", reason: "missing_file_id" };

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
      const evidenceFileIds = await promoteBriefTaskEvidence(db, result.taskId, input.knowledgeRefs);
      return { status: "upserted", ...result, evidenceFileIds };
    },

    async promoteSummaryTask(input: PromoteSummaryTaskInput): Promise<PromoteSummaryTaskResult> {
      const parent = await resolveSummaryTaskParent(db, input.item);
      const parentKey = parent?.id ?? parent?.parentSourceRef ?? parent?.parentName ?? "global";
      const normalizedTitle = normalizeName(input.item.title);

      if (parent?.id && !input.sourceAnchor) {
        const structural = await db
          .selectFrom("tasks")
          .select("id")
          .where("provenance", "=", "structural")
          .where("valid_to", "is", null)
          .where("status", "in", ["open", "in_progress"])
          .where("parent_entity_id", "=", parent.id)
          .where("normalized_title", "=", normalizedTitle)
          .executeTakeFirst();
        if (structural) {
          await promoteSummaryTaskEvidence(db, structural.id, input.item);
          return { status: "collated", taskId: structural.id };
        }
      }

      const assignee = await resolveSummaryTaskAssignee(db, input.item);

      const result = await upsertSummaryTask(db, {
        userId: input.userId,
        parentEntityId: parent?.id ?? null,
        parentSourceRef: parent?.parentSourceRef ?? null,
        parentName: parent?.parentName ?? null,
        parentKey,
        assigneeEntityId: assignee.entityId,
        assigneeName: assignee.name,
        proposedAssigneeName: assignee.proposedName,
        item: input.item,
        normalizedTitle,
        sourceAnchor: input.sourceAnchor ?? null,
        originOutputId: input.originOutputId ?? null,
        dueAt: input.dueAt ?? null,
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

    async listVisibleTasksByIds(taskIds: string[], opts: TaskAccessOptions): Promise<Selectable<TasksTable>[]> {
      const ids = [...new Set(taskIds)].filter(Boolean);
      if (ids.length === 0) return [];
      if (ids.length > 100) throw new Error("Task visibility batch exceeds 100 ids.");
      return visibleTaskQuery(db, opts.viewer, {
        userId: opts.userId,
        assigneeEntityIds: opts.assigneeEntityIds,
        canReadAllLocalTasks: opts.canReadAllLocalTasks === true,
      })
        .where("tasks.id", "in", ids)
        .limit(ids.length)
        .execute();
    },

    async loadOpenDurableTasksForBrief(opts: LoadOpenDurableTasksForBriefOptions): Promise<Selectable<TasksTable>[]> {
      const visibleFileEvidence =
        opts.userPrincipals.length === 0
          ? sql<boolean>`false`
          : sql<boolean>`EXISTS (
            SELECT 1 FROM task_evidence
            INNER JOIN indexed_files ON indexed_files.id = task_evidence.ref_id
            WHERE task_evidence.task_id = tasks.id
              AND task_evidence.kind = 'file'
              AND ${fileAccessFilterSql(opts.userPrincipals, opts.slackEntitySyncEnabled ?? true)}
          )`;
      const assigneeEntityIds = [...new Set(opts.assigneeEntityIds ?? [])].filter(Boolean);
      return db
        .selectFrom("tasks")
        .selectAll("tasks")
        .where("tasks.valid_to", "is", null)
        .where("tasks.status", "in", ["open", "in_progress"])
        .where((eb) =>
          eb.or([
            eb.and([eb("tasks.provenance", "=", "structural"), visibleFileEvidence]),
            eb.and([
              eb("tasks.provenance", "in", ["brief", "summary"]),
              eb.or([
                eb("tasks.created_by_user_id", "=", opts.userId),
                ...(assigneeEntityIds.length > 0 ? [eb("tasks.assignee_entity_id", "in", assigneeEntityIds)] : []),
              ]),
            ]),
          ]),
        )
        .orderBy("tasks.updated_at", "desc")
        .limit(opts.limit ?? 50)
        .execute();
    },

    async loadSummaryTasksForBrief(opts: LoadSummaryTasksForBriefOptions): Promise<Selectable<TasksTable>[]> {
      const activeSummarySourceKeys = [...new Set(opts.activeSummarySourceKeys ?? [])].filter(Boolean);
      const activeSummaryConversationIds = [...new Set(opts.activeSummaryConversationIds ?? [])];
      const hasActiveSummaryScope =
        opts.activeSummarySourceKeys !== undefined || opts.activeSummaryConversationIds !== undefined;
      let query = db
        .selectFrom("tasks")
        .leftJoin("agent_outputs as summary_origin", "summary_origin.id", "tasks.origin_agent_output_id")
        .selectAll("tasks")
        .where("tasks.valid_to", "is", null)
        .where("tasks.created_by_user_id", "=", opts.userId)
        .where("tasks.provenance", "=", "summary")
        .where("tasks.updated_at", ">=", opts.since)
        .where("tasks.status", "in", ["open", "in_progress", "done", "dropped"]);
      if (hasActiveSummaryScope) {
        query = query.where((eb) =>
          activeSummarySourceKeys.length > 0 || activeSummaryConversationIds.length > 0
            ? eb.or([
                ...(activeSummarySourceKeys.length > 0
                  ? [eb("summary_origin.source_key", "in", activeSummarySourceKeys)]
                  : []),
                ...(activeSummaryConversationIds.length > 0
                  ? [eb("tasks.source_conversation_id", "in", activeSummaryConversationIds)]
                  : []),
              ])
            : sql<boolean>`false`,
        );
      }
      return query
        .orderBy(sql<number>`CASE
          WHEN tasks.status = 'open' THEN 0
          WHEN tasks.status = 'in_progress' THEN 1
          WHEN tasks.status = 'done' THEN 2
          WHEN tasks.status = 'dropped' THEN 3
          ELSE 4
        END`)
        .orderBy("tasks.updated_at", "desc")
        .orderBy("tasks.id", "asc")
        .limit(opts.limit ?? 50)
        .execute();
    },

    async updateLocalTaskStatus(input: UpdateLocalTaskStatusInput): Promise<Selectable<TasksTable> | null> {
      const mutationId = randomUUID();
      return db.transaction().execute(async (trx) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const existing = await trx
            .selectFrom("tasks")
            .selectAll()
            .where("id", "=", input.taskId)
            .where("valid_to", "is", null)
            .executeTakeFirst();
          if (
            !existing ||
            !canEditLocalTask(
              existing,
              input.userId,
              input.assigneeEntityIds ?? [],
              input.canEditAllLocalTasks === true,
            ) ||
            existing.status_authority !== "local" ||
            (existing.provenance !== "brief" && existing.provenance !== "summary")
          ) {
            return null;
          }
          if (existing.status === input.status) return existing;

          const previousStatusChangedAt = Date.parse(existing.status_changed_at ?? "");
          const now = new Date(
            Number.isFinite(previousStatusChangedAt) ? Math.max(Date.now(), previousStatusChangedAt + 1) : Date.now(),
          ).toISOString();
          let update = trx
            .updateTable("tasks")
            .set({
              status: input.status,
              status_raw: input.status,
              status_authority: "local",
              status_changed_at: now,
              completed_at: input.status === "done" ? now : null,
              updated_at: now,
            })
            .where("id", "=", input.taskId)
            .where("valid_to", "is", null)
            .where("status", "=", existing.status)
            .where("status_authority", "=", "local")
            .where("provenance", "in", ["brief", "summary"]);
          if (input.canEditAllLocalTasks !== true) {
            update = update.where((eb) =>
              eb.or([
                eb("created_by_user_id", "=", input.userId),
                ...((input.assigneeEntityIds?.length ?? 0) > 0
                  ? [eb("assignee_entity_id", "in", input.assigneeEntityIds ?? [])]
                  : []),
              ]),
            );
          }
          const result = await update.executeTakeFirst();
          if (Number(result.numUpdatedRows ?? 0) === 0) continue;

          await createTaskActivityRepository(trx).append({
            taskId: existing.id,
            eventKind: "status_changed",
            actorType: "user",
            actorUserId: input.userId,
            surface: input.surface ?? "web",
            changes: { status: { before: existing.status, after: input.status } },
            identityParts: [existing.id, mutationId],
            occurredAt: now,
          });
          return trx.selectFrom("tasks").selectAll().where("id", "=", input.taskId).executeTakeFirstOrThrow();
        }

        return null;
      });
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
    assigneeEntityId: string;
    assigneeName: string;
    todo: AgentOutputItemInput;
    normalizedTitle: string;
  },
): Promise<{ taskId: string; created: boolean; changes: TaskActivityChanges }> {
  const owner = summaryTaskOwnerIdentity({
    assigneeEntityId: input.assigneeEntityId,
    assigneeName: input.assigneeName,
    proposedAssigneeName: null,
  });
  const baseSourceTaskId = createHash("sha256")
    .update([input.userId, input.parentKey, owner.key, input.normalizedTitle].join(BRIEF_TASK_ID_SEPARATOR))
    .digest("hex");
  const now = new Date().toISOString();
  let existing = await db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "brief")
    .where("source_task_id", "=", baseSourceTaskId)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .executeTakeFirst();
  if (!existing) {
    existing = await findActiveBriefTaskByIdentity(db, {
      userId: input.userId,
      parentEntityId: input.parentEntityId,
      normalizedTitle: input.normalizedTitle,
      owner,
    });
  }
  const sourceTaskId = existing?.source_task_id ?? (await allocateRecurringSourceTaskId(db, "brief", baseSourceTaskId));
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
  const changes: TaskActivityChanges = existing
    ? Object.fromEntries(
        [
          ["title", existing.title, values.title],
          ["priority", existing.priority, values.priority],
          ["parentEntityId", existing.parent_entity_id, values.parent_entity_id],
          ["assigneeEntityId", existing.assignee_entity_id, values.assignee_entity_id],
          ["assigneeName", existing.assignee_name, values.assignee_name],
        ].flatMap(([field, before, after]) => (before === after ? [] : [[field, { before, after }]])),
      )
    : {};

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
  return { taskId: row.id, created: !existing, changes };
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
    sourceAnchor: ConversationTaskSourceAnchor | null;
    originOutputId: string | null;
    dueAt: string | null;
  },
): Promise<{ taskId: string; created: boolean }> {
  const owner = summaryTaskOwnerIdentity(input);
  const identityParts = input.sourceAnchor
    ? [input.userId, input.sourceAnchor.key, input.parentKey, owner.key, input.normalizedTitle]
    : [input.userId, input.parentKey, owner.key, input.normalizedTitle];
  const baseSourceTaskId = createHash("sha256").update(identityParts.join(SUMMARY_TASK_ID_SEPARATOR)).digest("hex");
  const now = new Date().toISOString();
  let existing = await db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "summary")
    .where("source_task_id", "=", baseSourceTaskId)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .executeTakeFirst();
  if (!existing) {
    existing = await findActiveSummaryTaskByIdentity(db, {
      userId: input.userId,
      parentEntityId: input.parentEntityId,
      parentSourceRef: input.parentSourceRef,
      parentName: input.parentName,
      normalizedTitle: input.normalizedTitle,
      sourceAnchorKey: input.sourceAnchor?.key ?? null,
      owner,
    });
  }
  if (!existing && input.parentEntityId) {
    existing = await findReanchorableSummaryTask(db, {
      userId: input.userId,
      normalizedTitle: input.normalizedTitle,
      sourceAnchorKey: input.sourceAnchor?.key ?? null,
      owner,
    });
  }
  const sourceTaskId =
    existing?.source_task_id ?? (await allocateRecurringSourceTaskId(db, "summary", baseSourceTaskId));
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
    due_at: input.dueAt ?? existing?.due_at ?? null,
    provenance: "summary",
    source_task_id: sourceTaskId,
    created_by_user_id: input.userId,
    status_changed_at: existing?.status_changed_at ?? now,
    completed_at: existing?.completed_at ?? null,
    valid_from: existing?.valid_from ?? now,
    valid_to: null,
    source_platform: input.sourceAnchor?.platform ?? existing?.source_platform ?? null,
    source_conversation_id: input.sourceAnchor?.conversationId ?? existing?.source_conversation_id ?? null,
    source_provider_thread_id: input.sourceAnchor?.providerThreadId ?? existing?.source_provider_thread_id ?? null,
    source_anchor_key: input.sourceAnchor?.key ?? existing?.source_anchor_key ?? null,
    origin_agent_output_id: input.originOutputId ?? existing?.origin_agent_output_id ?? null,
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
  input: {
    userId: string;
    parentEntityId: string | null;
    normalizedTitle: string;
    owner: SummaryTaskOwnerIdentity;
  },
): Promise<Pick<Selectable<TasksTable>, "id"> | undefined> {
  if (input.parentEntityId) {
    const structural = await db
      .selectFrom("tasks")
      .select("id")
      .where("provenance", "=", "structural")
      .where("valid_to", "is", null)
      .where("status", "in", ["open", "in_progress"])
      .where("parent_entity_id", "=", input.parentEntityId)
      .where("normalized_title", "=", input.normalizedTitle)
      .executeTakeFirst();
    if (structural) return structural;
  }

  let summaryQuery = db
    .selectFrom("tasks")
    .selectAll()
    .where("provenance", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"]);
  summaryQuery = input.parentEntityId
    ? summaryQuery.where((eb) =>
        eb.or([eb("parent_entity_id", "=", input.parentEntityId), eb("parent_entity_id", "is", null)]),
      )
    : summaryQuery.where("parent_entity_id", "is", null);
  if (input.parentEntityId) {
    const rows = await summaryQuery
      .orderBy(sql<number>`CASE
        WHEN parent_entity_id = ${input.parentEntityId} THEN 0
        WHEN parent_entity_id IS NULL THEN 1
        ELSE 2
      END`)
      .orderBy("updated_at", "desc")
      .orderBy("id", "asc")
      .execute();
    return rows.find((task) => summaryTaskOwnerMatches(task, input.owner));
  }
  const rows = await summaryQuery.orderBy("updated_at", "desc").orderBy("id", "asc").execute();
  return rows.find((task) => summaryTaskOwnerMatches(task, input.owner));
}

async function findActiveBriefTaskByIdentity(
  db: Kysely<DB>,
  input: {
    userId: string;
    parentEntityId: string | null;
    normalizedTitle: string;
    owner: SummaryTaskOwnerIdentity;
  },
): Promise<Selectable<TasksTable> | undefined> {
  let query = db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "brief")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"]);
  query = input.parentEntityId
    ? query.where("parent_entity_id", "=", input.parentEntityId)
    : query.where("parent_entity_id", "is", null);
  const rows = await query.orderBy("updated_at", "desc").orderBy("id", "asc").execute();
  return rows.find((task) => summaryTaskOwnerMatches(task, input.owner));
}

async function findReanchorableSummaryTask(
  db: Kysely<DB>,
  input: { userId: string; normalizedTitle: string; sourceAnchorKey: string | null; owner: SummaryTaskOwnerIdentity },
): Promise<Selectable<TasksTable> | undefined> {
  let query = db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("parent_entity_id", "is", null)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"]);
  query = input.sourceAnchorKey
    ? query.where("source_anchor_key", "=", input.sourceAnchorKey)
    : query.where("source_anchor_key", "is", null);
  const rows = await query.orderBy("updated_at", "desc").orderBy("id", "asc").execute();
  return rows.find((task) => summaryTaskOwnerMatches(task, input.owner));
}

async function findActiveSummaryTaskByIdentity(
  db: Kysely<DB>,
  input: {
    userId: string;
    parentEntityId: string | null;
    parentSourceRef: string | null;
    parentName: string | null;
    normalizedTitle: string;
    sourceAnchorKey: string | null;
    owner: SummaryTaskOwnerIdentity;
  },
): Promise<Selectable<TasksTable> | undefined> {
  let query = db
    .selectFrom("tasks")
    .selectAll()
    .where("source", "=", "summary")
    .where("created_by_user_id", "=", input.userId)
    .where("normalized_title", "=", input.normalizedTitle)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"]);
  if (input.parentEntityId) {
    query = query.where("parent_entity_id", "=", input.parentEntityId);
  } else {
    query = query.where("parent_entity_id", "is", null);
    query = input.parentSourceRef
      ? query.where("parent_source_ref", "=", input.parentSourceRef)
      : query.where("parent_source_ref", "is", null);
    query = input.parentName
      ? query.where("parent_name", "=", input.parentName)
      : query.where("parent_name", "is", null);
  }
  query = input.sourceAnchorKey
    ? query.where("source_anchor_key", "=", input.sourceAnchorKey)
    : query.where("source_anchor_key", "is", null);
  const rows = await query.orderBy("updated_at", "desc").orderBy("id", "asc").execute();
  return rows.find((task) => summaryTaskOwnerMatches(task, input.owner));
}

interface SummaryTaskOwnerIdentity {
  key: string;
  entityId: string | null;
  nameKey: string | null;
}

function summaryTaskOwnerIdentity(input: {
  assigneeEntityId: string | null;
  assigneeName: string | null;
  proposedAssigneeName: string | null;
}): SummaryTaskOwnerIdentity {
  const name = input.proposedAssigneeName ?? input.assigneeName;
  const nameKey = name ? normalizeName(name) : null;
  return {
    key: input.assigneeEntityId ? `entity:${input.assigneeEntityId}` : nameKey ? `name:${nameKey}` : "unassigned",
    entityId: input.assigneeEntityId,
    nameKey,
  };
}

function summaryTaskOwnerMatches(task: Selectable<TasksTable>, owner: SummaryTaskOwnerIdentity): boolean {
  const taskOwner = summaryTaskOwnerIdentity({
    assigneeEntityId: task.assignee_entity_id,
    assigneeName: task.assignee_name,
    proposedAssigneeName: task.proposed_assignee_name,
  });
  if (taskOwner.key === "unassigned") return true;
  if (owner.key === "unassigned") return false;
  if (taskOwner.entityId && owner.entityId) return taskOwner.entityId === owner.entityId;
  if (taskOwner.nameKey && owner.nameKey) return taskOwner.nameKey === owner.nameKey;
  return taskOwner.key === owner.key;
}

async function allocateRecurringSourceTaskId(
  db: Kysely<DB>,
  source: string,
  baseSourceTaskId: string,
): Promise<string> {
  const rows = await db
    .selectFrom("tasks")
    .select("source_task_id")
    .where("source", "=", source)
    .where((eb) =>
      eb.or([eb("source_task_id", "=", baseSourceTaskId), eb("source_task_id", "like", `${baseSourceTaskId}:%`)]),
    )
    .execute();
  if (rows.length === 0) return baseSourceTaskId;
  const used = new Set(rows.map((row) => row.source_task_id));
  for (let recurrence = 1; ; recurrence += 1) {
    const candidate = `${baseSourceTaskId}:${recurrence}`;
    if (!used.has(candidate)) return candidate;
  }
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

async function promoteBriefTaskEvidence(db: Kysely<DB>, taskId: string, refs: AgentKnowledgeRefs): Promise<string[]> {
  const edges = [
    ...refs.fileIds.map((refId) => ({ kind: "file", refId })),
    ...refs.entityIds.map((refId) => ({ kind: "entity", refId })),
    ...(refs.factIds ?? []).map((refId) => ({ kind: "fact", refId })),
    ...(refs.mentionIds ?? []).map((refId) => ({ kind: "mention", refId })),
  ];
  const insertedFileIds: string[] = [];
  for (const edge of edges) {
    const inserted = await db
      .insertInto("task_evidence")
      .values({ task_id: taskId, kind: edge.kind, ref_id: edge.refId })
      .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
      .returning("ref_id")
      .executeTakeFirst();
    if (inserted && edge.kind === "file") insertedFileIds.push(inserted.ref_id);
  }
  return insertedFileIds;
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
