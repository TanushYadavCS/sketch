import { createHash, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import type { DB, TasksTable } from "../schema";
import type { AgentOutputItemInput } from "./agent-outputs";
import { type TaskActivitySurface, createTaskActivityRepository } from "./task-activity";
import { type ConversationTaskSourceAnchor, type TaskStatus, createTaskRepository } from "./tasks";

const RECOMMENDATION_EXPIRY_MS = 48 * 60 * 60 * 1000;
const RECOMMENDATION_DELIVERY_LIMIT = 3;
const TASK_MEMORY_LIMIT = 50;
const TASK_MEMORY_EVIDENCE_LIMIT = 20;
const REMINDER_PENDING_LIMIT = 50;
const REMINDER_PROPOSAL_LIMIT = 25;
const REMINDER_UNTRACKED_LIMIT = 25;
const REMINDER_SUPPRESSION_LIMIT = 100;
const REVIEW_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOMMENDATION_COLLISION_IDENTITY_KIND = "completion_recommendation_collision_identity";

class TaskBecameUneditableError extends Error {}
class ReviewAuthorizationChangedError extends Error {
  constructor(readonly status: "stale" | "unauthorized") {
    super(status);
  }
}

export interface TaskMemoryItem {
  taskId: string;
  title: string;
  status: "open" | "in_progress";
  parentEntityId: string | null;
  parentName: string | null;
  assigneeEntityId: string | null;
  assigneeName: string | null;
  proposedAssigneeName: string | null;
  sourceAnchor: ConversationTaskSourceAnchor;
  evidenceMessageIds: number[];
  statusChangedAt: string | null;
}

interface TaskMatchMetadata {
  parentEntityId?: string | null;
  assigneeEntityId?: string | null;
  assigneeName?: string | null;
  proposedAssigneeName?: string | null;
  dueAt?: string | null;
}

export type SummarizerTaskChange =
  | {
      kind: "new";
      evidenceMessageIds: number[];
      item: AgentOutputItemInput;
    }
  | {
      kind: "changed";
      taskId: string;
      evidenceMessageIds: number[];
      metadata: TaskMatchMetadata & {
        title?: string;
        priority?: string | null;
      };
    }
  | {
      kind: "resolved";
      taskId: string;
      evidenceMessageIds: number[];
      rationale: string;
      metadata?: TaskMatchMetadata;
    };

type EvidenceInvalidReason =
  | "missing_evidence"
  | "outside_allowed_window"
  | "unsupported_platform"
  | "ambiguous_source_anchor";

type NormalizedEvidenceResult =
  | {
      status: "ok";
      anchor: ConversationTaskSourceAnchor;
      messageIds: number[];
    }
  | { status: "invalid"; reason: EvidenceInvalidReason };

type ApplyRejectedReason =
  | EvidenceInvalidReason
  | "task_not_in_memory"
  | "match_outside_scope"
  | "invalid_metadata"
  | "task_not_editable"
  | "route_source_changed"
  | "application_failed";

export type TaskChangeApplyResult =
  | {
      status: "applied";
      kind: "new" | "changed";
      taskId: string;
    }
  | {
      status: "applied";
      kind: "resolved";
      taskId: string;
      recommendation: {
        id: string;
        code: string;
        state: string;
        created: boolean;
      };
    }
  | {
      status: "rejected";
      kind: SummarizerTaskChange["kind"];
      reason: ApplyRejectedReason;
    };

export interface LegacyFollowupCandidate {
  title: string;
  sourceKey?: string | null;
  sourceAnchorKey?: string | null;
}

interface EvidenceRow {
  id: number;
  conversation_id: number;
  provider_thread_id: string | null;
  is_thread_reply: number;
  platform: string;
}

export function createConversationFollowupsRepository(db: Kysely<DB>) {
  return {
    deriveNormalizedEvidence(input: {
      messageIds: number[];
      allowedMessageIds: number[];
      allowedConversationIds: number[];
    }): Promise<NormalizedEvidenceResult> {
      return deriveNormalizedEvidence(db, input);
    },

    async loadTaskMemory(input: {
      userId: string;
      conversationIds: number[];
      assigneeEntityIds?: string[];
      parentEntityIds?: string[];
      limit?: number;
    }): Promise<TaskMemoryItem[]> {
      const limit = Math.max(1, Math.min(input.limit ?? TASK_MEMORY_LIMIT, TASK_MEMORY_LIMIT));
      const conversationIds = [...new Set(input.conversationIds)];
      const assigneeEntityIds = [...new Set(input.assigneeEntityIds ?? [])].filter(Boolean);
      const parentEntityIds = [...new Set(input.parentEntityIds ?? [])].filter(Boolean);
      const tasks = await db
        .selectFrom("tasks")
        .selectAll()
        .where("provenance", "=", "summary")
        .where("valid_to", "is", null)
        .where("status", "in", ["open", "in_progress"])
        .where("source_anchor_key", "is not", null)
        .where((eb) =>
          eb.or([
            eb("created_by_user_id", "=", input.userId),
            ...(conversationIds.length > 0 ? [eb("source_conversation_id", "in", conversationIds)] : []),
            ...(assigneeEntityIds.length > 0 ? [eb("assignee_entity_id", "in", assigneeEntityIds)] : []),
            ...(parentEntityIds.length > 0 ? [eb("parent_entity_id", "in", parentEntityIds)] : []),
          ]),
        )
        .orderBy("updated_at", "desc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      if (tasks.length === 0) return [];
      const evidence = (
        await Promise.all(
          tasks.map((task) =>
            db
              .selectFrom("task_message_evidence")
              .select(["task_id", "conversation_message_id"])
              .where("task_id", "=", task.id)
              .orderBy("conversation_message_id", "asc")
              .limit(TASK_MEMORY_EVIDENCE_LIMIT)
              .execute(),
          ),
        )
      ).flat();
      const evidenceByTask = new Map<string, number[]>();
      for (const row of evidence) {
        const ids = evidenceByTask.get(row.task_id) ?? [];
        ids.push(row.conversation_message_id);
        evidenceByTask.set(row.task_id, ids);
      }
      return tasks.flatMap((task): TaskMemoryItem[] => {
        const anchor = taskAnchor(task);
        if (!anchor || (task.status !== "open" && task.status !== "in_progress")) return [];
        return [
          {
            taskId: task.id,
            title: task.title,
            status: task.status,
            parentEntityId: task.parent_entity_id,
            parentName: task.parent_name,
            assigneeEntityId: task.assignee_entity_id,
            assigneeName: task.assignee_name,
            proposedAssigneeName: task.proposed_assignee_name,
            sourceAnchor: anchor,
            evidenceMessageIds: evidenceByTask.get(task.id) ?? [],
            statusChangedAt: task.status_changed_at,
          },
        ];
      });
    },

    async applyTaskChanges(input: {
      userId: string;
      outputId?: string | null;
      taskMemory: TaskMemoryItem[];
      authorizedAssigneeEntityIds?: string[];
      allowedMessageIds: number[];
      allowedConversationIds: number[];
      changes: SummarizerTaskChange[];
      routeGuard?: {
        agentKey: string;
        routeId: string;
        sourceKey: string;
      };
      now: string;
    }): Promise<TaskChangeApplyResult[]> {
      const results: TaskChangeApplyResult[] = [];
      for (const change of input.changes) {
        try {
          results.push(
            await db.transaction().execute(async (trx) => {
              if (
                input.routeGuard &&
                !(await claimCurrentRoute(trx, {
                  ...input.routeGuard,
                  userId: input.userId,
                  now: input.now,
                }))
              ) {
                return { status: "rejected", kind: change.kind, reason: "route_source_changed" as const };
              }
              return applyTaskChange(trx, {
                ...input,
                change,
              });
            }),
          );
        } catch (error) {
          if (error instanceof TaskBecameUneditableError) {
            results.push({ status: "rejected", kind: change.kind, reason: "task_not_editable" });
            continue;
          }
          if (change.kind === "resolved" && isUniqueConstraintError(error)) {
            const recovered = await recoverCompletionRecommendationCollision(db, {
              ...input,
              change,
            }).catch(() => null);
            if (recovered) {
              results.push(recovered);
              continue;
            }
          }
          results.push({ status: "rejected", kind: change.kind, reason: "application_failed" });
        }
      }
      return results;
    },

    async queryPersonalReminders(input: {
      userId: string;
      assigneeEntityIds: string[];
      activeSourceKeys?: string[];
      legacyCandidates?: LegacyFollowupCandidate[];
      suppressedLegacyCandidates?: LegacyFollowupCandidate[];
      now: string;
    }) {
      const legacyCandidates = input.legacyCandidates ?? [];
      const suppressedLegacyCandidates = input.suppressedLegacyCandidates ?? [];
      try {
        await expireRecommendations(db, input.now);
        const assigneeIds = [...new Set(input.assigneeEntityIds)].filter(Boolean);
        const activeSourceKeys = input.activeSourceKeys ? [...new Set(input.activeSourceKeys)] : null;
        const activeConversationIds = activeSourceKeys
          ? [...(await resolveActiveConversationIds(db, activeSourceKeys))]
          : [];
        const taskScope = () => {
          let query = db
            .selectFrom("tasks as t")
            .leftJoin("agent_outputs as o", "o.id", "t.origin_agent_output_id")
            .where("t.valid_to", "is", null)
            .where("t.provenance", "=", "summary")
            .where("t.source_anchor_key", "is not", null)
            .where((eb) =>
              eb.or([
                eb("t.created_by_user_id", "=", input.userId),
                ...(assigneeIds.length > 0 ? [eb("t.assignee_entity_id", "in", assigneeIds)] : []),
              ]),
            );
          if (activeSourceKeys) {
            query = query.where((eb) => {
              const predicates = [
                ...(assigneeIds.length > 0
                  ? [
                      eb.and([
                        eb.or([eb("t.created_by_user_id", "is", null), eb("t.created_by_user_id", "!=", input.userId)]),
                        eb("t.assignee_entity_id", "in", assigneeIds),
                      ]),
                    ]
                  : []),
                ...(activeSourceKeys.length > 0 ? [eb("o.source_key", "in", activeSourceKeys)] : []),
                ...(activeConversationIds.length > 0
                  ? [eb("t.source_conversation_id", "in", activeConversationIds)]
                  : []),
              ];
              return predicates.length > 0 ? eb.or(predicates) : sql<boolean>`0 = 1`;
            });
          }
          return query;
        };
        const pendingRows =
          assigneeIds.length === 0
            ? []
            : await taskScope()
                .leftJoin("task_completion_recommendations as r", (join) =>
                  join.onRef("r.task_id", "=", "t.id").on("r.review_state", "=", "pending"),
                )
                .selectAll("t")
                .select("o.source_key as origin_source_key")
                .where("t.status", "in", ["open", "in_progress"])
                .where("t.assignee_entity_id", "in", assigneeIds)
                .where("r.id", "is", null)
                .orderBy("t.updated_at", "desc")
                .orderBy("t.id", "asc")
                .limit(REMINDER_PENDING_LIMIT + 1)
                .execute();
        const recommendationRows =
          assigneeIds.length === 0
            ? []
            : await taskScope()
                .innerJoin("task_completion_recommendations as r", (join) =>
                  join.onRef("r.task_id", "=", "t.id").on("r.review_state", "=", "pending"),
                )
                .selectAll("t")
                .select([
                  "o.source_key as origin_source_key",
                  "r.id as recommendation_id",
                  "r.rationale as recommendation_rationale",
                  "r.review_code as recommendation_review_code",
                  "r.created_at as recommendation_created_at",
                ])
                .where("t.status", "in", ["open", "in_progress"])
                .where("t.assignee_entity_id", "in", assigneeIds)
                .orderBy("r.created_at", "asc")
                .orderBy("r.id", "asc")
                .limit(REMINDER_PROPOSAL_LIMIT + 1)
                .execute();
        const suppressionRows = await taskScope()
          .selectAll("t")
          .select("o.source_key as origin_source_key")
          .where("t.status", "in", ["done", "dropped"])
          .orderBy("t.updated_at", "desc")
          .orderBy("t.id", "asc")
          .limit(REMINDER_SUPPRESSION_LIMIT + 1)
          .execute();
        const pending = pendingRows.slice(0, REMINDER_PENDING_LIMIT).map((task) => ({
          taskId: task.id,
          title: task.title,
          priority: task.priority,
          parentEntityId: task.parent_entity_id,
          assigneeEntityId: task.assignee_entity_id,
        }));
        const looksResolved = recommendationRows.slice(0, REMINDER_PROPOSAL_LIMIT).map((task) => ({
          recommendationId: task.recommendation_id,
          taskId: task.id,
          title: task.title,
          rationale: task.recommendation_rationale,
          reviewCode: task.recommendation_review_code,
          parentEntityId: task.parent_entity_id,
          assigneeEntityId: task.assignee_entity_id,
        }));
        const suppression = suppressionRows.slice(0, REMINDER_SUPPRESSION_LIMIT);
        const durableTasks = [...pendingRows.slice(0, REMINDER_PENDING_LIMIT), ...recommendationRows, ...suppression];
        const durableTitles = new Set(durableTasks.map((task) => normalizeName(task.title)));
        const durableScopedIdentities = new Set(
          durableTasks.flatMap((task) => {
            const sourceKey = task.origin_source_key;
            return sourceKey
              ? [
                  legacyIdentity({ title: task.title, sourceKey }),
                  ...(task.source_anchor_key
                    ? [legacyIdentity({ title: task.title, sourceKey, sourceAnchorKey: task.source_anchor_key })]
                    : []),
                ]
              : [];
          }),
        );
        const suppressedLegacyIdentities = new Set(suppressedLegacyCandidates.map(legacyIdentity));
        const untrackedRows = legacyCandidates.filter((candidate) => {
          if (suppressedLegacyIdentities.has(legacyIdentity(candidate))) return false;
          if (!candidate.sourceKey) return !durableTitles.has(normalizeName(candidate.title));
          return !durableScopedIdentities.has(legacyIdentity(candidate));
        });
        const untracked = untrackedRows.slice(0, REMINDER_UNTRACKED_LIMIT);
        const overflow =
          pendingRows.length > REMINDER_PENDING_LIMIT ||
          recommendationRows.length > REMINDER_PROPOSAL_LIMIT ||
          suppressionRows.length > REMINDER_SUPPRESSION_LIMIT ||
          untrackedRows.length > REMINDER_UNTRACKED_LIMIT;
        const result = {
          pending,
          looksResolved,
          untracked,
          suppressed: suppression.map((task) => ({ taskId: task.id, title: task.title })),
          suppressedTitles: suppression.map((task) => task.title),
        };
        return overflow
          ? { status: "error" as const, code: "reminder_query_overflow" as const, ...result }
          : { status: "ok" as const, ...result };
      } catch {
        return {
          status: "error" as const,
          code: "durable_query_failed" as const,
          untracked: legacyCandidates.slice(0, REMINDER_UNTRACKED_LIMIT),
        };
      }
    },

    async reviewRecommendationById(input: {
      id: string;
      action: "confirm_done" | "keep_open";
      userId: string;
      assigneeEntityIds: string[];
      surface: string;
      now: string;
      canEditAllLocalTasks?: boolean;
    }) {
      const load = () =>
        db
          .selectFrom("task_completion_recommendations")
          .innerJoin("tasks", "tasks.id", "task_completion_recommendations.task_id")
          .select([
            "task_completion_recommendations.review_code",
            "task_completion_recommendations.review_state",
            "task_completion_recommendations.task_id",
            "tasks.created_by_user_id",
            "tasks.assignee_entity_id",
          ])
          .where("task_completion_recommendations.id", "=", input.id)
          .executeTakeFirst();
      const current = await load();
      if (!current) return { status: "not_found" as const };
      const authorized =
        input.canEditAllLocalTasks === true ||
        current.created_by_user_id === input.userId ||
        Boolean(current.assignee_entity_id && input.assigneeEntityIds.includes(current.assignee_entity_id));
      if (!authorized) return { status: "unauthorized" as const };
      if (current.review_state !== "pending") {
        if (current.review_state !== "accepted" && current.review_state !== "rejected") {
          return { status: "stale" as const };
        }
        return {
          status: "already_reviewed" as const,
          decision: current.review_state === "accepted" ? ("confirm_done" as const) : ("keep_open" as const),
          taskId: current.task_id,
        };
      }

      const result = await createConversationFollowupsRepository(db).reviewRecommendation({
        code: current.review_code,
        action: input.action,
        userId: input.userId,
        assigneeEntityIds: input.assigneeEntityIds,
        surface: input.surface,
        now: input.now,
        canEditAllLocalTasks: input.canEditAllLocalTasks,
      });
      if (result.status !== "stale") return result;
      const raced = await load();
      if (raced?.review_state === "accepted" || raced?.review_state === "rejected") {
        return {
          status: "already_reviewed" as const,
          decision: raced.review_state === "accepted" ? ("confirm_done" as const) : ("keep_open" as const),
          taskId: raced.task_id,
        };
      }
      return result;
    },

    async reviewRecommendation(input: {
      code: string;
      action: "confirm_done" | "keep_open";
      userId: string;
      assigneeEntityIds: string[];
      surface: string;
      now: string;
      canEditAllLocalTasks?: boolean;
    }) {
      const code = input.code.trim().toUpperCase();
      const preflight = await db
        .selectFrom("task_completion_recommendations")
        .innerJoin("tasks", "tasks.id", "task_completion_recommendations.task_id")
        .select([
          "task_completion_recommendations.review_state",
          "tasks.created_by_user_id",
          "tasks.assignee_entity_id",
        ])
        .where("task_completion_recommendations.review_code", "=", code)
        .executeTakeFirst();
      if (!preflight) return { status: "not_found" as const };
      if (preflight.review_state !== "pending") return { status: "stale" as const };
      const preflightAuthorized =
        input.canEditAllLocalTasks === true ||
        preflight.created_by_user_id === input.userId ||
        Boolean(preflight.assignee_entity_id && input.assigneeEntityIds.includes(preflight.assignee_entity_id));
      if (!preflightAuthorized) return { status: "unauthorized" as const };

      try {
        return await db.transaction().execute(async (trx) => {
          const recommendation = await trx
            .selectFrom("task_completion_recommendations")
            .innerJoin("tasks", "tasks.id", "task_completion_recommendations.task_id")
            .select([
              "task_completion_recommendations.id as recommendation_id",
              "task_completion_recommendations.task_id",
              "task_completion_recommendations.review_state",
              "task_completion_recommendations.expires_at",
              "task_completion_recommendations.delivery_count",
              "tasks.created_by_user_id",
              "tasks.assignee_entity_id",
              "tasks.status_authority",
              "tasks.provenance",
              "tasks.status",
              "tasks.valid_to",
            ])
            .where("task_completion_recommendations.review_code", "=", code)
            .executeTakeFirst();
          if (!recommendation) return { status: "not_found" as const };
          if (recommendation.review_state !== "pending") return { status: "stale" as const };
          const authorized =
            input.canEditAllLocalTasks === true ||
            recommendation.created_by_user_id === input.userId ||
            Boolean(
              recommendation.assignee_entity_id && input.assigneeEntityIds.includes(recommendation.assignee_entity_id),
            );
          if (!authorized) return { status: "unauthorized" as const };
          if (
            recommendation.expires_at <= input.now ||
            recommendation.delivery_count > RECOMMENDATION_DELIVERY_LIMIT ||
            !taskIsActionableForCompletionReview(recommendation)
          ) {
            await trx
              .updateTable("task_completion_recommendations")
              .set({ review_state: "expired", updated_at: input.now })
              .where("id", "=", recommendation.recommendation_id)
              .where("review_state", "=", "pending")
              .execute();
            return { status: "stale" as const };
          }
          const taskClaimed = await touchActionableTaskForReview(trx, recommendation.task_id, {
            userId: input.userId,
            assigneeEntityIds: input.assigneeEntityIds,
            canEditAllLocalTasks: input.canEditAllLocalTasks,
          });
          if (!taskClaimed) {
            throw new ReviewAuthorizationChangedError(await classifyReviewFailure(trx, recommendation.task_id, input));
          }

          const state = input.action === "confirm_done" ? "accepted" : "rejected";
          const updated = await trx
            .updateTable("task_completion_recommendations")
            .set({
              review_state: state,
              reviewed_at: input.now,
              reviewed_by_user_id: input.userId,
              review_surface: input.surface,
              updated_at: input.now,
            })
            .where("id", "=", recommendation.recommendation_id)
            .where("review_state", "=", "pending")
            .where("expires_at", ">", input.now)
            .where("delivery_count", "<=", RECOMMENDATION_DELIVERY_LIMIT)
            .where(
              sql<boolean>`exists (
              select 1
              from tasks
              where tasks.id = task_completion_recommendations.task_id
                and tasks.valid_to is null
                and tasks.status in ('open', 'in_progress')
                and tasks.status_authority = 'local'
                and tasks.provenance in ('summary', 'brief')
            )`,
            )
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) === 0) {
            await trx
              .updateTable("task_completion_recommendations")
              .set({ review_state: "expired", updated_at: input.now })
              .where("id", "=", recommendation.recommendation_id)
              .where("review_state", "=", "pending")
              .execute();
            return { status: "stale" as const };
          }
          if (input.action === "confirm_done") {
            const taskUpdated = await updateActionableTaskStatus(trx, recommendation.task_id, "done", input.now, {
              userId: input.userId,
              assigneeEntityIds: input.assigneeEntityIds,
              canEditAllLocalTasks: input.canEditAllLocalTasks,
            });
            if (!taskUpdated) {
              const failure = await classifyReviewFailure(trx, recommendation.task_id, input);
              if (failure === "unauthorized") throw new ReviewAuthorizationChangedError(failure);
              await trx
                .updateTable("task_completion_recommendations")
                .set({
                  review_state: "expired",
                  reviewed_at: null,
                  reviewed_by_user_id: null,
                  review_surface: null,
                  updated_at: input.now,
                })
                .where("id", "=", recommendation.recommendation_id)
                .where("review_state", "=", "accepted")
                .execute();
              return { status: "stale" as const };
            }
            await appendReviewDecisionActivity(trx, {
              recommendationId: recommendation.recommendation_id,
              taskId: recommendation.task_id,
              decisionState: state,
              userId: input.userId,
              surface: input.surface,
              previousTaskStatus: recommendation.status,
              nextTaskStatus: "done",
              now: input.now,
            });
            return { status: "confirmed" as const, taskId: recommendation.task_id };
          }
          const taskStillActionable = await touchActionableTaskForReview(trx, recommendation.task_id, {
            userId: input.userId,
            assigneeEntityIds: input.assigneeEntityIds,
            canEditAllLocalTasks: input.canEditAllLocalTasks,
          });
          if (!taskStillActionable) {
            const failure = await classifyReviewFailure(trx, recommendation.task_id, input);
            if (failure === "unauthorized") throw new ReviewAuthorizationChangedError(failure);
            await trx
              .updateTable("task_completion_recommendations")
              .set({
                review_state: "expired",
                reviewed_at: null,
                reviewed_by_user_id: null,
                review_surface: null,
                updated_at: input.now,
              })
              .where("id", "=", recommendation.recommendation_id)
              .where("review_state", "=", "rejected")
              .execute();
            return { status: "stale" as const };
          }
          await appendReviewDecisionActivity(trx, {
            recommendationId: recommendation.recommendation_id,
            taskId: recommendation.task_id,
            decisionState: state,
            userId: input.userId,
            surface: input.surface,
            previousTaskStatus: recommendation.status,
            nextTaskStatus: null,
            now: input.now,
          });
          return { status: "kept_open" as const, taskId: recommendation.task_id };
        });
      } catch (error) {
        if (error instanceof ReviewAuthorizationChangedError) return { status: error.status };
        throw error;
      }
    },

    async recordRecommendationDelivery(input: {
      recommendationId: string;
      agentOutputDeliveryId: string;
    }): Promise<{ recorded: boolean; deliveryCount: number }> {
      return db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto("task_completion_recommendation_deliveries")
          .values({
            recommendation_id: input.recommendationId,
            agent_output_delivery_id: input.agentOutputDeliveryId,
          })
          .onConflict((oc) => oc.columns(["recommendation_id", "agent_output_delivery_id"]).doNothing())
          .executeTakeFirst();
        const recorded = Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
        if (recorded) {
          await trx
            .updateTable("task_completion_recommendations")
            .set((eb) => ({
              delivery_count: eb("delivery_count", "+", 1),
              updated_at: new Date().toISOString(),
            }))
            .where("id", "=", input.recommendationId)
            .execute();
        }
        const row = await trx
          .selectFrom("task_completion_recommendations")
          .select("delivery_count")
          .where("id", "=", input.recommendationId)
          .executeTakeFirstOrThrow();
        return { recorded, deliveryCount: row.delivery_count };
      });
    },
  };
}

