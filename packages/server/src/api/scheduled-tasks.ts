import { type Context, Hono } from "hono";
import type { Kysely, Selectable } from "kysely";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createChannelRepository } from "../db/repositories/channels";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB, ScheduledTasksTable } from "../db/schema";

type ScheduledTaskRow = Selectable<ScheduledTasksTable>;

interface ScheduledTaskMutationDeps {
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  removeTask: (id: string) => Promise<boolean>;
  executeTaskById: (id: string) => Promise<void>;
}

interface ScheduledTaskListItem {
  id: string;
  platform: "slack" | "whatsapp";
  contextType: "dm" | "channel" | "group";
  deliveryTarget: string;
  threadTs: string | null;
  prompt: string;
  scheduleType: "cron" | "interval" | "once";
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
  outputTarget: string | null;
  outputPlatform: string | null;
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

function formatIntervalLabel(rawSeconds: string): string {
  const seconds = Number.parseInt(rawSeconds, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return `Every ${rawSeconds} seconds`;
  }

  const units: Array<{ seconds: number; label: string }> = [
    { seconds: 86_400, label: "day" },
    { seconds: 3_600, label: "hour" },
    { seconds: 60, label: "minute" },
  ];

  for (const unit of units) {
    if (seconds % unit.seconds === 0) {
      const count = seconds / unit.seconds;
      return `Every ${count} ${unit.label}${count === 1 ? "" : "s"}`;
    }
  }

  return `Every ${seconds} seconds`;
}

function formatScheduleLabel(row: ScheduledTaskRow): string {
  if (row.schedule_type === "interval") {
    return formatIntervalLabel(row.schedule_value);
  }

  if (row.schedule_type === "once") {
    return `Once on ${formatDateTime(row.schedule_value, row.timezone)}`;
  }

  return `Cron: ${row.schedule_value} (${row.timezone})`;
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

  // Fetch latest run and run count for each task
  const runDataEntries = await Promise.all(
    rows.map(async (row) => {
      const latest = await runsRepo.getLatest(row.id);
      const runs = await runsRepo.list(row.id, 1000);
      return [row.id, { lastRunStatus: latest?.status ?? null, runCount: runs.length }] as const;
    }),
  );
  const runData = new Map(runDataEntries);

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

    let stepCount = 0;
    if (row.steps) {
      try {
        stepCount = JSON.parse(row.steps).length;
      } catch {}
    }

    const rd = runData.get(row.id);

    return {
      id: row.id,
      platform: row.platform as "slack" | "whatsapp",
      contextType: row.context_type as "dm" | "channel" | "group",
      deliveryTarget: row.delivery_target,
      threadTs: row.thread_ts,
      prompt: row.prompt,
      scheduleType: row.schedule_type as "cron" | "interval" | "once",
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
      scheduleLabel: formatScheduleLabel(row),
      canPause: row.status === "active",
      canResume: row.status === "paused",
      canDelete: true,
      title: row.title,
      description: row.description,
      steps: row.steps,
      stepCount,
      outputTarget: row.output_target,
      outputPlatform: row.output_platform,
      lastRunStatus: rd?.lastRunStatus ?? null,
      runCount: rd?.runCount ?? 0,
    };
  });
}

export function scheduledTaskRoutes(db: Kysely<DB>, scheduler: ScheduledTaskMutationDeps) {
  const routes = new Hono();
  const repo = createScheduledTaskRepository(db);

  async function loadAccessibleTask(c: Context, id: string) {
    const row = await repo.getById(id);
    if (!row) {
      return {
        response: c.json({ error: { code: "NOT_FOUND", message: "Scheduled task not found" } }, 404),
      };
    }
    return { row };
  }

  routes.get("/", async (c) => {
    const rows = await repo.listAll();

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
