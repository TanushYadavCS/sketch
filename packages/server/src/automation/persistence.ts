import { randomUUID } from "node:crypto";
import type {
  AutomationBuilderSaveRequest,
  AutomationDefinition,
  AutomationExecutionMode,
  WorkflowDelivery,
  WorkflowEdge,
  WorkflowStep,
  WorkflowTriggerConfig,
} from "@sketch/shared";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import type { AutomationTaskLockRow } from "../db/repositories/automation-locks";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import {
  type NewScheduledTask,
  type ScheduledTaskRow,
  createScheduledTaskRepository,
} from "../db/repositories/scheduled-tasks";
import { createWebhookDeliveryRepository } from "../db/repositories/webhook-deliveries";
import { createWebhookEndpointRepository } from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { normalizeScheduleTriggerSteps } from "../scheduler/trigger-metadata";
import {
  buildAutomationDefinition,
  isAutomationPlaceholderDraft,
  isLegacyMaterializedAutomationPlaceholderRow,
  parseAutomationBuilderSaveRequest,
  scheduledTaskFieldsFromSaveRequest,
  validateAutomationBuilderSaveRequest,
} from "./definition";
import { assertEditableBy } from "./lock-service";
import {
  type AutomationTaskConversationAssociation,
  upsertAutomationTaskConversationAssociation,
} from "./task-conversations";

export interface AutomationCreateContext {
  id?: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  threadTs: string | null;
  createdBy: string | null;
  originPlatform: "web" | "slack" | "whatsapp" | null;
  originConversationId: string | null;
  originProviderThreadId: string | null;
  originMessageId: number | null;
}

/**
 * Actor for automation mutations. Rights are owner-or-explicit-grant, re-checked
 * inside each mutation's transaction against the shares table — there is no
 * admin bypass. `role` is reserved for a later lane and currently carries no
 * semantics.
 */
export interface AutomationEditActor {
  userId: string | null;
  role?: "admin";
}

export type AutomationCreateResult = {
  kind: "saved";
  row: ScheduledTaskRow;
  discardedBuilderConversations?: Array<{ conversationId: string; transcriptUserId: string }>;
};

export type AutomationReplaceResult =
  | { kind: "saved"; row: ScheduledTaskRow }
  | { kind: "not_found" }
  | { kind: "locked"; lock: AutomationTaskLockRow }
  | { kind: "revision_conflict"; currentRevision: number };

export interface AutomationStepContentPatch {
  contentType?: "prompt" | "script";
  content?: string;
  apps?: string[] | null;
}

export interface AutomationDefinitionPatch {
  expectedRevision?: number;
  prompt?: string;
  executionMode?: AutomationExecutionMode;
  scheduleType?: "cron" | "interval" | "once" | "external";
  scheduleValue?: string;
  timezone?: string;
  status?: "active" | "paused" | "completed";
  title?: string | null;
  description?: string | null;
  delivery?: Partial<Pick<WorkflowDelivery, "platform" | "targetType" | "targetId" | "threadTs" | "mode">>;
  steps?: WorkflowStep[];
  edges?: WorkflowEdge[];
  stepContent?: Record<string, AutomationStepContentPatch>;
}

export type AutomationMutationResult =
  | { kind: "saved"; row: ScheduledTaskRow; request: AutomationBuilderSaveRequest }
  | { kind: "not_found" }
  | { kind: "access_denied" }
  | { kind: "locked"; lock: AutomationTaskLockRow }
  | { kind: "revision_conflict"; currentRevision: number };

export type AutomationSetupModeSelectionResult =
  | { kind: "saved"; row: ScheduledTaskRow }
  | { kind: "not_found" }
  | { kind: "locked"; lock: AutomationTaskLockRow }
  | { kind: "not_placeholder" };

export interface AutomationDeletionScheduler {
  removeTaskRuntime(taskId: string): Promise<boolean>;
}

export type AutomationDeletionResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "access_denied" }
  | { kind: "scheduler_failure"; error: unknown };

class AutomationDeletionRaceError extends Error {
  constructor() {
    super("Automation was deleted concurrently");
  }
}

