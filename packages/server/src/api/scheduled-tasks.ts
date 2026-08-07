import { workflowStepUsesIntegrationActions } from "@sketch/shared";
import { type Context, Hono } from "hono";
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import {
  AutomationValidationError,
  buildAutomationDefinition,
  parseAutomationBuilderSaveRequest,
} from "../automation/definition";
import { deleteAutomation, replaceAutomationDefinition } from "../automation/persistence";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createChannelRepository } from "../db/repositories/channels";
import { type StoredConversationMessage, createConversationRepository } from "../db/repositories/conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB, ScheduledTasksTable } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import { resolveScheduledTaskAccess } from "../scheduler/access";
import { formatIntervalScheduleLabel, normalizeScheduleTriggerStepsJson } from "../scheduler/trigger-metadata";
import { type WorkflowDelivery, isSlackUserId, resolveWorkflowDelivery } from "../workflows/delivery";
import type { WorkflowStep } from "../workflows/types";

type ScheduledTaskRow = Selectable<ScheduledTasksTable>;
type WorkflowTriggerConfig = NonNullable<WorkflowStep["triggerConfig"]>;

interface ScheduledTaskMutationDeps {
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  removeTask: (id: string) => Promise<boolean>;
  removeTaskRuntime?: (id: string) => Promise<boolean>;
  executeTaskById: (id: string) => Promise<unknown>;
  refreshTaskSchedule?: (id: string) => Promise<unknown>;
  executeStepById?: (
    id: string,
    stepId: string,
    options?: { input?: unknown; useLatestUpstreamOutput?: boolean },
  ) => Promise<unknown>;
}

interface ScheduledTaskRouteOptions {
  logger?: Logger;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
}

interface ScheduledTaskListItem {
  id: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  threadTs: string | null;
  prompt: string;
  scheduleType: "cron" | "interval" | "once" | "external";
  scheduleValue: string;
  timezone: string;
  sessionMode: "fresh";
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: "active" | "paused" | "completed";
  createdBy: string | null;
  createdAt: string;
  targetLabel: string;
  targetKindLabel: "Slack DM" | "Slack channel" | "WhatsApp DM" | "WhatsApp group";
  creatorName: string | null;
  scheduleLabel: string;
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
  title: string | null;
  description: string | null;
  originChat: {
    platform: "web" | "slack" | "whatsapp";
    conversationId: string;
    providerThreadId: string | null;
    currentMessageId: number | null;
  } | null;
  steps: string | null;
  stepCount: number;
  triggerConfig: WorkflowTriggerConfig | null;
  outputTarget: string | null;
  outputPlatform: string | null;
  outputThreadTs: string | null;
  outputMode: "deliver" | "silent";
  delivery: WorkflowDelivery & { label: string };
  lastRunStatus: string | null;
  runCount: number;
}

interface ScheduledTaskOriginChatMessage {
  id: string;
  role: "user" | "assistant";
  senderName: string;
  text: string;
  createdAt: string;
}

function compareNewestFirst(a: ScheduledTaskRow, b: ScheduledTaskRow): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

function formatDateTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

function formatCanvasTriggerLabel(triggerConfig: WorkflowTriggerConfig | null): string {
  if (triggerConfig?.type !== "canvas") return "Canvas managed trigger";

  const app = triggerConfig.app;
  const event = triggerConfig.eventDescription;
  if (app && event) return `Canvas managed: ${app} - ${event}`;
  if (app) return `Canvas managed: ${app}`;
  if (event) return `Canvas managed: ${event}`;
  return "Canvas managed trigger";
}

function formatScheduleLabel(row: ScheduledTaskRow, triggerConfig: WorkflowTriggerConfig | null): string {
  if (row.schedule_type === "external") {
    if (row.schedule_value === "canvas") return formatCanvasTriggerLabel(triggerConfig);
    return "External trigger";
  }

  if (row.schedule_type === "interval") {
    return formatIntervalScheduleLabel(row.schedule_value);
  }

  if (row.schedule_type === "once") {
    return `Once on ${formatDateTime(row.schedule_value, row.timezone)}`;
  }

  return `Cron: ${row.schedule_value} (${row.timezone})`;
}

function parseTriggerConfig(stepsValue: string | null): WorkflowTriggerConfig | null {
  if (!stepsValue) return null;
  try {
    const steps = JSON.parse(stepsValue) as WorkflowStep[];
    if (!Array.isArray(steps)) return null;
    const triggerStep = steps.find((step) => step?.type === "trigger" && step.triggerConfig);
    return triggerStep?.triggerConfig ?? null;
  } catch {
    return null;
  }
}