async function appendReviewDecisionActivity(
  db: Transaction<DB>,
  input: {
    recommendationId: string;
    taskId: string;
    decisionState: "accepted" | "rejected";
    userId: string;
    surface: string;
    previousTaskStatus: string;
    nextTaskStatus: string | null;
    now: string;
  },
): Promise<void> {
  const activity = createTaskActivityRepository(db);
  const surface = toTaskActivitySurface(input.surface);
  await activity.append({
    taskId: input.taskId,
    eventKind: "completion_review_decided",
    actorType: "user",
    actorUserId: input.userId,
    surface,
    changes: { reviewState: { before: "pending", after: input.decisionState } },
    identityParts: [input.recommendationId, input.decisionState],
    occurredAt: input.now,
  });
  if (input.nextTaskStatus && input.previousTaskStatus !== input.nextTaskStatus) {
    await activity.append({
      taskId: input.taskId,
      eventKind: "task_status_changed",
      actorType: "user",
      actorUserId: input.userId,
      surface,
      changes: { status: { before: input.previousTaskStatus, after: input.nextTaskStatus } },
      identityParts: [input.recommendationId, input.previousTaskStatus, input.nextTaskStatus],
      occurredAt: input.now,
    });
  }
}

function toTaskActivitySurface(surface: string): TaskActivitySurface {
  if (
    surface === "daily_brief" ||
    surface === "summarizer" ||
    surface === "web" ||
    surface === "slack" ||
    surface === "whatsapp" ||
    surface === "system"
  ) {
    return surface;
  }
  return "system";
}

