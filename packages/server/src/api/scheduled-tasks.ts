import { type Context, Hono } from "hono";
import type { Kysely, Selectable } from "kysely";
import type { Logger } from "pino";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createChannelRepository } from "../db/repositories/channels";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB, ScheduledTasksTable } from "../db/schema";
import { formatIntervalScheduleLabel, normalizeScheduleTriggerStepsJson } from "../scheduler/trigger-metadata";
import type { WorkflowStep } from "../workflows/types";

type ScheduledTaskRow = Selectable<ScheduledTasksTable>;
type WorkflowTriggerConfig = NonNullable<WorkflowStep["triggerConfig"]>;

interface ScheduledTaskMutationDeps {
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  removeTask: (id: string) => Promise<boolean>;
  executeTaskById: (id: string) => Promise<unknown>;
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
  sessionMode: "fresh" | "persistent" | "chat";
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
  steps: string | null;
  stepCount: number;
  triggerConfig: WorkflowTriggerConfig | null;
  outputTarget: string | null;
  outputPlatform: string | null;
  outputMode: "deliver" | "silent";
  lastRunStatus: string | null;
  runCount: number;
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

async function buildTaskListItems(db: Kysely<DB>, rows: ScheduledTaskRow[]): Promise<ScheduledTaskListItem[]> {
  const users = createUserRepository(db);
  const channels = createChannelRepository(db);
  const whatsappGroups = createWhatsAppGroupRepository(db);
  const runsRepo = createAutomationRunsRepository(db);

  const userIds = [...new Set(rows.map((row) => row.created_by).filter((id): id is string => Boolean(id)))];
  const slackChannelIds = [
    ...new Set(
      rows
        .filter((row) => row.platform === "slack" && row.context_type === "channel")
        .map((row) => row.delivery_target),
    ),
  ];
  const whatsappGroupJids = [
    ...new Set(
      rows
        .filter((row) => row.platform === "whatsapp" && row.context_type === "group")
        .map((row) => row.delivery_target),
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
  const groupEntries = await Promise.all(
    whatsappGroupJids.map(async (jid) => {
      const group = await whatsappGroups.getByJid(jid);
      return [jid, group?.name ?? null] as const;
    }),
  );

  const creatorNames = new Map(userEntries);
  const channelNames = new Map(channelEntries);
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
      sessionMode: row.session_mode as "fresh" | "persistent" | "chat",
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
      steps: normalizedSteps ?? null,
      stepCount,
      triggerConfig,
      outputTarget: row.output_target,
      outputPlatform: row.output_platform,
      outputMode: row.output_mode === "silent" ? "silent" : "deliver",
      lastRunStatus: rd?.lastRunStatus ?? null,
      runCount: rd?.runCount ?? 0,
    };
  });
}

export function scheduledTaskRoutes(db: Kysely<DB>, scheduler: ScheduledTaskMutationDeps, logger?: Logger) {
  const routes = new Hono();
  const repo = createScheduledTaskRepository(db);
  const users = createUserRepository(db);

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

  function canAccess(row: ScheduledTaskRow, userId: string | null, role: string | undefined): boolean {
    // Admin trusted even when sub doesn't resolve (stale JWT, deleted user row).
    // Admins are internal; acceptable in Phase 1.
    if (role === "admin") return true;
    if (!userId) return false;
    return row.created_by === userId;
  }

  async function loadAccessibleTask(c: Context, id: string) {
    const row = await repo.getById(id);
    if (!row) {
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    const userId = await resolveUserId(c.get("sub"));
    if (!canAccess(row, userId, c.get("role"))) {
      logger?.warn(
        { userId, taskId: id, ownerUserId: row.created_by },
        "scheduled-tasks: member denied access to task",
      );
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    return { row };
  }

  routes.get("/", async (c) => {
    const role = c.get("role");
    const userId = await resolveUserId(c.get("sub"));

    let rows: ScheduledTaskRow[];
    if (role === "admin") {
      rows = await repo.listAll();
    } else if (userId) {
      rows = await repo.listByCreatedBy(userId);
    } else {
      rows = [];
    }

    rows.sort(compareNewestFirst);

    return c.json({ tasks: await buildTaskListItems(db, rows) });
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
    const result = await loadAccessibleTask(c, id);
    if ("response" in result) return result.response;

    // Cascade delete runs and step content
    const runsRepo2 = createAutomationRunsRepository(db);
    const stepContentRepo = createAutomationStepContentRepository(db);
    await runsRepo2.deleteByTaskId(id);
    await stepContentRepo.deleteByTaskId(id);

    await scheduler.removeTask(id);
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
