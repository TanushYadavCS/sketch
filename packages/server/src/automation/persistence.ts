import { randomUUID } from "node:crypto";
import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import {
  type NewScheduledTask,
  type ScheduledTaskRow,
  createScheduledTaskRepository,
} from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import {
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
      schedule_type: request.scheduleType,
      schedule_value: request.scheduleValue,
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
    if (!params.actor.canManageAnyTask && (!params.actor.userId || current.created_by !== params.actor.userId)) {
      return { kind: "not_found" as const };
    }
    if (request.expectedRevision !== undefined && current.revision !== request.expectedRevision) {
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
    if (request.expectedRevision !== undefined) {
      update = update.where("revision", "=", request.expectedRevision);
    }
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