function validatedRequest(
  request: AutomationBuilderSaveRequest,
  brokerCapable: boolean,
  supportedTriggerTypes?: readonly WorkflowTriggerConfig["type"][],
): AutomationBuilderSaveRequest {
  const parsed = parseAutomationBuilderSaveRequest(request);
  validateAutomationBuilderSaveRequest({ request: parsed, brokerCapable, supportedTriggerTypes });
  return parsed;
}

function hasWebhookTriggerInSteps(steps: readonly WorkflowStep[]): boolean {
  return steps.some((step) => step.type === "trigger" && step.triggerConfig?.type === "webhook");
}

function hasWebhookTrigger(request: AutomationBuilderSaveRequest): boolean {
  return hasWebhookTriggerInSteps(request.steps);
}

async function ensureWebhookEndpoint(
  db: Kysely<DB>,
  taskId: string,
  request: AutomationBuilderSaveRequest,
): Promise<void> {
  const repository = createWebhookEndpointRepository(db);
  if (hasWebhookTrigger(request)) {
    await repository.ensureForTask(taskId);
    return;
  }
  await repository.deactivateForTask(taskId);
}

function contentEntries(request: AutomationBuilderSaveRequest) {
  return request.steps.flatMap((step) => {
    if (step.type === "trigger") return [];
    const content = request.stepContent[step.id];
    return content ? [{ ...content, stepId: step.id }] : [];
  });
}

async function replaceStepContent(
  db: Kysely<DB>,
  taskId: string,
  request: AutomationBuilderSaveRequest,
): Promise<void> {
  const repo = createAutomationStepContentRepository(db);
  const entries = contentEntries(request);
  await repo.deleteOrphanedSteps(
    taskId,
    entries.map((content) => content.stepId),
  );
  for (const content of entries) {
    await repo.upsert({
      taskId,
      stepId: content.stepId,
      contentType: content.contentType,
      content: content.content,
      apps: content.apps,
    });
  }
}

function saveRequestFromDefinition(
  definition: AutomationDefinition,
  expectedRevision: number | undefined,
): AutomationBuilderSaveRequest {
  return {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    title: definition.title,
    description: definition.description,
    prompt: definition.prompt,
    executionMode: definition.executionMode,
    scheduleType: definition.scheduleType,
    scheduleValue: definition.scheduleValue,
    timezone: definition.timezone,
    status: definition.status,
    delivery: definition.delivery,
    steps: definition.steps,
    edges: definition.edges,
    stepContent: definition.stepContent,
  };
}

function mergeSteps(current: WorkflowStep[], requested: WorkflowStep[] | undefined): WorkflowStep[] {
  if (!requested) return current;
  const currentById = new Map(current.map((step) => [step.id, step]));
  return requested.map((step) => {
    const existing = currentById.get(step.id);
    if (!existing) return step;
    return {
      ...existing,
      ...step,
      ...(step.triggerConfig === undefined ? { triggerConfig: existing.triggerConfig } : {}),
    };
  });
}

/**
 * Reconciles scheduler-authoritative fields onto inherited trigger JSON before an unrelated canonical edit.
 * This intentional hidden write repairs drift while preserving a custom label; explicit trigger configs are merged afterward and remain caller-owned through validation.
 */
function reconcileInheritedScheduleTriggerSteps(
  steps: WorkflowStep[],
  params: {
    scheduleType: "cron" | "interval" | "once";
    scheduleValue: string;
    timezone: string;
  },
): WorkflowStep[] {
  let updated = false;
  const next = steps.map((step) => {
    if (step.type !== "trigger" || step.triggerConfig?.type !== "schedule") return step;
    if (
      step.triggerConfig.scheduleType === params.scheduleType &&
      step.triggerConfig.scheduleValue === params.scheduleValue &&
      step.triggerConfig.timezone === params.timezone
    ) {
      return step;
    }
    updated = true;
    return {
      ...step,
      triggerConfig: {
        ...step.triggerConfig,
        scheduleType: params.scheduleType,
        scheduleValue: params.scheduleValue,
        timezone: params.timezone,
      },
    };
  });

  return updated ? next : steps;
}

function contentTypeForStep(step: WorkflowStep | undefined): "prompt" | "script" {
  return step?.type === "action" ? "script" : "prompt";
}

