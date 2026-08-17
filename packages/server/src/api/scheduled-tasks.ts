import { randomUUID } from "node:crypto";
import { automationExecutionModeSchema, workflowStepUsesIntegrationActions } from "@sketch/shared";
import { type Context, Hono } from "hono";
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import {
  AutomationValidationError,
  addWebhookEndpointMetadata,
  buildAutomationDefinition,
  isAutomationPlaceholderDraft,
  isStrictAutomationPlaceholderRow,
  parseAutomationBuilderSaveRequest,
} from "../automation/definition";
import {
  acquireOrRenewLock,
  approveSteal,
  authorizeAuthoringLease,
  denySteal,
  releaseLock,
  requestSteal,
} from "../automation/lock-service";
import type { AuthoringLeaseAuthorization } from "../automation/lock-service";
import {
  createAutomationDraft,
  deleteAutomation,
  replaceAutomationDefinition,
  selectAutomationSetupExecutionMode,
} from "../automation/persistence";
import { parseAutomationTriggerConfig } from "../automation/webhook";
import type { AutomationTaskLockRow, LockHolderFields } from "../db/repositories/automation-locks";

import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createChannelRepository } from "../db/repositories/channels";
import { type StoredConversationMessage, createConversationRepository } from "../db/repositories/conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import { createWebhookEndpointRepository } from "../db/repositories/webhook-endpoints";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB, ScheduledTasksTable } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import { resolveScheduledTaskAccess } from "../scheduler/access";
import { formatIntervalScheduleLabel, normalizeScheduleTriggerStepsJson } from "../scheduler/trigger-metadata";
import type { SlackBot } from "../slack/bot";
import { notifyStealRequested } from "../whatsapp/lock-confirmations";
import { phoneE164ToWhatsAppJid } from "../whatsapp/provider";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { type WorkflowDelivery, isSlackUserId, resolveWorkflowDelivery } from "../workflows/delivery";
import type { WorkflowStep } from "../workflows/types";

type ScheduledTaskRow = Selectable<ScheduledTasksTable>;
type WorkflowTriggerConfig = NonNullable<WorkflowStep["triggerConfig"]>;