function legacyIdentity(candidate: LegacyFollowupCandidate): string {
  const scopedRouteAnchor =
    candidate.sourceKey?.startsWith("route:") && !candidate.sourceAnchorKey
      ? /^route:[^:]+:((?:slack|whatsapp):.+)$/.exec(candidate.sourceKey)?.[1]
      : null;
  const routeAnchor = candidate.sourceAnchorKey ?? scopedRouteAnchor;
  const sourceIdentity = routeAnchor ? `anchor:${routeAnchor}` : (candidate.sourceKey ?? null);
  return JSON.stringify([normalizeName(candidate.title), sourceIdentity]);
}

async function resolveActiveConversationIds(db: Kysely<DB>, sourceKeys: string[]): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const sourceKey of sourceKeys) {
    const match = /^(slack|whatsapp):(channel|group|dm):(.+)$/.exec(sourceKey);
    if (!match) continue;
    const platform = match[1] as "slack" | "whatsapp";
    const kind = match[2] as "channel" | "group" | "dm";
    const targetId = match[3] ?? "";
    if (kind === "dm") {
      const conversationId = Number(targetId);
      if (Number.isSafeInteger(conversationId) && conversationId > 0) ids.add(conversationId);
      continue;
    }
    const rows = await db
      .selectFrom("conversations")
      .select("id")
      .where("platform", "=", platform)
      .where("kind", "=", kind)
      .where("provider_conversation_id", "=", targetId)
      .limit(1)
      .execute();
    for (const row of rows) ids.add(row.id);
  }
  return ids;
}