function isLocalScheduleType(value: string): value is "cron" | "interval" | "once" {
  return value === "cron" || value === "interval" || value === "once";
}

function getTargetKindLabel(row: ScheduledTaskRow): ScheduledTaskListItem["targetKindLabel"] {
  if (row.platform === "slack" && row.context_type === "channel") return "Slack channel";
  if (row.platform === "slack") return "Slack DM";
  if (row.context_type === "group") return "WhatsApp group";
  return "WhatsApp DM";
}

function toOriginChatMessage(message: StoredConversationMessage): ScheduledTaskOriginChatMessage {
  const text = message.text.trim() || (message.attachments.length > 0 ? "See attached files." : "");
  return {
    id: String(message.id),
    role: message.isBot ? "assistant" : "user",
    senderName: message.senderName,
    text: message.isBot ? text : `${message.senderName}: ${text}`,
    createdAt: message.receivedAt,
  };
}

async function buildTaskListItems(db: Kysely<DB>, rows: ScheduledTaskRow[]): Promise<ScheduledTaskListItem[]> {
  const users = createUserRepository(db);
  const channels = createChannelRepository(db);
  const whatsappGroups = createWhatsAppGroupRepository(db);
  const runsRepo = createAutomationRunsRepository(db);

  const userIds = [...new Set(rows.map((row) => row.created_by).filter((id): id is string => Boolean(id)))];
  const slackChannelIds = [
    ...new Set(
      rows.flatMap((row) => {
        const ids: string[] = [];
        if (row.platform === "slack" && row.context_type === "channel") ids.push(row.delivery_target);
        const delivery = resolveWorkflowDelivery(row);
        if (delivery.platform === "slack" && (delivery.targetType === "channel" || delivery.targetType === "thread")) {
          ids.push(delivery.targetId);
        }
        return ids;
      }),
    ),
  ];
  const slackUserIds = [
    ...new Set(
      rows.flatMap((row) => {
        const ids: string[] = [];
        const delivery = resolveWorkflowDelivery(row);
        if (delivery.platform === "slack" && delivery.targetType === "dm" && isSlackUserId(delivery.targetId)) {
          ids.push(delivery.targetId);
        }
        return ids;
      }),
    ),
  ];
  const whatsappGroupJids = [
    ...new Set(
      rows.flatMap((row) => {
        const jids: string[] = [];
        if (row.platform === "whatsapp" && row.context_type === "group") jids.push(row.delivery_target);
        const delivery = resolveWorkflowDelivery(row);
        if (delivery.platform === "whatsapp" && delivery.targetType === "group") jids.push(delivery.targetId);
        return jids;
      }),
    ),
  ];

  const userEntries = await Promise.all(
    userIds.map(async (id) => {
      const user = await users.findById(id);
      return [id, user?.name ?? null] as const;
    }),
  );
  const channelEntries = await Promise.all(
    slackChannelIds.map(async (id) => {
      const channel = await channels.findBySlackChannelId(id);
      return [id, channel?.name ?? null] as const;
    }),
  );
  const slackUserEntries = await Promise.all(
    slackUserIds.map(async (id) => {
      const user = await users.findBySlackId(id);
      return [id, user?.name ?? user?.email ?? null] as const;
    }),
  );
  const groupEntries = await Promise.all(
    whatsappGroupJids.map(async (jid) => {
      const group = await whatsappGroups.getByJid(jid);
      return [jid, group?.name ?? null] as const;
    }),
  );

  const creatorNames = new Map(userEntries);
  const channelNames = new Map(channelEntries);
  const slackUserNames = new Map(slackUserEntries);
  const groupNames = new Map(groupEntries);

  // Single grouped query — avoids N+1 per task.
  const runData = await runsRepo.getRunSummaries(rows.map((r) => r.id));

  return rows.map((row) => {
    const creatorName = row.created_by ? (creatorNames.get(row.created_by) ?? null) : null;

    let targetLabel = row.delivery_target;
    if (row.platform === "slack" && row.context_type === "channel") {
      targetLabel = channelNames.get(row.delivery_target)
        ? `#${channelNames.get(row.delivery_target)}`
        : row.delivery_target;
    } else if (row.context_type === "dm" && creatorName) {
      targetLabel = creatorName;
    } else if (row.platform === "whatsapp" && row.context_type === "group") {
      targetLabel = groupNames.get(row.delivery_target) ?? row.delivery_target;
    }

    const normalizedSteps = isLocalScheduleType(row.schedule_type)
      ? normalizeScheduleTriggerStepsJson(row.steps, {
          scheduleType: row.schedule_type,
          scheduleValue: row.schedule_value,
          timezone: row.timezone,
        })
      : row.steps;

    let stepCount = 0;
    if (normalizedSteps) {
      try {
        stepCount = JSON.parse(normalizedSteps).length;
      } catch {}
    }
    const triggerConfig = parseTriggerConfig(normalizedSteps ?? null);

    const rd = runData.get(row.id);
    const delivery = resolveWorkflowDelivery(row);
    let deliveryLabel = delivery.targetId;
    if (delivery.platform === "slack" && (delivery.targetType === "channel" || delivery.targetType === "thread")) {
      deliveryLabel = channelNames.get(delivery.targetId)
        ? `#${channelNames.get(delivery.targetId)}`
        : delivery.targetId;
      if (delivery.threadTs) deliveryLabel = `${deliveryLabel} · thread`;
    } else if (delivery.platform === "whatsapp" && delivery.targetType === "group") {
      deliveryLabel = groupNames.get(delivery.targetId) ?? delivery.targetId;
    } else if (delivery.platform === "slack" && delivery.targetType === "dm" && isSlackUserId(delivery.targetId)) {
      deliveryLabel = slackUserNames.get(delivery.targetId) ?? delivery.targetId;
    } else if (delivery.targetType === "dm" && creatorName && delivery.targetId === row.delivery_target) {
      deliveryLabel = creatorName;
    }

    return {
      id: row.id,
      platform: row.platform as "slack" | "whatsapp",
      contextType: row.context_type as "dm" | "channel" | "group",
      deliveryTarget: row.delivery_target,
      threadTs: row.thread_ts,
      prompt: row.prompt,
      scheduleType: row.schedule_type as "cron" | "interval" | "once" | "external",
      scheduleValue: row.schedule_value,
      timezone: row.timezone,
      sessionMode: "fresh",
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      status: row.status as "active" | "paused" | "completed",
      createdBy: row.created_by,
      createdAt: row.created_at,
      targetLabel,
      targetKindLabel: getTargetKindLabel(row),
      creatorName,
      scheduleLabel: formatScheduleLabel(row, triggerConfig),
      canPause: row.status === "active",
      canResume: row.status === "paused",
      canDelete: true,
      title: row.title,
      description: row.description,
      originChat:
        row.origin_conversation_id &&
        (row.origin_platform === "web" || row.origin_platform === "slack" || row.origin_platform === "whatsapp")
          ? {
              platform: row.origin_platform,
              conversationId: row.origin_conversation_id,
              providerThreadId: row.origin_provider_thread_id,
              currentMessageId: row.origin_message_id,
            }
          : null,
      steps: normalizedSteps ?? null,
      stepCount,
      triggerConfig,
      outputTarget: row.output_target,
      outputPlatform: row.output_platform,
      outputThreadTs: row.output_thread_ts,
      outputMode: row.output_mode === "silent" ? "silent" : "deliver",
      delivery: { ...delivery, label: deliveryLabel },
      lastRunStatus: rd?.lastRunStatus ?? null,
      runCount: rd?.runCount ?? 0,
    };
  });
}