/**
 * Owner-or-grantee check evaluated inside the caller's transaction so a
 * revoke between the access read and the mutation write cannot slip through.
 */
async function isTaskEditor(
  trx: Kysely<DB>,
  taskId: string,
  createdBy: string | null,
  userId: string,
): Promise<boolean> {
  if (createdBy === userId) return true;
  return createAutomationSharesRepository(trx).hasGrant(taskId, userId);
}

function mergeStepContent(
  definition: AutomationDefinition,
  steps: WorkflowStep[],
  requested: Record<string, AutomationStepContentPatch> | undefined,
): AutomationBuilderSaveRequest["stepContent"] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const content = Object.fromEntries(
    Object.entries(definition.stepContent).map(([stepId, value]) => [
      stepId,
      { ...value, taskId: definition.id, stepId },
    ]),
  ) as AutomationBuilderSaveRequest["stepContent"];

  for (const [stepId, patch] of Object.entries(requested ?? {})) {
    const current = content[stepId];
    const step = stepById.get(stepId);
    content[stepId] = {
      taskId: definition.id,
      stepId,
      contentType: patch.contentType ?? current?.contentType ?? contentTypeForStep(step),
      content: patch.content ?? current?.content ?? "",
      apps: Object.prototype.hasOwnProperty.call(patch, "apps") ? (patch.apps ?? null) : (current?.apps ?? null),
      ...(current?.updatedAt ? { updatedAt: current.updatedAt } : {}),
    };
  }

  return content;
}

function applyDefinitionPatch(
  definition: AutomationDefinition,
  patch: AutomationDefinitionPatch,
  expectedRevision: number,
): AutomationBuilderSaveRequest {
  let scheduleType = patch.scheduleType ?? definition.scheduleType;
  let scheduleValue = patch.scheduleValue ?? definition.scheduleValue;
  const timezone = patch.timezone ?? definition.timezone;
  let inheritedSteps = definition.steps;
  if (definition.scheduleType !== "external") {
    inheritedSteps = reconcileInheritedScheduleTriggerSteps(inheritedSteps, {
      scheduleType: definition.scheduleType,
      scheduleValue: definition.scheduleValue,
      timezone: definition.timezone,
    });
  }
  const hasExplicitTriggerConfig =
    patch.steps?.some((step) => step.type === "trigger" && step.triggerConfig !== undefined) ?? false;
  let steps = mergeSteps(inheritedSteps, patch.steps);
  const trigger = steps.find((step) => step.type === "trigger")?.triggerConfig;

  if (trigger?.type === "slack_channel_message") {
    scheduleType = "external";
    scheduleValue = "slack_channel_message";
  } else if (trigger?.type === "canvas") {
    scheduleType = "external";
    scheduleValue = "canvas";
  } else if (trigger?.type === "webhook") {
    scheduleType = "external";
    scheduleValue = "webhook";
  } else if (
    (patch.scheduleType !== undefined || patch.scheduleValue !== undefined || patch.timezone !== undefined) &&
    scheduleType !== "external" &&
    trigger?.type === "schedule" &&
    !hasExplicitTriggerConfig
  ) {
    steps = normalizeScheduleTriggerSteps(steps, { scheduleType, scheduleValue, timezone });
  }

  const delivery = {
    ...definition.delivery,
    ...(patch.delivery?.platform === undefined ? {} : { platform: patch.delivery.platform }),
    ...(patch.delivery?.targetType === undefined ? {} : { targetType: patch.delivery.targetType }),
    ...(patch.delivery?.targetId === undefined ? {} : { targetId: patch.delivery.targetId }),
    ...(Object.prototype.hasOwnProperty.call(patch.delivery ?? {}, "threadTs")
      ? { threadTs: patch.delivery?.threadTs ?? null }
      : {}),
    ...(patch.delivery?.mode === undefined ? {} : { mode: patch.delivery.mode }),
  };
  const hasTitle = Object.prototype.hasOwnProperty.call(patch, "title");
  const hasDescription = Object.prototype.hasOwnProperty.call(patch, "description");

  return {
    ...saveRequestFromDefinition(definition, expectedRevision),
    expectedRevision,
    title: hasTitle ? (patch.title ?? null) : definition.title,
    description: hasDescription ? (patch.description ?? null) : definition.description,
    prompt: patch.prompt ?? definition.prompt,
    executionMode: patch.executionMode ?? definition.executionMode,
    scheduleType,
    scheduleValue,
    timezone,
    status: patch.status ?? definition.status,
    delivery,
    steps,
    edges: patch.edges ?? definition.edges,
    stepContent: mergeStepContent(definition, steps, patch.stepContent),
  };
}