async function deriveNormalizedEvidence(
  db: Kysely<DB>,
  input: {
    messageIds: number[];
    allowedMessageIds: number[];
    allowedConversationIds: number[];
  },
): Promise<NormalizedEvidenceResult> {
  const messageIds = [...new Set(input.messageIds)].filter(Number.isInteger);
  if (messageIds.length === 0) return { status: "invalid", reason: "missing_evidence" };
  const allowedMessages = new Set(input.allowedMessageIds);
  if (messageIds.some((id) => !allowedMessages.has(id))) {
    return { status: "invalid", reason: "outside_allowed_window" };
  }
  const rows = await db
    .selectFrom("conversation_messages")
    .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
    .select([
      "conversation_messages.id",
      "conversation_messages.conversation_id",
      "conversation_messages.provider_thread_id",
      "conversation_messages.is_thread_reply",
      "conversations.platform",
    ])
    .where("conversation_messages.id", "in", messageIds)
    .limit(messageIds.length)
    .execute();
  if (rows.length !== messageIds.length) return { status: "invalid", reason: "outside_allowed_window" };
  const allowedConversations = new Set(input.allowedConversationIds);
  if (rows.some((row) => !allowedConversations.has(row.conversation_id))) {
    return { status: "invalid", reason: "outside_allowed_window" };
  }
  const anchors = rows.flatMap((row): ConversationTaskSourceAnchor[] => {
    if (row.platform !== "slack" && row.platform !== "whatsapp") return [];
    const providerThreadId = row.platform === "slack" && row.is_thread_reply === 1 ? row.provider_thread_id : null;
    return [
      {
        platform: row.platform,
        conversationId: row.conversation_id,
        providerThreadId,
        key: `${row.platform}:${row.conversation_id}:${providerThreadId ?? "root"}`,
      },
    ];
  });
  if (anchors.length !== rows.length) return { status: "invalid", reason: "unsupported_platform" };
  const uniqueKeys = new Set(anchors.map((anchor) => anchor.key));
  if (uniqueKeys.size !== 1) return { status: "invalid", reason: "ambiguous_source_anchor" };
  return { status: "ok", anchor: anchors[0], messageIds: messageIds.sort((a, b) => a - b) };
}