interface ScheduledTaskMutationDeps {
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  removeTask: (id: string) => Promise<boolean>;
  removeTaskRuntime?: (id: string) => Promise<boolean>;
  executeTaskById: (
    id: string,
    options?: {
      preserveTaskState?: boolean;
      runMode?: "production" | "manual" | "test";
      runId?: string;
      triggeredByUserId?: string | null;
    },
  ) => Promise<unknown>;
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
  baseUrl?: string | null;
  port?: number;
  encryptionKey?: string;
  getSlack?: () => SlackBot | null;
  whatsappRuntime?: WhatsAppRuntime;
  validateAgentSkills?: (
    ownerUserId: string,
    skillIds: string[],
    taskContext?: {
      platform: "slack" | "whatsapp";
      contextType: "dm" | "channel" | "group";
      deliveryTarget: string;
      createdBy?: string | null;
    },
  ) => Promise<string[]>;
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
  isOwner: boolean;
  sharedWithMe: boolean;
  canShare: boolean;
  canEdit: boolean;
  shareCount: number;
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

interface AutomationShareSummary {
  userId: string;
  name: string | null;
  email: string | null;
  grantedByUserId: string;
  grantedAt: string;
}

interface ScheduledTaskOriginChatMessage {
  id: string;
  role: "user" | "assistant";
  senderName: string;
  text: string;
  createdAt: string;
}

interface AutomationLockView {
  heldByUserId: string;
  heldByName: string | null;
  heldByPlatform: string;
  heldBySurface: string;
  generation: number;
  expiresAt: string;
  isHeldByMe: boolean;
  isHeldByMyOtherSession: boolean;
  stealPending: { requesterName: string | null; expiresAt: string } | null;
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
  if (triggerConfig?.type === "webhook") return "Sketch webhook";
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

function parseTriggerConfig(
  stepsValue: string | null,
  fallback: { scheduleType: string; scheduleValue: string },
): WorkflowTriggerConfig | null {
  return parseAutomationTriggerConfig(stepsValue, fallback) ?? null;
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

async function buildTaskListItems(
  db: Kysely<DB>,
  rows: ScheduledTaskRow[],
  options: Pick<ScheduledTaskRouteOptions, "baseUrl" | "port" | "encryptionKey"> & {
    viewer: { userId: string | null; grantedTaskIds: ReadonlySet<string>; role?: string };
  },
): Promise<ScheduledTaskListItem[]> {
  const users = createUserRepository(db);
  const channels = createChannelRepository(db);
  const whatsappGroups = createWhatsAppGroupRepository(db);
  const runsRepo = createAutomationRunsRepository(db);
  const webhookEndpoints = createWebhookEndpointRepository(db, options.encryptionKey);
  const endpointEntries = await Promise.all(
    rows.map(async (row) => [row.id, await webhookEndpoints.getByTaskId(row.id)] as const),
  );
  const endpointByTaskId = new Map(endpointEntries);

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

  const shareCounts = await loadShareCounts(
    db,
    rows.map((row) => row.id),
  );

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
    const endpoint = endpointByTaskId.get(row.id);
    const triggerConfig = parseTriggerConfig(normalizedSteps ?? null, {
      scheduleType: row.schedule_type,
      scheduleValue: row.schedule_value,
    });
    const metadataTriggerConfig = triggerConfig
      ? addWebhookEndpointMetadata(triggerConfig, row.id, {
          endpoint,
          baseUrl: options.baseUrl,
          port: options.port,
        })
      : triggerConfig;

    const isOwner = options.viewer.userId !== null && row.created_by === options.viewer.userId;
    const isAdmin = options.viewer.role === "admin";
    const sharedWithMe = !isOwner && options.viewer.grantedTaskIds.has(row.id);
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
      canDelete: isOwner || isAdmin,
      isOwner,
      sharedWithMe,
      canShare: isOwner,
      canEdit: isOwner || isAdmin || options.viewer.grantedTaskIds.has(row.id),
      shareCount: shareCounts.get(row.id) ?? 0,
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
      triggerConfig: metadataTriggerConfig,
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

async function loadShareCounts(db: Kysely<DB>, taskIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (taskIds.length === 0) return counts;
  const rows = await db
    .selectFrom("automation_task_shares")
    .select(({ fn }) => ["task_id", fn.count("id").as("share_count")])
    .where("task_id", "in", taskIds)
    .groupBy("task_id")
    .execute();
  for (const row of rows) counts.set(row.task_id, Number(row.share_count));
  return counts;
}

async function listSharesWithNames(db: Kysely<DB>, taskId: string): Promise<AutomationShareSummary[]> {
  const rows = await db.selectFrom("automation_task_shares").selectAll().where("task_id", "=", taskId).execute();
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  const users = await db.selectFrom("users").select(["id", "name", "email"]).where("id", "in", userIds).execute();
  const userById = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({
    userId: row.user_id,
    name: userById.get(row.user_id)?.name ?? null,
    email: userById.get(row.user_id)?.email ?? null,
    grantedByUserId: row.granted_by_user_id,
    grantedAt: row.granted_at,
  }));
}

/**
 * Lock view for the web builder contract. An expired pending steal is hidden
 * (stealPending null) so the UI never renders a stale request.
 */
async function toLockView(
  row: AutomationTaskLockRow,
  viewerUserId: string | null,
  usersRepo: ReturnType<typeof createUserRepository>,
  viewerSessionId?: string,
): Promise<AutomationLockView> {
  const [holder, requester] = await Promise.all([
    usersRepo.findById(row.holder_user_id),
    row.steal_requester_user_id ? usersRepo.findById(row.steal_requester_user_id) : Promise.resolve(undefined),
  ]);
  const stealPending =
    row.steal_requester_user_id !== null &&
    row.steal_expires_at !== null &&
    row.steal_expires_at > new Date().toISOString()
      ? { requesterName: requester?.name ?? null, expiresAt: row.steal_expires_at }
      : null;
  const sameUser = viewerUserId !== null && row.holder_user_id === viewerUserId;
  return {
    heldByUserId: row.holder_user_id,
    heldByName: holder?.name ?? null,
    heldByPlatform: row.holder_platform,
    heldBySurface: row.holder_surface,
    generation: row.generation,
    expiresAt: row.expires_at,
    isHeldByMe: sameUser && (viewerSessionId === undefined || row.holder_session_id === viewerSessionId),
    isHeldByMyOtherSession: sameUser && viewerSessionId !== undefined && row.holder_session_id !== viewerSessionId,
    stealPending,
  };
}

export function scheduledTaskRoutes(
  db: Kysely<DB>,
  scheduler: ScheduledTaskMutationDeps,
  options: ScheduledTaskRouteOptions = {},
) {
  const routes = new Hono();
  const repo = createScheduledTaskRepository(db);
  const sharesRepo = createAutomationSharesRepository(db);
  const users = createUserRepository(db);
  const logger = options.logger;
  const runsRepo = createAutomationRunsRepository(db);

  async function markReservedRunFailed(runId: string, error: unknown): Promise<void> {
    const current = await runsRepo.getById(runId).catch(() => undefined);
    if (!current || current.status !== "running") return;
    await runsRepo.update(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  type ManualRunReservation =
    | { kind: "reserved"; runId: string }
    | {
        kind: "lease_denied";
        authorization: Extract<AuthoringLeaseAuthorization, { kind: "conflict" | "stale" }>;
      }
    | { kind: "failed" };

  async function reserveManualRun(
    taskId: string,
    triggeredByUserId: string | null,
    lease: { clientSessionId: string; generation?: number } | undefined,
  ): Promise<ManualRunReservation> {
    const runId = randomUUID();
    try {
      return await db.transaction().execute(async (trx) => {
        const authorization = await authorizeAuthoringLease(trx, {
          taskId,
          userId: triggeredByUserId,
          sessionId: lease?.clientSessionId,
          generation: lease?.generation,
        });
        if (authorization.kind === "conflict" || authorization.kind === "stale") {
          return { kind: "lease_denied" as const, authorization };
        }

        await createAutomationRunsRepository(trx).create({
          id: runId,
          taskId,
          triggerData: { type: "manual" },
          triggeredByUserId,
        });
        return { kind: "reserved" as const, runId };
      });
    } catch (error) {
      logger?.error({ err: error, taskId, runId }, "scheduled-tasks: failed to reserve manual run");
      return { kind: "failed" };
    }
  }

  async function enqueueReservedManualRun(
    taskId: string,
    runId: string,
    triggeredByUserId?: string | null,
  ): Promise<boolean> {
    try {
      const execution = scheduler.executeTaskById(taskId, {
        preserveTaskState: true,
        runMode: "manual",
        runId,
        triggeredByUserId: triggeredByUserId ?? null,
      });
      void Promise.resolve(execution)
        .then((run) => {
          if (run === null) return markReservedRunFailed(runId, `Task ${taskId} is no longer runnable`);
          if (typeof run === "object" && run !== null && "status" in run && run.status === "failed") {
            return markReservedRunFailed(runId, "Automation run failed");
          }
          return undefined;
        })
        .catch((error) => markReservedRunFailed(runId, error))
        .catch((error) =>
          logger?.error({ err: error, taskId, runId }, "scheduled-tasks: failed to record run failure"),
        );
      return true;
    } catch (error) {
      await markReservedRunFailed(runId, error);
      logger?.error({ err: error, taskId, runId }, "scheduled-tasks: failed to enqueue manual run");
      return false;
    }
  }

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

  async function loadGrantedTaskIds(userId: string | null): Promise<Set<string>> {
    if (!userId) return new Set<string>();
    return new Set(await sharesRepo.listTaskIdsForUser(userId));
  }

  async function loadAccessibleTask(
    c: Context,
    id: string,
  ): Promise<{ response: Response } | { row: ScheduledTaskRow; userId: string | null; grantedTaskIds: Set<string> }> {
    const row = await repo.getById(id);
    if (!row) {
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    const userId = await resolveUserId(c.get("sub"));
    const hasGrant = userId ? await sharesRepo.hasGrant(id, userId) : false;
    const grantedUserIds = hasGrant && userId ? new Set([userId]) : new Set<string>();
    const accessibleRow = resolveScheduledTaskAccess(row, row.created_by, grantedUserIds, {
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
    return {
      row: accessibleRow,
      userId,
      grantedTaskIds: hasGrant && userId ? new Set([id]) : new Set<string>(),
    };
  }

  async function loadOwnedTask(
    c: Context,
    id: string,
  ): Promise<{ response: Response } | { row: ScheduledTaskRow; userId: string; grantedTaskIds: Set<string> }> {
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result;
    if (!result.userId || result.userId !== result.row.created_by) {
      logger?.warn(
        { userId: result.userId, taskId: id, ownerUserId: result.row.created_by },
        "scheduled-tasks: non-owner denied ownership operation",
      );
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    return { row: result.row, userId: result.userId, grantedTaskIds: result.grantedTaskIds };
  }

  async function loadDeletableTask(
    c: Context,
    id: string,
  ): Promise<{ response: Response } | { row: ScheduledTaskRow; userId: string; grantedTaskIds: Set<string> }> {
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result;
    if (!result.userId || (result.userId !== result.row.created_by && c.get("role") !== "admin")) {
      logger?.warn(
        { userId: result.userId, taskId: id, ownerUserId: result.row.created_by },
        "scheduled-tasks: non-owner non-admin denied deletion",
      );
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    return { row: result.row, userId: result.userId, grantedTaskIds: result.grantedTaskIds };
  }

  async function loadFullDefinition(
    row: ScheduledTaskRow,
    viewer: {
      userId: string | null;
      grantedTaskIds: ReadonlySet<string>;
      role?: string;
      sessionId?: string;
    },
  ) {
    const stepContentRepo = createAutomationStepContentRepository(db);
    const runsRepo = createAutomationRunsRepository(db);
    const [stepContentRows, runRows, owner, editor, webhookEndpoint, lockRow] = await Promise.all([
      stepContentRepo.getByTask(row.id),
      runsRepo.list(row.id),
      row.created_by ? users.findById(row.created_by) : Promise.resolve(undefined),
      row.last_edited_by ? users.findById(row.last_edited_by) : Promise.resolve(undefined),
      createWebhookEndpointRepository(db, options.encryptionKey).getByTaskId(row.id),
      createAutomationLocksRepository(db).getByTaskId(row.id),
    ]);
    const definition = await buildAutomationDefinition({
      row,
      stepContentRows,
      runRows,
      createdByName: owner?.name ?? null,
      lastEditedByName: editor?.name ?? null,
      webhookBaseUrl: options.baseUrl,
      webhookPort: options.port,
      webhookEndpoint,
    });
    const isOwner = viewer.userId !== null && row.created_by === viewer.userId;
    const isAdmin = viewer.role === "admin";
    return {
      ...definition,
      isOwner,
      canShare: isOwner,
      canEdit: isOwner || isAdmin || viewer.grantedTaskIds.has(row.id),
      shares: isOwner ? await listSharesWithNames(db, row.id) : [],
      // Lazy expiry on access: an expired lock is not a lock — hide it from the view.
      ...(lockRow && lockRow.expires_at > new Date().toISOString()
        ? { lock: await toLockView(lockRow, viewer.userId, users, viewer.sessionId) }
        : {}),
    };
  }

  async function hasBrokerCapableProvider(): Promise<boolean> {
    if (!options.loadIntegrationProvider) return false;
    const provider = await options.loadIntegrationProvider();
    return Boolean(provider?.isBrokerCapable());
  }

  routes.post("/", async (c) => {
    const userId = await resolveUserId(c.get("sub"));
    const currentUser = userId ? await users.findById(userId) : undefined;
    if (!currentUser) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "User identity could not be resolved" } }, 401);
    }

    const builderConversationId = `builder-${randomUUID()}`;
    try {
      const result = await createAutomationDraft({
        db,
        context: {
          platform: "slack",
          contextType: "dm",
          deliveryTarget: currentUser.slack_user_id ?? currentUser.id,
          threadTs: null,
          createdBy: currentUser.id,
          originPlatform: "web",
          originConversationId: builderConversationId,
          originProviderThreadId: null,
          originMessageId: null,
        },
        timezone: currentUser.timezone ?? "UTC",
        taskConversationAssociation: {
          conversationId: builderConversationId,
          transcriptUserId: currentUser.id,
          kind: "builder",
        },
      });

      return c.json({ automationId: result.row.id, conversationId: builderConversationId }, 201);
    } catch (error) {
      logger?.error({ err: error, userId: currentUser.id }, "scheduled-tasks: failed to create automation draft");
      return c.json({ error: { code: "CREATION_FAILED", message: "Automation could not be created" } }, 500);
    }
  });

  routes.get("/", async (c) => {
    const userId = await resolveUserId(c.get("sub"));
    if (!userId) {
      return c.json({ tasks: [] });
    }
    const grantedTaskIds = await loadGrantedTaskIds(userId);
    const isAdmin = c.get("role") === "admin";

    let rows: ScheduledTaskRow[] = isAdmin ? await repo.listAll() : await repo.listAccessibleByUser(userId);

    const stepContentRepo = createAutomationStepContentRepository(db);
    rows = (
      await Promise.all(
        rows.map(async (row) => {
          if (!isStrictAutomationPlaceholderRow(row)) return row;
          const [stepContentRows, runRows] = await Promise.all([
            stepContentRepo.getByTask(row.id),
            runsRepo.list(row.id),
          ]);
          return isAutomationPlaceholderDraft({ row, stepContentRows, runRows }) ? null : row;
        }),
      )
    ).filter((row): row is ScheduledTaskRow => row !== null);

    rows.sort(compareNewestFirst);

    return c.json({
      tasks: await buildTaskListItems(db, rows, {
        baseUrl: options.baseUrl,
        port: options.port,
        encryptionKey: options.encryptionKey,
        viewer: { userId, grantedTaskIds, role: c.get("role") },
      }),
    });
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
    const clientSessionId = c.req.query("clientSessionId")?.trim();
    const viewerSessionId = clientSessionId && clientSessionId.length <= 200 ? clientSessionId : undefined;
    return c.json({
      automation: await loadFullDefinition(result.row, {
        userId: result.userId,
        grantedTaskIds: result.grantedTaskIds,
        role: c.get("role"),
        sessionId: viewerSessionId,
      }),
    });
  });

  // --- Edit-lock endpoints (pessimistic whole-automation locks) ---
  // Lock holders carry their known chat surface when they have one so steal
  // notifications can be delivered; pure web builders stay on the builder
  // surface, whose polling owns approval.

  /**
   * Lock-holder surface for web API lock acquisition. Web users with a chat
   * identity record that surface (so steal notifications and outcomes can be
   * delivered); pure web users stay on the builder surface, whose polling owns
   * approval.
   */
  async function webLockHolderFor(userId: string): Promise<LockHolderFields> {
    const user = await users.findById(userId);
    if (user?.slack_user_id) {
      return { userId, platform: "slack", surface: "dm", conversationId: user.slack_user_id };
    }
    if (user?.whatsapp_number) {
      return {
        userId,
        platform: "whatsapp",
        surface: "dm",
        conversationId: phoneE164ToWhatsAppJid(user.whatsapp_number),
      };
    }
    return { userId, platform: "web", surface: "builder", conversationId: null };
  }

  function parseLeaseRequestBody(body: unknown): { clientSessionId: string; generation?: number } | null {
    if (typeof body !== "object" || body === null) return null;
    const value = body as { clientSessionId?: unknown; generation?: unknown };
    const clientSessionId = typeof value.clientSessionId === "string" ? value.clientSessionId.trim() : "";
    if (clientSessionId.length === 0 || clientSessionId.length > 200) return null;
    if (
      value.generation !== undefined &&
      (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1)
    ) {
      return null;
    }
    return {
      clientSessionId,
      generation: value.generation as number | undefined,
    };
  }

  async function readLeaseRequest(
    c: Context,
    options: { requireGeneration?: boolean } = {},
  ): Promise<{ clientSessionId: string; generation?: number } | { response: Response }> {
    const body = await c.req.json().catch(() => null);
    const parsed = parseLeaseRequestBody(body);
    if (!parsed || (options.requireGeneration && parsed.generation === undefined)) {
      return {
        response: c.json(
          { error: { code: "VALIDATION_ERROR", message: "clientSessionId and a valid generation are required" } },
          400,
        ),
      };
    }
    return parsed;
  }

  async function readOptionalLeaseRequest(
    c: Context,
    options: { requireGeneration?: boolean } = {},
  ): Promise<
    { body: Record<string, unknown>; lease?: { clientSessionId: string; generation?: number } } | { response: Response }
  > {
    const body = await c.req.json().catch(() => null);
    if (body === null) return { body: {} };
    if (typeof body !== "object" || Array.isArray(body)) {
      return {
        response: c.json({ error: { code: "VALIDATION_ERROR", message: "Request body must be an object" } }, 400),
      };
    }
    const record = body as Record<string, unknown>;
    const hasLeaseFields = "clientSessionId" in record || "generation" in record;
    if (!hasLeaseFields) return { body: record };
    const parsed = parseLeaseRequestBody(record);
    if (!parsed || (options.requireGeneration && parsed.generation === undefined)) {
      return {
        response: c.json(
          { error: { code: "VALIDATION_ERROR", message: "clientSessionId and a valid generation are required" } },
          400,
        ),
      };
    }
    return { body: record, lease: parsed };
  }

  async function authorizeTaskMutationLease(
    taskId: string,
    userId: string | null,
    lease: { clientSessionId: string; generation?: number } | undefined,
  ): Promise<Extract<AuthoringLeaseAuthorization, { kind: "conflict" | "stale" }> | null> {
    const authorization = await db.transaction().execute((trx) =>
      authorizeAuthoringLease(trx, {
        taskId,
        userId,
        sessionId: lease?.clientSessionId,
        generation: lease?.generation,
      }),
    );
    if (authorization.kind === "conflict" || authorization.kind === "stale") return authorization;
    return null;
  }

  async function authorizeManualRun(
    c: Context,
    taskId: string,
    userId: string | null,
    lease: { clientSessionId: string; generation?: number } | undefined,
  ): Promise<Response | null> {
    const authorization = await db.transaction().execute((trx) =>
      authorizeAuthoringLease(trx, {
        taskId,
        userId,
        sessionId: lease?.clientSessionId,
        generation: lease?.generation,
      }),
    );
    if (authorization.kind === "conflict" || authorization.kind === "stale") {
      return manualRunLeaseError(c, userId, lease, authorization);
    }
    return null;
  }

  async function taskMutationLeaseError(
    c: Context,
    userId: string | null,
    lease: { clientSessionId: string; generation?: number } | undefined,
    authorization:
      | Extract<AuthoringLeaseAuthorization, { kind: "conflict" | "stale" }>
      | { kind: "locked" | "lease_stale"; lock: AutomationTaskLockRow },
  ): Promise<Response> {
    const isStale = authorization.kind === "stale" || authorization.kind === "lease_stale";
    return c.json(
      {
        error: {
          code: isStale ? "LEASE_STALE" : "LOCKED",
          message: isStale ? "Editing session is stale" : "Automation is locked by another editor",
          lock: await toLockView(authorization.lock, userId, users, lease?.clientSessionId),
        },
      },
      409,
    );
  }

  async function manualRunLeaseError(
    c: Context,
    userId: string | null,
    lease: { clientSessionId: string; generation?: number } | undefined,
    authorization: Extract<AuthoringLeaseAuthorization, { kind: "conflict" | "stale" }>,
  ): Promise<Response> {
    return c.json(
      {
        error: {
          code: authorization.kind === "conflict" ? "LOCKED" : "LEASE_STALE",
          message:
            authorization.kind === "conflict" ? "Automation is locked by another editor" : "Editing session is stale",
          lock: await toLockView(authorization.lock, userId, users, lease?.clientSessionId),
        },
      },
      409,
    );
  }

  function leaseForPersistence(
    lease: { clientSessionId: string; generation?: number } | undefined,
  ): { sessionId: string; generation: number } | undefined {
    if (!lease || lease.generation === undefined) return undefined;
    return { sessionId: lease.clientSessionId, generation: lease.generation };
  }

  routes.post("/:id/lock", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!result.userId) {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    const leaseRequest = await readLeaseRequest(c);
    if ("response" in leaseRequest) return leaseRequest.response;
    const existing = await createAutomationLocksRepository(db).getByTaskId(id);
    const exactSessionIsActive =
      existing &&
      existing.expires_at > new Date().toISOString() &&
      existing.holder_user_id === result.userId &&
      existing.holder_session_id === leaseRequest.clientSessionId;
    if (exactSessionIsActive && leaseRequest.generation === undefined) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "generation is required to renew an active lease" } },
        400,
      );
    }
    if (
      exactSessionIsActive &&
      leaseRequest.generation !== undefined &&
      existing.generation !== leaseRequest.generation
    ) {
      const lock = await toLockView(existing, result.userId, users, leaseRequest.clientSessionId);
      logger?.warn(
        {
          taskId: id,
          userId: result.userId,
          clientSessionId: leaseRequest.clientSessionId,
          requestedGeneration: leaseRequest.generation,
          currentGeneration: existing.generation,
        },
        "scheduled-tasks: stale authoring lease acquire",
      );
      return c.json({ error: { code: "LEASE_STALE", message: "Editing session is stale", lock } }, 409);
    }
    const acquired = await acquireOrRenewLock(db, {
      taskId: id,
      holder: { ...(await webLockHolderFor(result.userId)), sessionId: leaseRequest.clientSessionId },
    });
    const lock = await toLockView(acquired.lock, result.userId, users, leaseRequest.clientSessionId);
    if (acquired.kind === "locked") {
      logger?.info(
        {
          taskId: id,
          userId: result.userId,
          clientSessionId: leaseRequest.clientSessionId,
          holderUserId: acquired.lock.holder_user_id,
          holderSessionId: acquired.lock.holder_session_id,
          generation: acquired.lock.generation,
        },
        "scheduled-tasks: authoring lease conflict",
      );
      return c.json({ error: { code: "LOCKED", message: "Automation is locked by another editor", lock } }, 409);
    }
    return c.json({ lock });
  });