export async function getAutomationDefinition(params: {
  db: Kysely<DB>;
  taskId: string;
  webhookBaseUrl?: string | null;
  webhookPort?: number;
  encryptionKey?: string;
}): Promise<AutomationDefinition | null> {
  const row = await createScheduledTaskRepository(params.db).getById(params.taskId);
  if (!row) return null;
  const [stepContentRows, runRows, webhookEndpoint] = await Promise.all([
    createAutomationStepContentRepository(params.db).getByTask(params.taskId),
    createAutomationRunsRepository(params.db).list(params.taskId),
    createWebhookEndpointRepository(params.db, params.encryptionKey).getByTaskId(params.taskId),
  ]);
  return buildAutomationDefinition({
    row,
    stepContentRows,
    runRows,
    webhookBaseUrl: params.webhookBaseUrl,
    webhookPort: params.webhookPort,
    webhookEndpoint,
  });
}

/**
 * Deletes an automation and every persisted task-owned row in one transaction.
 * The legacy automation tables do not declare task foreign keys, so the dependent
 * rows are removed explicitly before the task row. Scheduler cleanup is deliberately
 * post-commit: a scheduler failure is returned as inconsistent runtime state because
 * the committed database deletion cannot be rolled back. Transcript files are not
 * part of this operation. A missing task is a deterministic not-found result, so a
 * retry after a successful delete does not perform another scheduler mutation.
 */
export async function deleteAutomation(params: {
  db: Kysely<DB>;
  taskId: string;
  actor: AutomationEditActor;
  scheduler: AutomationDeletionScheduler;
  encryptionKey?: string;
}): Promise<AutomationDeletionResult> {
  let databaseResult: Extract<AutomationDeletionResult, { kind: "deleted" | "not_found" | "access_denied" }>;
  try {
    databaseResult = await params.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("scheduled_tasks")
        .select(["id", "created_by"])
        .where("id", "=", params.taskId)
        .executeTakeFirst();

      if (!current) return { kind: "not_found" as const };
      if (!params.actor.userId || current.created_by !== params.actor.userId) {
        return { kind: "access_denied" as const };
      }

      await createScheduledTaskConversationRepository(trx).deleteByTaskId(params.taskId);
      await createAutomationStepContentRepository(trx).deleteByTaskId(params.taskId);
      await createAutomationRunsRepository(trx).deleteByTaskId(params.taskId);
      await createWebhookDeliveryRepository(trx).deleteByTaskId(params.taskId);
      await trx.deleteFrom("webhook_endpoints").where("task_id", "=", params.taskId).execute();
      await createAutomationSharesRepository(trx).deleteByTaskId(params.taskId);
      await createAutomationLocksRepository(trx).deleteByTaskId(params.taskId);

      const deleted = await trx.deleteFrom("scheduled_tasks").where("id", "=", params.taskId).executeTakeFirst();
      if (Number(deleted.numDeletedRows ?? 0) === 0) throw new AutomationDeletionRaceError();

      return { kind: "deleted" as const };
    });
  } catch (error) {
    if (error instanceof AutomationDeletionRaceError) return { kind: "not_found" };
    throw error;
  }

  if (databaseResult.kind !== "deleted") return databaseResult;

  try {
    if (!(await params.scheduler.removeTaskRuntime(params.taskId))) {
      return { kind: "scheduler_failure", error: new Error("Scheduler removal returned false") };
    }
  } catch (error) {
    return { kind: "scheduler_failure", error };
  }

  return databaseResult;
}