async function applyTaskChange(
  db: Kysely<DB> | Transaction<DB>,
  input: {
    userId: string;
    outputId?: string | null;
    taskMemory: TaskMemoryItem[];
    authorizedAssigneeEntityIds?: string[];
    allowedMessageIds: number[];
    allowedConversationIds: number[];
    change: SummarizerTaskChange;
    now: string;
  },
): Promise<TaskChangeApplyResult> {
  const change = input.change;
  const evidence = await deriveNormalizedEvidence(db, {
    messageIds: change.evidenceMessageIds,
    allowedMessageIds: input.allowedMessageIds,
    allowedConversationIds: input.allowedConversationIds,
  });
  if (evidence.status === "invalid") {
    return { status: "rejected", kind: change.kind, reason: evidence.reason };
  }

  if (change.kind === "new") {
    const exactReplay = await findTaskForExactEvidence(db, {
      userId: input.userId,
      authorizedAssigneeEntityIds: input.authorizedAssigneeEntityIds ?? [],
      anchor: evidence.anchor,
      messageIds: evidence.messageIds,
      item: change.item,
    });
    if (exactReplay) {
      return { status: "applied", kind: "new", taskId: exactReplay.id };
    }
    const promoted = await createTaskRepository(db).promoteSummaryTask({
      userId: input.userId,
      item: change.item,
      sourceAnchor: evidence.anchor,
      originOutputId: input.outputId ?? null,
      dueAt: await sourceSupportedDueDate(
        db,
        evidence.messageIds,
        readStructuredPayloadString(change.item.structuredPayload, "dueAt"),
      ),
    });
    const taskId = promoted.taskId;
    const insertedMessageIds = await insertMessageEvidence(db, taskId, evidence.anchor, evidence.messageIds);
    const activity = createTaskActivityRepository(db);
    if (promoted.status === "upserted" && promoted.created) {
      await activity.append({
        taskId,
        eventKind: "task_created",
        actorType: "agent",
        actorKey: "conversation_summary",
        surface: "summarizer",
        sourceAgentOutputId: input.outputId ?? null,
        identityParts: [taskId],
        occurredAt: input.now,
      });
    }
    if (insertedMessageIds.length > 0) {
      await activity.append({
        taskId,
        eventKind: "material_evidence_added",
        actorType: "agent",
        actorKey: "conversation_summary",
        surface: "summarizer",
        sourceAgentOutputId: input.outputId ?? null,
        evidence: { messageIds: insertedMessageIds },
        identityParts: [taskId, ...insertedMessageIds],
        occurredAt: input.now,
      });
    }
    return { status: "applied", kind: "new", taskId };
  }

  const memory = input.taskMemory.find((task) => task.taskId === change.taskId);
  if (!memory) {
    return { status: "rejected", kind: change.kind, reason: "task_not_in_memory" };
  }
  if (!(await matchWithinScope(db, memory, evidence.anchor, change))) {
    return { status: "rejected", kind: change.kind, reason: "match_outside_scope" };
  }
  if (!(await metadataReferencesAreValid(db, change.metadata))) {
    return { status: "rejected", kind: change.kind, reason: "invalid_metadata" };
  }
  const task = await db
    .selectFrom("tasks")
    .selectAll()
    .where("id", "=", memory.taskId)
    .where("valid_to", "is", null)
    .executeTakeFirst();
  const authorizedAssigneeEntityIds = new Set(input.authorizedAssigneeEntityIds ?? []);
  const canEditTask =
    task?.created_by_user_id === input.userId ||
    Boolean(task?.assignee_entity_id && authorizedAssigneeEntityIds.has(task.assignee_entity_id));
  if (
    !task ||
    !canEditTask ||
    (task.status !== "open" && task.status !== "in_progress") ||
    task.status_authority !== "local" ||
    task.provenance !== "summary"
  ) {
    return { status: "rejected", kind: change.kind, reason: "task_not_editable" };
  }

  const insertedMessageIds = await insertMessageEvidence(db, task.id, evidence.anchor, evidence.messageIds);
  const activity = createTaskActivityRepository(db);
  if (insertedMessageIds.length > 0) {
    await activity.append({
      taskId: task.id,
      eventKind: "material_evidence_added",
      actorType: "agent",
      actorKey: "conversation_summary",
      surface: "summarizer",
      sourceAgentOutputId: input.outputId ?? null,
      evidence: { messageIds: insertedMessageIds },
      identityParts: [task.id, ...insertedMessageIds],
      occurredAt: input.now,
    });
  }
  if (change.kind === "changed") {
    const metadata = change.metadata;
    const dueAt =
      Object.hasOwn(metadata, "dueAt") && metadata.dueAt
        ? await sourceSupportedDueDate(db, evidence.messageIds, metadata.dueAt)
        : null;
    const next = {
      title: metadata.title?.trim() || task.title,
      priority: metadata.priority ?? task.priority,
      dueAt: dueAt ?? task.due_at,
      parentEntityId: metadata.parentEntityId ?? task.parent_entity_id,
      assigneeEntityId: metadata.assigneeEntityId ?? task.assignee_entity_id,
      assigneeName: metadata.assigneeName ?? task.assignee_name,
      proposedAssigneeName: metadata.proposedAssigneeName ?? task.proposed_assignee_name,
    };
    const changes = taskFieldChanges(task, next);
    const updated = await db
      .updateTable("tasks")
      .set({
        title: next.title,
        normalized_title: next.title !== task.title ? normalizeName(next.title) : task.normalized_title,
        priority: next.priority,
        due_at: next.dueAt,
        parent_entity_id: next.parentEntityId,
        assignee_entity_id: next.assigneeEntityId,
        assignee_name: next.assigneeName,
        proposed_assignee_name: next.proposedAssigneeName,
        updated_at: input.now,
      })
      .where("id", "=", task.id)
      .where("valid_to", "is", null)
      .where("status", "in", ["open", "in_progress"])
      .where("status_authority", "=", "local")
      .where("provenance", "=", "summary")
      .where((eb) =>
        eb.or([
          eb("created_by_user_id", "=", input.userId),
          ...((input.authorizedAssigneeEntityIds ?? []).length > 0
            ? [eb("assignee_entity_id", "in", input.authorizedAssigneeEntityIds ?? [])]
            : []),
        ]),
      )
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) throw new TaskBecameUneditableError();
    if (Object.keys(changes).length > 0) {
      await activity.append({
        taskId: task.id,
        eventKind: "task_fields_changed",
        actorType: "agent",
        actorKey: "conversation_summary",
        surface: "summarizer",
        sourceAgentOutputId: input.outputId ?? null,
        changes,
        identityParts: [task.id, input.outputId ?? null, JSON.stringify(changes)],
        occurredAt: input.now,
      });
    }
    return { status: "applied", kind: "changed", taskId: task.id };
  }

  const stillEditable = await touchEditableSummaryTask(
    db,
    task.id,
    input.userId,
    input.authorizedAssigneeEntityIds ?? [],
  );
  if (!stillEditable) throw new TaskBecameUneditableError();
  const recommendation = await createCompletionRecommendation(
    db,
    task.id,
    change.evidenceMessageIds,
    change.rationale,
    input.outputId ?? null,
    input.now,
  );
  if (recommendation.created) {
    await activity.append({
      taskId: task.id,
      eventKind: "completion_review_opened",
      actorType: "agent",
      actorKey: "conversation_summary",
      surface: "summarizer",
      sourceAgentOutputId: input.outputId ?? null,
      identityParts: [recommendation.id],
      occurredAt: input.now,
    });
  }
  return {
    status: "applied",
    kind: "resolved",
    taskId: task.id,
    recommendation,
  };
}

function readStructuredPayloadString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function sourceSupportedDueDate(
  db: Kysely<DB> | Transaction<DB>,
  messageIds: number[],
  candidate: string | null,
): Promise<string | null> {
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const date = new Date(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== candidate) return null;
  const supported = await db
    .selectFrom("conversation_messages")
    .select("id")
    .where("id", "in", messageIds)
    .where("text", "like", `%${candidate}%`)
    .executeTakeFirst();
  return supported ? candidate : null;
}

function taskFieldChanges(
  task: Selectable<TasksTable>,
  next: {
    title: string;
    priority: string | null;
    dueAt: string | null;
    parentEntityId: string | null;
    assigneeEntityId: string | null;
    assigneeName: string | null;
    proposedAssigneeName: string | null;
  },
) {
  return Object.fromEntries(
    [
      ["title", task.title, next.title],
      ["priority", task.priority, next.priority],
      ["dueAt", task.due_at, next.dueAt],
      ["parentEntityId", task.parent_entity_id, next.parentEntityId],
      ["assigneeEntityId", task.assignee_entity_id, next.assigneeEntityId],
      ["assigneeName", task.assignee_name, next.assigneeName],
      ["proposedAssigneeName", task.proposed_assignee_name, next.proposedAssigneeName],
    ].flatMap(([field, before, after]) => (before === after ? [] : [[field, { before, after }]])),
  );
}

async function matchWithinScope(
  db: Kysely<DB> | Transaction<DB>,
  memory: TaskMemoryItem,
  candidateAnchor: ConversationTaskSourceAnchor,
  change: Exclude<SummarizerTaskChange, { kind: "new" }>,
): Promise<boolean> {
  if (memory.sourceAnchor.key === candidateAnchor.key) {
    return metadataIsCompatibleWithMemory(memory, change.metadata);
  }
  if (
    memory.sourceAnchor.platform === "slack" &&
    candidateAnchor.platform === "slack" &&
    memory.sourceAnchor.conversationId === candidateAnchor.conversationId &&
    memory.sourceAnchor.providerThreadId === null &&
    candidateAnchor.providerThreadId &&
    memory.evidenceMessageIds.length > 0
  ) {
    const rootEvidence = await db
      .selectFrom("conversation_messages")
      .select("id")
      .where("id", "in", memory.evidenceMessageIds)
      .where("conversation_id", "=", memory.sourceAnchor.conversationId)
      .where("provider_message_id", "=", candidateAnchor.providerThreadId)
      .where("is_thread_reply", "=", 0)
      .executeTakeFirst();
    if (rootEvidence) return metadataIsCompatibleWithMemory(memory, change.metadata);
  }
  const metadata = change.metadata;
  if (!metadata) return false;
  if (memory.sourceAnchor.platform !== candidateAnchor.platform) return false;
  if (!memory.parentEntityId || metadata.parentEntityId !== memory.parentEntityId) return false;
  return metadataIsCompatibleWithMemory(memory, metadata) && metadataCarriesMatchingOwner(memory, metadata);
}