export function scheduledTaskRoutes(
  db: Kysely<DB>,
  scheduler: ScheduledTaskMutationDeps,
  options: ScheduledTaskRouteOptions = {},
) {
  const routes = new Hono();
  const repo = createScheduledTaskRepository(db);
  const users = createUserRepository(db);
  const logger = options.logger;

  // sub can be a user UUID (managed SSO, local JWT) or an email (legacy local JWT).
  // Follows the precedent in api/users.ts:223-233.
  async function resolveUserId(sub: string | undefined): Promise<string | null> {
    if (!sub) return null;
    if (sub.includes("@")) {
      const user = await users.findByEmail(sub);
      return user?.id ?? null;
    }
    const user = await users.findById(sub);
    return user?.id ?? null;
  }

  async function loadAccessibleTask(c: Context, id: string) {
    const row = await repo.getById(id);
    if (!row) {
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    const userId = await resolveUserId(c.get("sub"));
    const accessibleRow = resolveScheduledTaskAccess(row, row.created_by, {
      userId,
      role: c.get("role"),
    });
    if (!accessibleRow) {
      logger?.warn(
        { userId, taskId: id, ownerUserId: row.created_by },
        "scheduled-tasks: member denied access to task",
      );
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    return { row: accessibleRow };
  }

  async function loadFullDefinition(row: ScheduledTaskRow) {
    const stepContentRepo = createAutomationStepContentRepository(db);
    const runsRepo = createAutomationRunsRepository(db);
    const [stepContentRows, runRows, owner, editor] = await Promise.all([
      stepContentRepo.getByTask(row.id),
      runsRepo.list(row.id),
      row.created_by ? users.findById(row.created_by) : Promise.resolve(undefined),
      row.last_edited_by ? users.findById(row.last_edited_by) : Promise.resolve(undefined),
    ]);
    return buildAutomationDefinition({
      row,
      stepContentRows,
      runRows,
      createdByName: owner?.name ?? null,
      lastEditedByName: editor?.name ?? null,
    });
  }

  async function hasBrokerCapableProvider(): Promise<boolean> {
    if (!options.loadIntegrationProvider) return false;
    const provider = await options.loadIntegrationProvider();
    return Boolean(provider?.isBrokerCapable());
  }

  routes.get("/", async (c) => {
    const role = c.get("role");
    const userId = await resolveUserId(c.get("sub"));

    let rows: ScheduledTaskRow[];
    if (role === "admin" && userId) {
      rows = await repo.listAll();
    } else if (userId) {
      rows = await repo.listByCreatedBy(userId);
    } else {
      rows = [];
    }

    rows.sort(compareNewestFirst);

    return c.json({ tasks: await buildTaskListItems(db, rows) });
  });

  routes.get("/:id/origin-chat/messages", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    const originPlatform = result.row.origin_platform;
    const originConversationId = result.row.origin_conversation_id;
    if (!originConversationId || (originPlatform !== "slack" && originPlatform !== "whatsapp")) {
      return c.json({ messages: [] as ScheduledTaskOriginChatMessage[] });
    }

    const conversationId = Number(originConversationId);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      return c.json({ messages: [] as ScheduledTaskOriginChatMessage[] });
    }

    const conversations = createConversationRepository(db);
    const resultMessages = await conversations.listMessages(conversationId, {
      order: "desc",
      limit: 50,
      includeBotMessages: true,
      beforeMessageId: result.row.origin_message_id ? result.row.origin_message_id + 1 : undefined,
      providerThreadId: result.row.origin_provider_thread_id ?? undefined,
    });
    return c.json({ messages: resultMessages.messages.reverse().map(toOriginChatMessage) });
  });

  routes.get("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    return c.json({ automation: await loadFullDefinition(result.row) });
  });

  routes.put("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!scheduler.refreshTaskSchedule) {
      return c.json({ error: { code: "SCHEDULER_UNAVAILABLE", message: "Scheduler refresh is unavailable" } }, 503);
    }

    let request: ReturnType<typeof parseAutomationBuilderSaveRequest>;
    try {
      request = parseAutomationBuilderSaveRequest(await c.req.json());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid automation definition";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const brokerCapable = request.steps.some((step) => workflowStepUsesIntegrationActions(step))
      ? await hasBrokerCapableProvider()
      : true;
    const userId = await resolveUserId(c.get("sub"));
    let saveResult: Awaited<ReturnType<typeof replaceAutomationDefinition>>;
    try {
      saveResult = await replaceAutomationDefinition({
        db,
        taskId: id,
        request,
        actor: { userId, canManageAnyTask: c.get("role") === "admin" },
        brokerCapable,
      });
    } catch (err) {
      if (err instanceof AutomationValidationError) {
        logger?.warn(
          { taskId: id, issueCodes: err.issues.map((issue) => issue.code) },
          "scheduled-tasks: builder save validation failed",
        );
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "Automation definition is invalid", issues: err.issues } },
          400,
        );
      }
      throw err;
    }

    if (saveResult.kind === "not_found") {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    if (saveResult.kind === "revision_conflict") {
      return c.json(
        {
          error: {
            code: "REVISION_CONFLICT",
            message: "Automation was changed by another editor",
            currentRevision: saveResult.currentRevision,
          },
        },
        409,
      );
    }

    await scheduler.refreshTaskSchedule(id);
    const refreshed = (await repo.getById(id)) ?? saveResult.row;
    return c.json({ automation: await loadFullDefinition(refreshed) });
  });

  routes.post("/:id/runs", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    if (result.row.status !== "active") {
      return c.json({ error: { code: "INVALID_STATE", message: "Only active automations can be triggered" } }, 400);
    }

    scheduler.executeTaskById(id).catch(() => {});
    return c.json({ status: "triggered" });
  });

  routes.post("/:id/steps/:stepId/runs", async (c) => {
    const id = c.req.param("id");
    const stepId = c.req.param("stepId");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!scheduler.executeStepById) {
      return c.json({ error: { code: "SCHEDULER_UNAVAILABLE", message: "Step testing is unavailable" } }, 503);
    }

    const body = await c.req.json().catch(() => ({}));
    const input =
      typeof body === "object" && body !== null && "input" in body ? (body as { input: unknown }).input : undefined;
    const useLatestUpstreamOutput =
      typeof body === "object" &&
      body !== null &&
      "useLatestUpstreamOutput" in body &&
      (body as { useLatestUpstreamOutput: unknown }).useLatestUpstreamOutput === true;
    try {
      const run = await scheduler.executeStepById(id, stepId, { input, useLatestUpstreamOutput });
      return c.json({ run });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Step test failed";
      return c.json({ error: { code: "STEP_TEST_FAILED", message } }, 400);
    }
  });

  routes.post("/:id/pause", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    if (result.row.status === "completed") {
      return c.json({ error: { code: "INVALID_STATE", message: "Completed tasks cannot be paused" } }, 400);
    }

    if (result.row.status !== "paused") {
      await scheduler.pauseTask(id);
    }

    const updated = await repo.getById(id);
    return c.json({ task: (await buildTaskListItems(db, [updated ?? result.row]))[0] });
  });

  routes.post("/:id/resume", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    if (result.row.status === "completed") {
      return c.json({ error: { code: "INVALID_STATE", message: "Completed tasks cannot be resumed" } }, 400);
    }

    if (result.row.status !== "active") {
      await scheduler.resumeTask(id);
    }

    const updated = await repo.getById(id);
    return c.json({ task: (await buildTaskListItems(db, [updated ?? result.row]))[0] });
  });

  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const access = await loadAccessibleTask(c, id);
    if ("response" in access) return access.response;
    if (!scheduler.removeTaskRuntime) {
      return c.json(
        { error: { code: "SCHEDULER_UNAVAILABLE", message: "Scheduler runtime cleanup is unavailable" } },
        503,
      );
    }
    const userId = await resolveUserId(c.get("sub"));
    const deletion = await deleteAutomation({
      db,
      taskId: id,
      actor: { userId, canManageAnyTask: c.get("role") === "admin" },
      scheduler: { removeTaskRuntime: scheduler.removeTaskRuntime },
    });
    if (deletion.kind === "not_found" || deletion.kind === "access_denied") {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    if (deletion.kind === "scheduler_failure") {
      logger?.error(
        { err: deletion.error, taskId: id },
        "scheduled-tasks: database deletion committed before scheduler failure",
      );
      return c.json(
        {
          error: {
            code: "SCHEDULER_INCONSISTENT",
            message: "Automation was deleted from the database, but scheduler cleanup failed.",
          },
        },
        503,
      );
    }
    return c.json({ success: true });
  });

  // --- Automation runs endpoints ---

  routes.get("/:id/runs", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    const runsRepo2 = createAutomationRunsRepository(db);
    const runs = await runsRepo2.list(id);
    return c.json({ runs });
  });

  routes.get("/:id/step-content", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    const stepContentRepo = createAutomationStepContentRepository(db);
    const stepContent = await stepContentRepo.getByTask(id);
    return c.json({ stepContent });
  });

  routes.get("/:id/runs/:runId", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    const runsRepo2 = createAutomationRunsRepository(db);
    const run = await runsRepo2.getById(runId);
    if (!run || run.task_id !== id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run not found" } }, 404);
    }
    return c.json({ run });
  });

  routes.post("/:id/run", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    if (result.row.status !== "active") {
      return c.json({ error: { code: "INVALID_STATE", message: "Only active automations can be triggered" } }, 400);
    }

    // Fire and forget — enqueue execution
    scheduler.executeTaskById(id).catch(() => {});
    return c.json({ status: "triggered" });
  });

  return routes;
}