export async function updateAutomationDefinition(params: {
  db: Kysely<DB>;
  taskId: string;
  patch: AutomationDefinitionPatch;
  actor: AutomationEditActor;
  brokerCapable: boolean;
  supportedTriggerTypes?: readonly WorkflowTriggerConfig["type"][];
  taskConversationAssociation?: AutomationTaskConversationAssociation;
  encryptionKey?: string;
}): Promise<AutomationMutationResult> {
  return params.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirst();
    if (!current) return { kind: "not_found" as const };
    if (!params.actor.userId) return { kind: "access_denied" as const };
    if (!(await isTaskEditor(trx, current.id, current.created_by, params.actor.userId))) {
      return { kind: "access_denied" as const };
    }
    const editable = await assertEditableBy(trx, params.taskId, params.actor.userId);
    if (editable.kind === "locked") return { kind: "locked" as const, lock: editable.lock };

    const currentDefinition = buildAutomationDefinition({
      row: current,
      stepContentRows: await createAutomationStepContentRepository(trx).getByTask(params.taskId),
      runRows: [],
      normalizeScheduleTriggers: false,
      includeWebhookMetadata: false,
    });
    const expectedRevision = params.patch.expectedRevision ?? current.revision;
    if (current.revision !== expectedRevision) {
      return { kind: "revision_conflict" as const, currentRevision: current.revision };
    }
    const request = validatedRequest(
      applyDefinitionPatch(currentDefinition, params.patch, expectedRevision),
      params.brokerCapable,
      params.supportedTriggerTypes,
    );

    const updateResult = await trx
      .updateTable("scheduled_tasks")
      .set({
        ...scheduledTaskFieldsFromSaveRequest(request),
        revision: sql<number>`revision + 1`,
        updated_at: sql<string>`CURRENT_TIMESTAMP`,
        last_edited_by: params.actor.userId,
      })
      .where("id", "=", params.taskId)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    if (Number(updateResult.numUpdatedRows ?? 0) === 0) {
      const latest = await trx
        .selectFrom("scheduled_tasks")
        .select("revision")
        .where("id", "=", params.taskId)
        .executeTakeFirst();
      if (!latest) return { kind: "not_found" as const };
      return { kind: "revision_conflict" as const, currentRevision: latest.revision };
    }

    await replaceStepContent(trx, params.taskId, request);
    await ensureWebhookEndpoint(trx, params.taskId, request);
    if (params.taskConversationAssociation) {
      await upsertAutomationTaskConversationAssociation(trx, {
        taskId: params.taskId,
        ...params.taskConversationAssociation,
      });
    }
    const row = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirstOrThrow();
    return { kind: "saved" as const, row, request };
  });
}

export async function createAutomationDefinition(params: {
  db: Kysely<DB>;
  request: AutomationBuilderSaveRequest;
  context: AutomationCreateContext;
  brokerCapable: boolean;
  supportedTriggerTypes?: readonly WorkflowTriggerConfig["type"][];
  taskConversationAssociation?: AutomationTaskConversationAssociation;
  encryptionKey?: string;
}): Promise<AutomationCreateResult> {
  const request = validatedRequest(params.request, params.brokerCapable, params.supportedTriggerTypes);
  const id = params.context.id ?? randomUUID();

  const row = await params.db.transaction().execute(async (trx) => {
    const fields = scheduledTaskFieldsFromSaveRequest(request);
    const task: NewScheduledTask = {
      id,
      platform: params.context.platform,
      context_type: params.context.contextType,
      delivery_target: params.context.deliveryTarget,
      thread_ts: params.context.threadTs,
      prompt: request.prompt,
      schedule_type: fields.schedule_type ?? request.scheduleType,
      schedule_value: fields.schedule_value ?? request.scheduleValue,
      timezone: request.timezone,
      session_mode: "fresh",
      next_run_at: null,
      status: request.status,
      created_by: params.context.createdBy,
      title: request.title,
      description: request.description,
      execution_mode: request.executionMode,
      steps: fields.steps ?? null,
      edges: fields.edges ?? null,
      output_target: request.delivery.targetId,
      output_platform: request.delivery.platform,
      output_thread_ts: request.delivery.threadTs,
      output_mode: request.delivery.mode,
      origin_platform: params.context.originPlatform,
      origin_conversation_id: params.context.originConversationId,
      origin_provider_thread_id: params.context.originProviderThreadId,
      origin_message_id: params.context.originMessageId,
      last_edited_by: params.context.createdBy,
    };
    const created = await createScheduledTaskRepository(trx).add(task);
    await replaceStepContent(trx, id, request);
    await ensureWebhookEndpoint(trx, id, request);
    if (params.taskConversationAssociation) {
      await upsertAutomationTaskConversationAssociation(trx, {
        taskId: id,
        ...params.taskConversationAssociation,
      });
    }
    return created;
  });

  return { kind: "saved", row };
}