function metadataIsCompatibleWithMemory(memory: TaskMemoryItem, metadata: TaskMatchMetadata | undefined): boolean {
  if (!metadata) return true;
  if (metadata.parentEntityId && memory.parentEntityId && metadata.parentEntityId !== memory.parentEntityId) {
    return false;
  }
  if (metadata.assigneeEntityId && memory.assigneeEntityId && metadata.assigneeEntityId !== memory.assigneeEntityId) {
    return false;
  }
  const memoryOwnerNames = normalizedOwnerNames(memory.assigneeName, memory.proposedAssigneeName);
  const candidateOwnerNames = normalizedOwnerNames(metadata.assigneeName, metadata.proposedAssigneeName);
  if (
    memoryOwnerNames.size > 0 &&
    candidateOwnerNames.size > 0 &&
    ![...candidateOwnerNames].some((name) => memoryOwnerNames.has(name))
  ) {
    return false;
  }
  if (memory.assigneeEntityId && metadata.proposedAssigneeName && memoryOwnerNames.size === 0) {
    return false;
  }
  return true;
}

function metadataCarriesMatchingOwner(memory: TaskMemoryItem, metadata: TaskMatchMetadata): boolean {
  if (metadata.assigneeEntityId && metadata.assigneeEntityId === memory.assigneeEntityId) return true;
  const memoryOwnerNames = normalizedOwnerNames(memory.assigneeName, memory.proposedAssigneeName);
  const candidateOwnerNames = normalizedOwnerNames(metadata.assigneeName, metadata.proposedAssigneeName);
  return [...candidateOwnerNames].some((name) => memoryOwnerNames.has(name));
}

function normalizedOwnerNames(...names: Array<string | null | undefined>): Set<string> {
  return new Set(names.flatMap((name) => (name ? [normalizeName(name)] : [])).filter(Boolean));
}

async function insertMessageEvidence(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  anchor: ConversationTaskSourceAnchor,
  messageIds: number[],
): Promise<number[]> {
  const insertedMessageIds: number[] = [];
  for (const messageId of messageIds) {
    const result = await db
      .insertInto("task_message_evidence")
      .values({
        task_id: taskId,
        conversation_message_id: messageId,
        source_platform: anchor.platform,
        source_conversation_id: anchor.conversationId,
        source_provider_thread_id: anchor.providerThreadId,
        source_anchor_key: anchor.key,
      })
      .onConflict((oc) => oc.columns(["task_id", "conversation_message_id"]).doNothing())
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) insertedMessageIds.push(messageId);
  }
  return insertedMessageIds;
}

async function createCompletionRecommendation(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  evidenceMessageIds: number[],
  rationale: string,
  outputId: string | null,
  now: string,
): Promise<{ id: string; code: string; state: string; created: boolean }> {
  const sortedEvidence = [...new Set(evidenceMessageIds)].sort((a, b) => a - b);
  const fingerprint = completionEvidenceFingerprint(taskId, sortedEvidence);
  const existing = await db
    .selectFrom("task_completion_recommendations")
    .select(["id", "review_code", "review_state"])
    .where("task_id", "=", taskId)
    .where("proposed_status", "=", "done")
    .where("evidence_fingerprint", "=", fingerprint)
    .executeTakeFirst();
  if (existing) {
    return {
      id: existing.id,
      code: existing.review_code,
      state: existing.review_state,
      created: false,
    };
  }
  const collisionWinner = await findCompletionRecommendationCollisionWinner(db, taskId, fingerprint);
  if (collisionWinner) {
    return {
      id: collisionWinner.id,
      code: collisionWinner.review_code,
      state: collisionWinner.review_state,
      created: false,
    };
  }
  const pending = await db
    .selectFrom("task_completion_recommendations")
    .select(["id", "review_code", "review_state"])
    .where("task_id", "=", taskId)
    .where("proposed_status", "=", "done")
    .where("review_state", "=", "pending")
    .executeTakeFirst();
  if (pending) {
    await persistCompletionRecommendationCollisionIdentity(db, taskId, fingerprint, pending.id);
    await insertRecommendationEvidence(db, pending.id, sortedEvidence, now);
    return {
      id: pending.id,
      code: pending.review_code,
      state: pending.review_state,
      created: false,
    };
  }

  const id = randomUUID();
  const code = await createUniqueReviewCode(db);
  const expiresAt = new Date(Date.parse(now) + RECOMMENDATION_EXPIRY_MS).toISOString();
  await db
    .insertInto("task_completion_recommendations")
    .values({
      id,
      task_id: taskId,
      proposed_status: "done",
      review_state: "pending",
      review_code: code,
      evidence_fingerprint: fingerprint,
      origin_agent_output_id: outputId,
      rationale: rationale.trim() || "Completion was reported in the source conversation.",
      delivery_count: 0,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    })
    .execute();
  if (sortedEvidence.length > 0) {
    await insertRecommendationEvidence(db, id, sortedEvidence, now);
  }
  return { id, code, state: "pending", created: true };
}

type ExactEvidenceTaskCandidate = Pick<
  Selectable<TasksTable>,
  | "id"
  | "normalized_title"
  | "parent_entity_id"
  | "parent_source_ref"
  | "parent_name"
  | "assignee_entity_id"
  | "assignee_name"
  | "proposed_assignee_name"
  | "status"
> & { totalEvidenceCount: number };

interface NewTaskReplayIdentity {
  normalizedTitle: string;
  parentEntityId: string | null;
  parentSourceRef: string | null;
  parentNameKey: string | null;
  assigneeEntityId: string | null;
  ownerNameKeys: Set<string>;
}

async function findTaskForExactEvidence(
  db: Kysely<DB> | Transaction<DB>,
  input: {
    userId: string;
    authorizedAssigneeEntityIds: string[];
    anchor: ConversationTaskSourceAnchor;
    messageIds: number[];
    item: AgentOutputItemInput;
  },
): Promise<{ id: string } | undefined> {
  const uniqueMessageIds = [...new Set(input.messageIds)];
  if (uniqueMessageIds.length === 0) return undefined;
  const authorizedAssigneeEntityIds = [...new Set(input.authorizedAssigneeEntityIds)].filter(Boolean);
  const rows = await db
    .selectFrom("task_message_evidence as evidence")
    .innerJoin("tasks", "tasks.id", "evidence.task_id")
    .select([
      "tasks.id",
      "tasks.normalized_title",
      "tasks.parent_entity_id",
      "tasks.parent_source_ref",
      "tasks.parent_name",
      "tasks.assignee_entity_id",
      "tasks.assignee_name",
      "tasks.proposed_assignee_name",
      "tasks.status",
      "evidence.conversation_message_id",
      sql<number>`(
        SELECT COUNT(*)
        FROM task_message_evidence AS all_evidence
        WHERE all_evidence.task_id = tasks.id
      )`.as("total_evidence_count"),
    ])
    .where("tasks.provenance", "=", "summary")
    .where("tasks.source", "=", "summary")
    .where("tasks.valid_to", "is", null)
    .where("tasks.status", "in", ["open", "in_progress", "done", "dropped"])
    .where("tasks.status_authority", "=", "local")
    .where("tasks.source_anchor_key", "=", input.anchor.key)
    .where((eb) =>
      eb.or([
        eb("tasks.created_by_user_id", "=", input.userId),
        ...(authorizedAssigneeEntityIds.length > 0
          ? [eb("tasks.assignee_entity_id", "in", authorizedAssigneeEntityIds)]
          : []),
      ]),
    )
    .where("evidence.conversation_message_id", "in", uniqueMessageIds)
    .execute();
  const candidatesById = new Map<string, { task: ExactEvidenceTaskCandidate; evidence: Set<number> }>();
  for (const row of rows) {
    const candidate = candidatesById.get(row.id) ?? {
      task: {
        id: row.id,
        normalized_title: row.normalized_title,
        parent_entity_id: row.parent_entity_id,
        parent_source_ref: row.parent_source_ref,
        parent_name: row.parent_name,
        assignee_entity_id: row.assignee_entity_id,
        assignee_name: row.assignee_name,
        proposed_assignee_name: row.proposed_assignee_name,
        status: row.status,
        totalEvidenceCount: Number(row.total_evidence_count),
      },
      evidence: new Set<number>(),
    };
    candidate.evidence.add(row.conversation_message_id);
    candidatesById.set(row.id, candidate);
  }
  const identity = newTaskReplayIdentity(input.item);
  const compatible = [...candidatesById.values()]
    .filter(({ evidence }) => uniqueMessageIds.every((messageId) => evidence.has(messageId)))
    .flatMap(({ task }) => {
      const match = exactEvidenceIdentityMatch(task, identity);
      const evolvedTerminalReplay =
        (task.status === "done" || task.status === "dropped") && task.totalEvidenceCount > uniqueMessageIds.length;
      return match.compatible && (match.titleMatches || match.metadataMatches > 0 || evolvedTerminalReplay)
        ? [{ task, ...match }]
        : [];
    });
  if (compatible.length === 0) return undefined;

  const exactTitleMatches = compatible.filter((candidate) => candidate.titleMatches);
  const preferred = exactTitleMatches.length > 0 ? exactTitleMatches : compatible;
  const maxMetadataMatches = Math.max(...preferred.map((candidate) => candidate.metadataMatches));
  const strongest = preferred.filter((candidate) => candidate.metadataMatches === maxMetadataMatches);
  if (strongest.length === 1) return { id: strongest[0].task.id };
  return undefined;
}