  routes.delete("/:id/lock", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!result.userId) {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    const leaseRequest = await readLeaseRequest(c, { requireGeneration: true });
    if ("response" in leaseRequest) return leaseRequest.response;
    const current = await createAutomationLocksRepository(db).getByTaskId(id);
    if (
      current &&
      current.holder_user_id === result.userId &&
      current.holder_session_id === leaseRequest.clientSessionId &&
      leaseRequest.generation !== current.generation
    ) {
      const lock = await toLockView(current, result.userId, users, leaseRequest.clientSessionId);
      logger?.warn(
        {
          taskId: id,
          userId: result.userId,
          clientSessionId: leaseRequest.clientSessionId,
          requestedGeneration: leaseRequest.generation,
          currentGeneration: current.generation,
        },
        "scheduled-tasks: stale authoring lease release",
      );
      return c.json({ error: { code: "LEASE_STALE", message: "Editing session is stale", lock } }, 409);
    }
    await releaseLock(db, {
      taskId: id,
      userId: result.userId,
      sessionId: leaseRequest.clientSessionId,
      generation: leaseRequest.generation,
    });
    return c.json({ success: true });
  });

  routes.post("/:id/lock/steal", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!result.userId) {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    const leaseRequest = await readLeaseRequest(c);
    if ("response" in leaseRequest) return leaseRequest.response;
    const stolen = await requestSteal(db, {
      taskId: id,
      requester: { ...(await webLockHolderFor(result.userId)), sessionId: leaseRequest.clientSessionId },
    });
    if (stolen.kind === "not_locked") {
      return c.json({ error: { code: "NOT_LOCKED", message: "Automation is not locked by another editor" } }, 409);
    }
    const lock = await toLockView(stolen.lock, result.userId, users, leaseRequest.clientSessionId);
    if (stolen.kind === "locked") {
      return c.json({ error: { code: "LOCKED", message: "A steal request is already pending", lock } }, 409);
    }
    if (logger) {
      void notifyStealRequested({
        db,
        logger,
        taskId: id,
        senders: {
          ...(options.getSlack
            ? {
                slack: {
                  postLockStealRequest: async (p: {
                    channelId: string;
                    taskId: string;
                    requesterName: string;
                    taskTitle: string;
                  }) => {
                    const slack = options.getSlack?.();
                    if (!slack) return;
                    return slack.postLockStealRequestMessage(p.channelId, p);
                  },
                  sendText: async (channelId: string, text: string) => {
                    const slack = options.getSlack?.();
                    if (!slack) return;
                    return slack.postMessage(channelId, text);
                  },
                },
              }
            : {}),
          ...(options.whatsappRuntime
            ? {
                whatsapp: {
                  sendText: async (target: Parameters<WhatsAppRuntime["sendText"]>[0], text: string) =>
                    options.whatsappRuntime?.sendText(target, text),
                },
              }
            : {}),
        },
      }).catch((err) => {
        logger.warn({ err, taskId: id }, "Steal request notification delivery failed");
      });
    }
    return c.json({ status: "pending", lock });
  });

  routes.post("/:id/lock/steal/response", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!result.userId) {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const approve =
      body && typeof body === "object" && typeof (body as { approve?: unknown }).approve === "boolean"
        ? (body as { approve: boolean }).approve
        : null;
    if (approve === null) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "approve must be a boolean" } }, 400);
    }
    const leaseRequest = parseLeaseRequestBody(body);
    if (!leaseRequest || leaseRequest.generation === undefined) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "clientSessionId and a valid generation are required" } },
        400,
      );
    }
    const responded = approve
      ? await approveSteal(db, {
          taskId: id,
          approverUserId: result.userId,
          approverSessionId: leaseRequest.clientSessionId,
          approverGeneration: leaseRequest.generation,
        })
      : await denySteal(db, {
          taskId: id,
          holderUserId: result.userId,
          holderSessionId: leaseRequest.clientSessionId,
          holderGeneration: leaseRequest.generation,
        });
    if (responded.kind === "not_found" || responded.kind === "not_holder") {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    if (responded.kind === "no_pending_steal") {
      return c.json({ error: { code: "NO_PENDING_STEAL", message: "There is no pending steal request" } }, 409);
    }
    return c.json({
      status: responded.kind,
      lock: await toLockView(responded.lock, result.userId, users, leaseRequest.clientSessionId),
    });
  });

  routes.get("/:id/shares", async (c) => {
    const id = c.req.param("id");
    const result = await loadOwnedTask(c, id);
    if ("response" in result) return result.response;
    return c.json({ shares: await listSharesWithNames(db, id) });
  });

  routes.put("/:id/shares/:userId", async (c) => {
    const id = c.req.param("id");
    const result = await loadOwnedTask(c, id);
    if ("response" in result) return result.response;
    const targetUserId = c.req.param("userId");
    if (targetUserId === result.userId) {
      return c.json({ error: { code: "INVALID_TARGET", message: "Cannot share an automation with yourself" } }, 400);
    }
    const target = await users.findById(targetUserId);
    if (!target) {
      return c.json({ error: { code: "INVALID_TARGET", message: "Target user not found" } }, 400);
    }
    await sharesRepo.grant({ taskId: id, userId: targetUserId, grantedByUserId: result.userId });
    return c.json({ success: true });
  });

  routes.delete("/:id/shares/:userId", async (c) => {
    const id = c.req.param("id");
    const result = await loadOwnedTask(c, id);
    if ("response" in result) return result.response;
    await sharesRepo.revoke({ taskId: id, userId: c.req.param("userId") });
    return c.json({ success: true });
  });

  routes.patch("/:id/execution-mode", async (c) => {
    const id = c.req.param("id");
    const accessible = await loadOwnedTask(c, id);
    if ("response" in accessible) return accessible.response;
    const request = await readOptionalLeaseRequest(c);
    if ("response" in request) return request.response;
    const body = request.body;
    const executionMode =
      body && typeof body === "object" && "executionMode" in body
        ? automationExecutionModeSchema.safeParse((body as { executionMode: unknown }).executionMode)
        : { success: false as const };
    if (!executionMode.success) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Execution mode is invalid" } }, 400);
    }
    const userId = await resolveUserId(c.get("sub"));
    const saveResult = await selectAutomationSetupExecutionMode({
      db,
      taskId: id,
      executionMode: executionMode.data,
      actor: { userId, source: "web", lease: leaseForPersistence(request.lease) },
    });
    if (saveResult.kind === "not_found") {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    if (saveResult.kind === "locked") {
      return c.json(
        {
          error: {
            code: "LOCKED",
            message: "Automation is locked by another editor",
            lock: await toLockView(saveResult.lock, accessible.userId, users, request.lease?.clientSessionId),
          },
        },
        409,
      );
    }
    if (saveResult.kind === "lease_required") {
      return c.json(
        { error: { code: "LEASE_REQUIRED", message: "Acquire the automation editing session before saving" } },
        409,
      );
    }
    if (saveResult.kind === "lease_stale") {
      return c.json(
        {
          error: {
            code: "LEASE_STALE",
            message: "Editing session is stale",
            lock: await toLockView(saveResult.lock, accessible.userId, users, request.lease?.clientSessionId),
          },
        },
        409,
      );
    }
    if (saveResult.kind === "not_placeholder") {
      return c.json(
        {
          error: {
            code: "INVALID_STATE",
            message: "Execution mode selection is only available during automation setup",
          },
        },
        409,
      );
    }
    return c.json({
      automation: await loadFullDefinition(saveResult.row, {
        userId: accessible.userId,
        grantedTaskIds: accessible.grantedTaskIds,
        role: c.get("role"),
      }),
    });
  });

  routes.put("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!scheduler.refreshTaskSchedule) {
      return c.json({ error: { code: "SCHEDULER_UNAVAILABLE", message: "Scheduler refresh is unavailable" } }, 503);
    }

    const requestBody = await readOptionalLeaseRequest(c);
    if ("response" in requestBody) return requestBody.response;

    let request: ReturnType<typeof parseAutomationBuilderSaveRequest>;
    try {
      request = parseAutomationBuilderSaveRequest(requestBody.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid automation definition";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const brokerCapable = request.steps.some((step) => workflowStepUsesIntegrationActions(step))
      ? await hasBrokerCapableProvider()
      : true;
    const userId = await resolveUserId(c.get("sub"));
    if (options.validateAgentSkills && result.row.created_by) {
      const requestedSkills = request.steps.flatMap((step) => (step.type === "agent" ? (step.agentSkills ?? []) : []));
      const unavailableSkills = await options.validateAgentSkills(result.row.created_by, requestedSkills, {
        platform: result.row.platform === "whatsapp" ? "whatsapp" : "slack",
        contextType:
          result.row.context_type === "group" ? "group" : result.row.context_type === "channel" ? "channel" : "dm",
        deliveryTarget: result.row.delivery_target,
        createdBy: result.row.created_by,
      });
      if (unavailableSkills.length > 0) {
        return c.json(
          {
            error: {
              code: "CLI_INTEGRATION_REQUIRED",
              message: `Connect or share the required integration before saving this automation: ${unavailableSkills.join(", ")}.`,
              skills: unavailableSkills,
            },
          },
          409,
        );
      }
    }
    let saveResult: Awaited<ReturnType<typeof replaceAutomationDefinition>>;
    try {
      saveResult = await replaceAutomationDefinition({
        db,
        taskId: id,
        request,
        actor: {
          userId,
          role: c.get("role") === "admin" ? "admin" : undefined,
          source: "web",
          lease: leaseForPersistence(requestBody.lease),
        },
        brokerCapable,
        encryptionKey: options.encryptionKey,
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
    if (saveResult.kind === "locked") {
      return c.json(
        {
          error: {
            code: "LOCKED",
            message: "Automation is locked by another editor",
            lock: await toLockView(saveResult.lock, result.userId, users, requestBody.lease?.clientSessionId),
          },
        },
        409,
      );
    }
    if (saveResult.kind === "lease_required") {
      return c.json(
        { error: { code: "LEASE_REQUIRED", message: "Acquire the automation editing session before saving" } },
        409,
      );
    }
    if (saveResult.kind === "lease_stale") {
      return c.json(
        {
          error: {
            code: "LEASE_STALE",
            message: "Editing session is stale",
            lock: await toLockView(saveResult.lock, result.userId, users, requestBody.lease?.clientSessionId),
          },
        },
        409,
      );
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
    return c.json({
      automation: await loadFullDefinition(refreshed, {
        userId: result.userId,
        grantedTaskIds: result.grantedTaskIds,
        role: c.get("role"),
      }),
    });
  });

  routes.post("/:id/runs", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    const request = await readOptionalLeaseRequest(c);
    if ("response" in request) return request.response;

    if (result.row.status !== "active") {
      return c.json({ error: { code: "INVALID_STATE", message: "Only active automations can be triggered" } }, 400);
    }

    const reservation = await reserveManualRun(id, result.userId, request.lease);
    if (reservation.kind === "lease_denied") {
      return manualRunLeaseError(c, result.userId, request.lease, reservation.authorization);
    }
    if (reservation.kind === "failed") {
      return c.json(
        { error: { code: "RUN_RESERVATION_FAILED", message: "Automation run could not be reserved" } },
        503,
      );
    }
    const runId = reservation.runId;
    if (!(await enqueueReservedManualRun(id, runId, result.userId))) {
      return c.json({ error: { code: "RUN_ENQUEUE_FAILED", message: "Automation run could not be queued" } }, 503);
    }

    return c.json({ status: "triggered", runId });
  });

  routes.post("/:id/steps/:stepId/runs", async (c) => {
    const id = c.req.param("id");
    const stepId = c.req.param("stepId");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;
    if (!scheduler.executeStepById) {
      return c.json({ error: { code: "SCHEDULER_UNAVAILABLE", message: "Step testing is unavailable" } }, 503);
    }

    const request = await readOptionalLeaseRequest(c);
    if ("response" in request) return request.response;
    const body = request.body;
    const input =
      typeof body === "object" && body !== null && "input" in body ? (body as { input: unknown }).input : undefined;
    const useLatestUpstreamOutput =
      typeof body === "object" &&
      body !== null &&
      "useLatestUpstreamOutput" in body &&
      (body as { useLatestUpstreamOutput: unknown }).useLatestUpstreamOutput === true;
    const leaseError = await authorizeManualRun(c, id, result.userId, request.lease);
    if (leaseError) return leaseError;
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

    const request = await readOptionalLeaseRequest(c, { requireGeneration: true });
    if ("response" in request) return request.response;
    const leaseConflict = await authorizeTaskMutationLease(id, result.userId, request.lease);
    if (leaseConflict) return taskMutationLeaseError(c, result.userId, request.lease, leaseConflict);

    if (result.row.status === "completed") {
      return c.json({ error: { code: "INVALID_STATE", message: "Completed tasks cannot be paused" } }, 400);
    }

    if (result.row.status !== "paused") {
      await scheduler.pauseTask(id);
    }

    const updated = await repo.getById(id);
    return c.json({
      task: (
        await buildTaskListItems(db, [updated ?? result.row], {
          baseUrl: options.baseUrl,
          port: options.port,
          encryptionKey: options.encryptionKey,
          viewer: { userId: result.userId, grantedTaskIds: result.grantedTaskIds, role: c.get("role") },
        })
      )[0],
    });
  });

  routes.post("/:id/resume", async (c) => {
    const id = c.req.param("id");
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    const request = await readOptionalLeaseRequest(c, { requireGeneration: true });
    if ("response" in request) return request.response;
    const leaseConflict = await authorizeTaskMutationLease(id, result.userId, request.lease);
    if (leaseConflict) return taskMutationLeaseError(c, result.userId, request.lease, leaseConflict);

    if (result.row.status === "completed") {
      return c.json({ error: { code: "INVALID_STATE", message: "Completed tasks cannot be resumed" } }, 400);
    }

    if (result.row.status !== "active") {
      await scheduler.resumeTask(id);
    }

    const updated = await repo.getById(id);
    return c.json({
      task: (
        await buildTaskListItems(db, [updated ?? result.row], {
          baseUrl: options.baseUrl,
          port: options.port,
          encryptionKey: options.encryptionKey,
          viewer: { userId: result.userId, grantedTaskIds: result.grantedTaskIds, role: c.get("role") },
        })
      )[0],
    });
  });

  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const access = await loadDeletableTask(c, id);
    if ("response" in access) return access.response;
    const request = await readOptionalLeaseRequest(c, { requireGeneration: true });
    if ("response" in request) return request.response;
    const removeTaskRuntime = scheduler.removeTaskRuntime;
    if (!removeTaskRuntime) {
      return c.json(
        { error: { code: "SCHEDULER_UNAVAILABLE", message: "Scheduler runtime cleanup is unavailable" } },
        503,
      );
    }
    const userId = await resolveUserId(c.get("sub"));
    const deletion = await deleteAutomation({
      db,
      taskId: id,
      actor: {
        userId,
        role: c.get("role") === "admin" ? "admin" : undefined,
        source: "web",
        lease: leaseForPersistence(request.lease),
      },
      scheduler: { removeTaskRuntime: removeTaskRuntime.bind(scheduler) },
      encryptionKey: options.encryptionKey,
    });
    if (deletion.kind === "not_found" || deletion.kind === "access_denied") {
      return c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404);
    }
    if (deletion.kind === "locked" || deletion.kind === "lease_stale") {
      return taskMutationLeaseError(c, access.userId, request.lease, deletion);
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

    const request = await readOptionalLeaseRequest(c);
    if ("response" in request) return request.response;

    if (result.row.status !== "active") {
      return c.json({ error: { code: "INVALID_STATE", message: "Only active automations can be triggered" } }, 400);
    }

    const reservation = await reserveManualRun(id, result.userId, request.lease);
    if (reservation.kind === "lease_denied") {
      return manualRunLeaseError(c, result.userId, request.lease, reservation.authorization);
    }
    if (reservation.kind === "failed") {
      return c.json(
        { error: { code: "RUN_RESERVATION_FAILED", message: "Automation run could not be reserved" } },
        503,
      );
    }
    const runId = reservation.runId;
    if (!(await enqueueReservedManualRun(id, runId, result.userId))) {
      return c.json({ error: { code: "RUN_ENQUEUE_FAILED", message: "Automation run could not be queued" } }, 503);
    }

    return c.json({ status: "triggered", runId });
  });

  return routes;
}