export async function createAutomationDraft(params: {
  db: Kysely<DB>;
  context: AutomationCreateContext;
  timezone: string;
  taskConversationAssociation?: AutomationTaskConversationAssociation;
  taskConversationAssociations?: readonly AutomationTaskConversationAssociation[];
}): Promise<AutomationCreateResult> {
  const id = params.context.id ?? randomUUID();
  const deliveryTarget = params.context.deliveryTarget.trim();
  if (!deliveryTarget) throw new Error("Draft automation requires a delivery target");
  const createdBy = params.context.createdBy;

  const task: NewScheduledTask = {
    id,
    platform: params.context.platform,
    context_type: params.context.contextType,
    delivery_target: deliveryTarget,
    thread_ts: params.context.threadTs,
    prompt: "Describe the automation.",
    schedule_type: "interval",
    schedule_value: "3600",
    timezone: params.timezone.trim() || "UTC",
    session_mode: "fresh",
    next_run_at: null,
    status: "paused",
    created_by: params.context.createdBy,
    title: "New automation",
    description: null,
    steps: null,
    edges: null,
    output_target: deliveryTarget,
    output_platform: params.context.platform,
    output_thread_ts: params.context.threadTs,
    output_mode: "deliver",
    origin_platform: params.context.originPlatform,
    origin_conversation_id: params.context.originConversationId,
    origin_provider_thread_id: params.context.originProviderThreadId,
    origin_message_id: params.context.originMessageId,
    last_edited_by: params.context.createdBy,
  };

  const result = await params.db.transaction().execute(async (trx) => {
    const stepContentRepo = createAutomationStepContentRepository(trx);
    const runsRepo = createAutomationRunsRepository(trx);
    const conversationsRepo = createScheduledTaskConversationRepository(trx);
    const discardedBuilderConversations: Array<{ conversationId: string; transcriptUserId: string }> = [];
    if (createdBy && params.context.originPlatform === "web" && params.context.originConversationId) {
      const previousCandidates = await trx
        .selectFrom("scheduled_tasks")
        .selectAll()
        .where("created_by", "=", createdBy)
        .where("origin_platform", "=", "web")
        .where("origin_conversation_id", "=", params.context.originConversationId)
        .execute();
      for (const candidate of previousCandidates) {
        const [stepContentRows, runRows] = await Promise.all([
          stepContentRepo.getByTask(candidate.id),
          runsRepo.list(candidate.id),
        ]);
        if (!isAutomationPlaceholderDraft({ row: candidate, stepContentRows, runRows })) continue;
        const builderConversations = await conversationsRepo.listByTaskAndTranscriptUser(candidate.id, createdBy, {
          kind: "builder",
        });
        discardedBuilderConversations.push(
          ...builderConversations.map((conversation) => ({
            conversationId: conversation.conversation_id,
            transcriptUserId: conversation.transcript_user_id,
          })),
        );
        await conversationsRepo.deleteByTaskId(candidate.id);
        await createWebhookDeliveryRepository(trx).deleteByTaskId(candidate.id);
        await trx.deleteFrom("webhook_endpoints").where("task_id", "=", candidate.id).execute();
        await trx.deleteFrom("scheduled_tasks").where("id", "=", candidate.id).execute();
      }
    }
    const created = await createScheduledTaskRepository(trx).add(task);
    for (const association of [
      ...(params.taskConversationAssociation ? [params.taskConversationAssociation] : []),
      ...(params.taskConversationAssociations ?? []),
    ]) {
      await upsertAutomationTaskConversationAssociation(trx, {
        taskId: id,
        ...association,
      });
    }
    return { row: created, discardedBuilderConversations };
  });

  return {
    kind: "saved",
    row: result.row,
    ...(result.discardedBuilderConversations.length > 0
      ? { discardedBuilderConversations: result.discardedBuilderConversations }
      : {}),
  };
}