function newTaskReplayIdentity(item: AgentOutputItemInput): NewTaskReplayIdentity {
  const payload = item.structuredPayload ?? {};
  const ownerName = firstPayloadString(payload, ["assigneeName", "ownerName", "owner"]);
  const ownerEmail = firstPayloadString(payload, ["assigneeEmail", "ownerEmail", "email"]);
  return {
    normalizedTitle: normalizeName(item.title),
    parentEntityId: firstPayloadString(payload, ["parentEntityId"]),
    parentSourceRef: firstPayloadString(payload, ["parentSourceRef"]),
    parentNameKey: normalizeOptionalName(firstPayloadString(payload, ["parentName"])),
    assigneeEntityId: firstPayloadString(payload, ["assigneeEntityId", "ownerEntityId"]),
    ownerNameKeys: normalizedOwnerNames(ownerName, ownerEmail),
  };
}

function exactEvidenceIdentityMatch(
  task: ExactEvidenceTaskCandidate,
  identity: NewTaskReplayIdentity,
): { compatible: boolean; titleMatches: boolean; metadataMatches: number } {
  let metadataMatches = 0;
  if (identity.parentEntityId) {
    if (identity.parentEntityId !== task.parent_entity_id) {
      return { compatible: false, titleMatches: false, metadataMatches: 0 };
    }
    metadataMatches += 1;
  }
  if (identity.parentSourceRef) {
    if (identity.parentSourceRef !== task.parent_source_ref) {
      return { compatible: false, titleMatches: false, metadataMatches: 0 };
    }
    metadataMatches += 1;
  }
  const taskParentNameKey = normalizeOptionalName(task.parent_name);
  if (identity.parentNameKey) {
    if (identity.parentNameKey !== taskParentNameKey) {
      return { compatible: false, titleMatches: false, metadataMatches: 0 };
    }
    metadataMatches += 1;
  }
  if (identity.assigneeEntityId) {
    if (identity.assigneeEntityId !== task.assignee_entity_id) {
      return { compatible: false, titleMatches: false, metadataMatches: 0 };
    }
    metadataMatches += 1;
  }
  const taskOwnerNames = normalizedOwnerNames(task.assignee_name, task.proposed_assignee_name);
  if (identity.ownerNameKeys.size > 0) {
    if (taskOwnerNames.size === 0 || ![...identity.ownerNameKeys].some((name) => taskOwnerNames.has(name))) {
      return { compatible: false, titleMatches: false, metadataMatches: 0 };
    }
    metadataMatches += 1;
  }
  return {
    compatible: true,
    titleMatches: identity.normalizedTitle === task.normalized_title,
    metadataMatches,
  };
}

function firstPayloadString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeOptionalName(value: string | null | undefined): string | null {
  if (!value) return null;
  return normalizeName(value) || null;
}

async function recoverCompletionRecommendationCollision(
  db: Kysely<DB>,
  input: {
    userId: string;
    outputId?: string | null;
    taskMemory: TaskMemoryItem[];
    authorizedAssigneeEntityIds?: string[];
    allowedMessageIds: number[];
    allowedConversationIds: number[];
    routeGuard?: {
      agentKey: string;
      routeId: string;
      sourceKey: string;
    };
    change: Extract<SummarizerTaskChange, { kind: "resolved" }>;
    now: string;
  },
): Promise<TaskChangeApplyResult | null> {
  const evidence = await deriveNormalizedEvidence(db, {
    messageIds: input.change.evidenceMessageIds,
    allowedMessageIds: input.allowedMessageIds,
    allowedConversationIds: input.allowedConversationIds,
  });
  if (evidence.status === "invalid") return null;
  const memory = input.taskMemory.find((task) => task.taskId === input.change.taskId);
  if (!memory || !(await matchWithinScope(db, memory, evidence.anchor, input.change))) return null;
  if (!(await metadataReferencesAreValid(db, input.change.metadata))) return null;

  return db.transaction().execute(async (trx) => {
    if (
      input.routeGuard &&
      !(await claimCurrentRoute(trx, {
        ...input.routeGuard,
        userId: input.userId,
        now: input.now,
      }))
    ) {
      return {
        status: "rejected",
        kind: input.change.kind,
        reason: "route_source_changed",
      };
    }
    const task = await trx
      .selectFrom("tasks")
      .select(["id", "created_by_user_id", "assignee_entity_id", "status", "status_authority", "provenance"])
      .where("id", "=", memory.taskId)
      .where("valid_to", "is", null)
      .executeTakeFirst();
    const authorizedAssigneeEntityIds = new Set(input.authorizedAssigneeEntityIds ?? []);
    const canEditTask =
      task?.created_by_user_id === input.userId ||
      Boolean(task?.assignee_entity_id && authorizedAssigneeEntityIds.has(task.assignee_entity_id));
    if (
      !task ||
      !canEditTask ||
      (task.status !== "open" && task.status !== "in_progress") ||
      task.status_authority !== "local" ||
      task.provenance !== "summary"
    ) {
      return null;
    }
    if (!(await touchEditableSummaryTask(trx, task.id, input.userId, input.authorizedAssigneeEntityIds ?? []))) {
      return null;
    }

    const fingerprint = completionEvidenceFingerprint(task.id, evidence.messageIds);
    const exactWinner = await trx
      .selectFrom("task_completion_recommendations")
      .select(["id", "review_code", "review_state"])
      .where("task_id", "=", task.id)
      .where("proposed_status", "=", "done")
      .where("evidence_fingerprint", "=", fingerprint)
      .executeTakeFirst();
    const winner =
      exactWinner ??
      (await trx
        .selectFrom("task_completion_recommendations")
        .select(["id", "review_code", "review_state"])
        .where("task_id", "=", task.id)
        .where("proposed_status", "=", "done")
        .where("review_state", "=", "pending")
        .executeTakeFirst());
    if (!winner) return null;

    await persistCompletionRecommendationCollisionIdentity(trx, task.id, fingerprint, winner.id);
    await insertMessageEvidence(trx, task.id, evidence.anchor, evidence.messageIds);
    await insertRecommendationEvidence(trx, winner.id, evidence.messageIds, input.now);
    return {
      status: "applied",
      kind: "resolved",
      taskId: task.id,
      recommendation: {
        id: winner.id,
        code: winner.review_code,
        state: winner.review_state,
        created: false,
      },
    };
  });
}

async function claimCurrentRoute(
  db: Transaction<DB>,
  input: {
    agentKey: string;
    userId: string;
    routeId: string;
    sourceKey: string;
    now: string;
  },
): Promise<boolean> {
  const claimed = await db
    .updateTable("task_durability_route_state")
    .set({ updated_at: input.now })
    .where("agent_key", "=", input.agentKey)
    .where("user_id", "=", input.userId)
    .where("route_id", "=", input.routeId)
    .where("source_key", "=", input.sourceKey)
    .executeTakeFirst();
  return Number(claimed.numUpdatedRows ?? 0) > 0;
}

async function findCompletionRecommendationCollisionWinner(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  fingerprint: string,
): Promise<{ id: string; review_code: string; review_state: string } | undefined> {
  const rows = await db
    .selectFrom("task_evidence")
    .select("ref_id")
    .where("task_id", "=", taskId)
    .where("kind", "=", RECOMMENDATION_COLLISION_IDENTITY_KIND)
    .execute();
  const winnerId = rows.flatMap((row) => {
    const identity = parseCompletionRecommendationCollisionIdentity(row.ref_id);
    return identity?.fingerprint === fingerprint ? [identity.winnerId] : [];
  })[0];
  if (!winnerId) return undefined;
  return db
    .selectFrom("task_completion_recommendations")
    .select(["id", "review_code", "review_state"])
    .where("id", "=", winnerId)
    .where("task_id", "=", taskId)
    .executeTakeFirst();
}

