import { randomUUID } from "node:crypto";
import type {
  AutomationBuilderSaveRequest,
  AutomationDefinition,
  WorkflowDelivery,
  WorkflowEdge,
  WorkflowStep,
} from "@sketch/shared";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import {
  type NewScheduledTask,
  type ScheduledTaskRow,
  createScheduledTaskRepository,
} from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import { normalizeScheduleTriggerSteps } from "../scheduler/trigger-metadata";
import {
  buildAutomationDefinition,
  parseAutomationBuilderSaveRequest,
  scheduledTaskFieldsFromSaveRequest,
  validateAutomationBuilderSaveRequest,
} from "./definition";

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

export interface AutomationEditActor {
  userId: string | null;
  canManageAnyTask: boolean;
}

export type AutomationCreateResult = { kind: "saved"; row: ScheduledTaskRow };

export type AutomationReplaceResult =
  | { kind: "saved"; row: ScheduledTaskRow }
  | { kind: "not_found" }
  | { kind: "revision_conflict"; currentRevision: number };

export interface AutomationStepContentPatch {
  contentType?: "prompt" | "script";
  content?: string;
  apps?: string[] | null;
}

export interface AutomationDefinitionPatch {
  expectedRevision?: number;
  prompt?: string;
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
  | { kind: "revision_conflict"; currentRevision: number };

function validatedRequest(request: AutomationBuilderSaveRequest, brokerCapable: boolean): AutomationBuilderSaveRequest {
  const parsed = parseAutomationBuilderSaveRequest(request);
  validateAutomationBuilderSaveRequest({ request: parsed, brokerCapable });
  return parsed;
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

function contentTypeForStep(step: WorkflowStep | undefined): "prompt" | "script" {
  return step?.type === "action" ? "script" : "prompt";
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
  let steps = mergeSteps(definition.steps, patch.steps);
  const trigger = steps.find((step) => step.type === "trigger")?.triggerConfig;

  if (trigger?.type === "slack_channel_message") {
    scheduleType = "external";
    scheduleValue = "slack_channel_message";
  } else if (trigger?.type === "canvas") {
    scheduleType = "external";
    scheduleValue = "canvas";
  } else if (
    (patch.scheduleType !== undefined || patch.scheduleValue !== undefined || patch.timezone !== undefined) &&
    scheduleType !== "external" &&
    trigger?.type === "schedule"
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
}): Promise<AutomationDefinition | null> {
  const row = await createScheduledTaskRepository(params.db).getById(params.taskId);
  if (!row) return null;
  const [stepContentRows, runRows] = await Promise.all([
    createAutomationStepContentRepository(params.db).getByTask(params.taskId),
    createAutomationRunsRepository(params.db).list(params.taskId),
  ]);
  return buildAutomationDefinition({ row, stepContentRows, runRows });
}

export async function updateAutomationDefinition(params: {
  db: Kysely<DB>;
  taskId: string;
  patch: AutomationDefinitionPatch;
  actor: AutomationEditActor;
  brokerCapable: boolean;
}): Promise<AutomationMutationResult> {
  return params.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirst();
    if (!current) return { kind: "not_found" as const };
    if (!params.actor.userId) return { kind: "access_denied" as const };
    if (!params.actor.canManageAnyTask && current.created_by !== params.actor.userId) {
      return { kind: "access_denied" as const };
    }

    const currentDefinition = buildAutomationDefinition({
      row: current,
      stepContentRows: await createAutomationStepContentRepository(trx).getByTask(params.taskId),
      runRows: [],
      normalizeScheduleTriggers: false,
    });
    const expectedRevision = params.patch.expectedRevision ?? current.revision;
    if (current.revision !== expectedRevision) {
      return { kind: "revision_conflict" as const, currentRevision: current.revision };
    }
    const request = validatedRequest(
      applyDefinitionPatch(currentDefinition, params.patch, expectedRevision),
      params.brokerCapable,
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
}): Promise<AutomationCreateResult> {
  const request = validatedRequest(params.request, params.brokerCapable);
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
    return created;
  });

  return { kind: "saved", row };
}

export async function replaceAutomationDefinition(params: {
  db: Kysely<DB>;
  taskId: string;
  request: AutomationBuilderSaveRequest;
  actor: AutomationEditActor;
  brokerCapable: boolean;
}): Promise<AutomationReplaceResult> {
  const request = validatedRequest(params.request, params.brokerCapable);

  return params.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirst();
    if (!current) return { kind: "not_found" as const };
    if (!params.actor.userId || (!params.actor.canManageAnyTask && current.created_by !== params.actor.userId)) {
      return { kind: "not_found" as const };
    }
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
    const row = await trx
      .selectFrom("scheduled_tasks")
      .selectAll()
      .where("id", "=", params.taskId)
      .executeTakeFirstOrThrow();
    return { kind: "saved" as const, row };
  });
}