export async function selectAutomationSetupExecutionMode(params: {
  db: Kysely<DB>;
  taskId: string;
  executionMode: AutomationExecutionMode;
  actor: AutomationEditActor;
}): Promise<AutomationSetupModeSelectionResult> {
  return params.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("scheduled_tasks").selectAll().where("id", "=", params.taskId).executeTakeFirst();
    if (!row || !params.actor.userId) return { kind: "not_found" as const };
    if (!(await isTaskEditor(trx, row.id, row.created_by, params.actor.userId))) return { kind: "not_found" as const };
    const editable = await assertEditableBy(trx, params.taskId, params.actor.userId);
    if (editable.kind === "locked") return { kind: "locked" as const, lock: editable.lock };
    const [stepContentRows, runRows] = await Promise.all([
      createAutomationStepContentRepository(trx).getByTask(params.taskId),
      createAutomationRunsRepository(trx).list(params.taskId),
    ]);
    if (!isAutomationPlaceholderDraft({ row, stepContentRows, runRows })) return { kind: "not_placeholder" as const };
    const isLegacyMaterializedPlaceholder = isLegacyMaterializedAutomationPlaceholderRow(row);

    await trx
      .updateTable("scheduled_tasks")
      .set({
        execution_mode: params.executionMode,
        updated_at: sql<string>`CURRENT_TIMESTAMP`,
        ...(isLegacyMaterializedPlaceholder ? { steps: null, edges: null, revision: 0 } : {}),
      })
      .where("id", "=", params.taskId)
      .execute();
    return {
      kind: "saved" as const,
      row: await trx
        .selectFrom("scheduled_tasks")
        .selectAll()
        .where("id", "=", params.taskId)
        .executeTakeFirstOrThrow(),
    };
  });
}

export async function replaceAutomationDefinition(params: {
  db: Kysely<DB>;
  taskId: string;
  request: AutomationBuilderSaveRequest;
  actor: AutomationEditActor;
  brokerCapable: boolean;
  supportedTriggerTypes?: readonly WorkflowTriggerConfig["type"][];
  taskConversationAssociation?: AutomationTaskConversationAssociation;
  encryptionKey?: string;
}): Promise<AutomationReplaceResult> {
  const request = validatedRequest(params.request, params.brokerCapable, params.supportedTriggerTypes);

  return params.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirst();
    if (!current) return { kind: "not_found" as const };
    if (!params.actor.userId) return { kind: "not_found" as const };
    if (!(await isTaskEditor(trx, current.id, current.created_by, params.actor.userId))) {
      return { kind: "not_found" as const };
    }
    const editable = await assertEditableBy(trx, params.taskId, params.actor.userId);
    if (editable.kind === "locked") return { kind: "locked" as const, lock: editable.lock };
    const expectedRevision = request.expectedRevision ?? current.revision;
    if (current.revision !== expectedRevision) {
      return { kind: "revision_conflict" as const, currentRevision: current.revision };
    }

    let update = trx
      .updateTable("scheduled_tasks")
      .set({
        ...scheduledTaskFieldsFromSaveRequest(request),
        revision: sql<number>`revision + 1`,
        updated_at: sql<string>`CURRENT_TIMESTAMP`,
        last_edited_by: params.actor.userId,
      })
      .where("id", "=", params.taskId);
    update = update.where("revision", "=", expectedRevision);
    const updateResult = await update.executeTakeFirst();
    if (Number(updateResult.numUpdatedRows ?? 0) === 0) {
      const latest = await trx
        .selectFrom("scheduled_tasks")
        .select("revision")
        .where("id", "=", params.taskId)
        .executeTakeFirst();
      if (!latest) return { kind: "not_found" as const };
      return { kind: "revision_conflict" as const, currentRevision: latest.revision };
    }

    await replaceStepContent(trx, params.taskId, request);
    await ensureWebhookEndpoint(trx, params.taskId, request);
    if (params.taskConversationAssociation) {
      await upsertAutomationTaskConversationAssociation(trx, {
        taskId: params.taskId,
        ...params.taskConversationAssociation,
      });
    }
    const row = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirstOrThrow();
    return { kind: "saved" as const, row };
  });
}