async function persistCompletionRecommendationCollisionIdentity(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  fingerprint: string,
  winnerId: string,
): Promise<void> {
  await db
    .insertInto("task_evidence")
    .values({
      task_id: taskId,
      kind: RECOMMENDATION_COLLISION_IDENTITY_KIND,
      ref_id: JSON.stringify([fingerprint, winnerId]),
    })
    .onConflict((oc) => oc.columns(["task_id", "kind", "ref_id"]).doNothing())
    .execute();
}

function parseCompletionRecommendationCollisionIdentity(
  value: string,
): { fingerprint: string; winnerId: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { fingerprint: parsed[0], winnerId: parsed[1] };
    }
  } catch {
    // Ignore unrelated or malformed evidence rows.
  }
  return null;
}

function completionEvidenceFingerprint(taskId: string, evidenceMessageIds: number[]): string {
  return createHash("sha256")
    .update(JSON.stringify([taskId, "done", [...new Set(evidenceMessageIds)].sort((a, b) => a - b)]))
    .digest("hex");
}

async function insertRecommendationEvidence(
  db: Kysely<DB> | Transaction<DB>,
  recommendationId: string,
  evidenceMessageIds: number[],
  now: string,
): Promise<void> {
  if (evidenceMessageIds.length === 0) return;
  await db
    .insertInto("task_completion_recommendation_evidence")
    .values(
      [...new Set(evidenceMessageIds)].map((messageId) => ({
        recommendation_id: recommendationId,
        conversation_message_id: messageId,
        created_at: now,
      })),
    )
    .onConflict((oc) => oc.columns(["recommendation_id", "conversation_message_id"]).doNothing())
    .execute();
}

async function createUniqueReviewCode(db: Kysely<DB> | Transaction<DB>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const value of bytes) code += REVIEW_CODE_ALPHABET[value % REVIEW_CODE_ALPHABET.length];
    const exists = await db
      .selectFrom("task_completion_recommendations")
      .select("id")
      .where("review_code", "=", code)
      .executeTakeFirst();
    if (!exists) return code;
  }
  throw new Error("Could not allocate a recommendation review code.");
}

async function metadataReferencesAreValid(
  db: Kysely<DB> | Transaction<DB>,
  metadata: TaskMatchMetadata | undefined,
): Promise<boolean> {
  if (!metadata) return true;
  const checks: Array<{ id: string; sourceType: "person" | "project" }> = [];
  if (metadata.parentEntityId) checks.push({ id: metadata.parentEntityId, sourceType: "project" });
  if (metadata.assigneeEntityId) checks.push({ id: metadata.assigneeEntityId, sourceType: "person" });
  for (const check of checks) {
    const entity = await db
      .selectFrom("entities")
      .select("id")
      .where("id", "=", check.id)
      .where("source_type", "=", check.sourceType)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .executeTakeFirst();
    if (!entity) return false;
  }
  return true;
}

async function expireRecommendations(db: Kysely<DB>, now: string): Promise<void> {
  await db
    .updateTable("task_completion_recommendations")
    .set({ review_state: "expired", updated_at: now })
    .where("review_state", "=", "pending")
    .where((eb) => eb.or([eb("expires_at", "<=", now), eb("delivery_count", ">=", RECOMMENDATION_DELIVERY_LIMIT)]))
    .execute();
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

function taskIsActionableForCompletionReview(task: {
  valid_to: string | null;
  status: string;
  status_authority: string;
  provenance: string;
}): boolean {
  return (
    task.valid_to === null &&
    (task.status === "open" || task.status === "in_progress") &&
    task.status_authority === "local" &&
    (task.provenance === "summary" || task.provenance === "brief")
  );
}

async function classifyReviewFailure(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  authorization: {
    userId: string;
    assigneeEntityIds: string[];
    canEditAllLocalTasks?: boolean;
  },
): Promise<"stale" | "unauthorized"> {
  const task = await db
    .selectFrom("tasks")
    .select(["created_by_user_id", "assignee_entity_id", "valid_to", "status", "status_authority", "provenance"])
    .where("id", "=", taskId)
    .executeTakeFirst();
  if (!task || !taskIsActionableForCompletionReview(task)) return "stale";
  if (authorization.canEditAllLocalTasks === true) return "stale";
  const authorized =
    task.created_by_user_id === authorization.userId ||
    Boolean(task.assignee_entity_id && authorization.assigneeEntityIds.includes(task.assignee_entity_id));
  return authorized ? "stale" : "unauthorized";
}

async function updateActionableTaskStatus(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  status: TaskStatus,
  now: string,
  authorization: {
    userId: string;
    assigneeEntityIds: string[];
    canEditAllLocalTasks?: boolean;
  },
): Promise<boolean> {
  let query = db
    .updateTable("tasks")
    .set({
      status,
      status_raw: status,
      status_authority: "local",
      status_changed_at: now,
      completed_at: status === "done" ? now : null,
      updated_at: now,
    })
    .where("id", "=", taskId)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .where("status_authority", "=", "local")
    .where("provenance", "in", ["summary", "brief"]);
  if (authorization.canEditAllLocalTasks !== true) {
    const assigneeIds = [...new Set(authorization.assigneeEntityIds)].filter(Boolean);
    query = query.where((eb) =>
      eb.or([
        eb("created_by_user_id", "=", authorization.userId),
        ...(assigneeIds.length > 0 ? [eb("assignee_entity_id", "in", assigneeIds)] : []),
      ]),
    );
  }
  const updated = await query.executeTakeFirst();
  return Number(updated.numUpdatedRows ?? 0) > 0;
}

async function touchActionableTaskForReview(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  authorization: {
    userId: string;
    assigneeEntityIds: string[];
    canEditAllLocalTasks?: boolean;
  },
): Promise<boolean> {
  let query = db
    .updateTable("tasks")
    .set({ updated_at: sql<string>`updated_at` })
    .where("id", "=", taskId)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .where("status_authority", "=", "local")
    .where("provenance", "in", ["summary", "brief"]);
  if (authorization.canEditAllLocalTasks !== true) {
    const assigneeIds = [...new Set(authorization.assigneeEntityIds)].filter(Boolean);
    query = query.where((eb) =>
      eb.or([
        eb("created_by_user_id", "=", authorization.userId),
        ...(assigneeIds.length > 0 ? [eb("assignee_entity_id", "in", assigneeIds)] : []),
      ]),
    );
  }
  const updated = await query.executeTakeFirst();
  return Number(updated.numUpdatedRows ?? 0) > 0;
}

async function touchEditableSummaryTask(
  db: Kysely<DB> | Transaction<DB>,
  taskId: string,
  userId: string,
  assigneeEntityIds: string[],
): Promise<boolean> {
  const assigneeIds = [...new Set(assigneeEntityIds)].filter(Boolean);
  const updated = await db
    .updateTable("tasks")
    .set({ updated_at: sql<string>`updated_at` })
    .where("id", "=", taskId)
    .where("valid_to", "is", null)
    .where("status", "in", ["open", "in_progress"])
    .where("status_authority", "=", "local")
    .where("provenance", "=", "summary")
    .where((eb) =>
      eb.or([
        eb("created_by_user_id", "=", userId),
        ...(assigneeIds.length > 0 ? [eb("assignee_entity_id", "in", assigneeIds)] : []),
      ]),
    )
    .executeTakeFirst();
  return Number(updated.numUpdatedRows ?? 0) > 0;
}

function taskAnchor(task: Selectable<TasksTable>): ConversationTaskSourceAnchor | null {
  if (
    (task.source_platform !== "slack" && task.source_platform !== "whatsapp") ||
    task.source_conversation_id === null ||
    !task.source_anchor_key
  ) {
    return null;
  }
  return {
    platform: task.source_platform,
    conversationId: task.source_conversation_id,
    providerThreadId: task.source_provider_thread_id,
    key: task.source_anchor_key,
  };
}
