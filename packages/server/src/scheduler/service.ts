/**
 * TaskScheduler manages all scheduled agent runs using croner for cron and interval scheduling.
 *
 * On startup it loads all active tasks from the DB and creates live croner instances for each.
 * On each fire it enqueues an agent run through QueueManager using the same runAgent pipeline
 * used by Slack and WhatsApp message handlers. Session modes:
 *   - fresh: fully ephemeral, no session resume or save
 *   - persistent: dedicated session keyed to "task-{id}", accumulates context across runs
 *   - chat: resumes the actual user/thread session (for DMs and Slack threads)
 *
 * Workspace keys follow the same conventions used elsewhere:
 *   DM -> userId, Slack channel -> "channel-{id}", WhatsApp group -> "wa-group-{jid}"
 *
 * CRUD methods (addTask, updateTask, removeTask, pauseTask, resumeTask, listTasks) are called
 * by the ManageScheduledTasks agent tool and convert between snake_case DB rows and the
 * camelCase ScheduledTask application type.
 */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Kysely } from "kysely";
import type { McpServerConfig, runAgent } from "../agent/runner";
import { ensureChannelWorkspace, ensureGroupWorkspace, ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppBot } from "../whatsapp/bot";
import type { ScheduledTask } from "./types";

export interface TaskSchedulerDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  queueManager: QueueManager;
  getSlack: () => SlackBot | null;
  whatsapp: WhatsAppBot;
  settingsRepo: ReturnType<typeof createSettingsRepository>;
  runAgent: typeof runAgent;
  buildMcpServers: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  findIntegrationProvider: () => Promise<{ type: string; credentials: string } | null>;
}

export class TaskScheduler {
  private cronInstances: Map<string, Cron> = new Map();
  private repo: ReturnType<typeof createScheduledTaskRepository>;
  private deps: TaskSchedulerDeps;

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
    this.repo = createScheduledTaskRepository(deps.db);
  }

  async start(): Promise<void> {
    const activeTasks = await this.repo.listActive();
    this.deps.logger.info({ count: activeTasks.length }, "TaskScheduler: loading active tasks");
    for (const task of activeTasks) {
      await this.scheduleTask(task);
    }
  }

  stop(): void {
    for (const [taskId, cron] of this.cronInstances) {
      cron.stop();
      this.deps.logger.debug({ taskId }, "TaskScheduler: stopped cron instance");
    }
    this.cronInstances.clear();
  }

  async scheduleTask(task: ScheduledTaskRow): Promise<void> {
    const existing = this.cronInstances.get(task.id);
    if (existing) {
      existing.stop();
      this.cronInstances.delete(task.id);
    }

    if (task.schedule_type === "once") {
      const runAt = new Date(task.schedule_value);
      if (runAt.getTime() <= Date.now()) {
        await this.repo.updateStatus(task.id, "completed");
        await this.repo.update(task.id, { next_run_at: null });
        this.deps.logger.warn({ taskId: task.id }, "TaskScheduler: once task datetime has passed, marking completed");
        return;
      }
      const cron = new Cron(runAt, { timezone: task.timezone }, () => this.executeTask(task));
      this.cronInstances.set(task.id, cron);
      const nextRun = cron.nextRun()?.toISOString() ?? null;
      await this.repo.update(task.id, { next_run_at: nextRun });
      this.deps.logger.debug({ taskId: task.id, nextRun }, "TaskScheduler: scheduled once task");
      return;
    }

    let cronExpr: string;
    if (task.schedule_type === "interval") {
      const totalSeconds = Number.parseInt(task.schedule_value, 10);
      const totalMinutes = Math.max(1, Math.ceil(totalSeconds / 60));
      if (totalMinutes < 60) {
        cronExpr = `*/${totalMinutes} * * * *`;
      } else {
        const hours = Math.floor(totalMinutes / 60);
        const mins = totalMinutes % 60;
        cronExpr = `${mins} */${hours} * * *`;
      }
    } else {
      cronExpr = task.schedule_value;
    }

    const cron = new Cron(cronExpr, { timezone: task.timezone, interval: 60 }, () => this.executeTask(task));

    this.cronInstances.set(task.id, cron);

    const nextRun = cron.nextRun()?.toISOString() ?? null;
    await this.repo.update(task.id, { next_run_at: nextRun });

    this.deps.logger.debug({ taskId: task.id, nextRun }, "TaskScheduler: scheduled task");
  }

  unscheduleTask(taskId: string): void {
    const cron = this.cronInstances.get(taskId);
    if (cron) {
      cron.stop();
      this.cronInstances.delete(taskId);
      this.deps.logger.debug({ taskId }, "TaskScheduler: unscheduled task");
    }
  }

  async executeTask(task: ScheduledTaskRow): Promise<void> {
    const { config, logger, queueManager, getSlack, whatsapp, settingsRepo, buildMcpServers, findIntegrationProvider } =
      this.deps;

    let workspaceDir: string;
    if (task.context_type === "channel") {
      workspaceDir = await ensureChannelWorkspace(config, task.delivery_target);
    } else if (task.context_type === "group") {
      workspaceDir = await ensureGroupWorkspace(config, task.delivery_target);
    } else {
      const userId = task.created_by ?? task.delivery_target;
      workspaceDir = await ensureWorkspace(config, userId);
    }

    let onMessage: (text: string) => Promise<void>;

    if (task.platform === "slack") {
      const slack = getSlack();
      if (!slack) {
        logger.warn({ taskId: task.id }, "TaskScheduler: Slack bot unavailable, skipping task");
        return;
      }

      if (task.context_type === "channel" && task.session_mode !== "fresh" && task.thread_ts) {
        const threadTs = task.thread_ts;
        onMessage = async (text) => {
          await slack.postThreadReply(task.delivery_target, threadTs, text);
        };
      } else {
        onMessage = async (text) => {
          await slack.postMessage(task.delivery_target, text);
        };
      }
    } else {
      if (!whatsapp.isConnected) {
        logger.warn({ taskId: task.id }, "TaskScheduler: WhatsApp not connected, skipping task");
        return;
      }
      onMessage = async (text) => {
        await whatsapp.sendText(task.delivery_target, text);
      };
    }

    const userId = task.created_by ?? task.delivery_target;

    let workspaceKey: string;
    if (task.context_type === "dm") {
      workspaceKey = userId;
    } else if (task.platform === "slack" && task.context_type === "channel") {
      workspaceKey = `channel-${task.delivery_target}`;
    } else {
      const groupId = task.delivery_target.replace("@g.us", "");
      workspaceKey = `wa-group-${groupId}`;
    }

    let queueKey: string;
    if (task.context_type === "dm") {
      queueKey = userId;
    } else if (task.platform === "slack" && task.context_type === "channel") {
      if (task.session_mode !== "fresh" && task.thread_ts) {
        queueKey = `${task.delivery_target}:${task.thread_ts}`;
      } else {
        queueKey = task.delivery_target;
      }
    } else {
      const groupId = task.delivery_target.replace("@g.us", "");
      queueKey = `wa-group-${groupId}`;
    }

    let threadKey: string | undefined;
    if (task.session_mode === "persistent") {
      threadKey = `task-${task.id}`;
    } else if (task.session_mode === "chat") {
      if (task.context_type === "channel" && task.thread_ts) {
        threadKey = task.thread_ts;
      } else {
        threadKey = undefined;
      }
    } else {
      threadKey = undefined;
    }

    queueManager.getQueue(queueKey).enqueue(async () => {
      try {
        const settingsRow = await settingsRepo.get();
        const integrationMcpServers = await buildMcpServers(null);

        await this.deps.runAgent({
          db: this.deps.db,
          workspaceKey,
          userMessage: `[Scheduled Task] ${task.prompt}`,
          workspaceDir,
          userName: "System",
          logger,
          platform: task.platform as "slack" | "whatsapp",
          onMessage,
          threadTs: threadKey,
          orgName: settingsRow?.org_name,
          botName: settingsRow?.bot_name,
          integrationMcpServers,
          findIntegrationProvider,
          sessionMode: task.session_mode as "fresh" | "persistent" | "chat",
          contextType: "scheduled_task",
          currentUserId: task.created_by ?? null,
        });
      } catch (err) {
        logger.error({ err, taskId: task.id }, "Scheduled task execution failed");
      }
    });

    const now = new Date().toISOString();
    const cron = this.cronInstances.get(task.id);
    const nextRun = cron?.nextRun()?.toISOString() ?? null;
    await this.repo.updateRunTimestamps(task.id, now, nextRun);

    if (task.schedule_type === "once") {
      await this.repo.updateStatus(task.id, "completed");
      await this.repo.update(task.id, { next_run_at: null });
      this.unscheduleTask(task.id);
      this.deps.logger.debug({ taskId: task.id }, "TaskScheduler: once task completed, unscheduled");
    }
  }

  async addTask(params: {
    platform: "slack" | "whatsapp";
    contextType: "dm" | "channel" | "group";
    deliveryTarget: string;
    threadTs?: string | null;
    prompt: string;
    scheduleType: "cron" | "interval" | "once";
    scheduleValue: string;
    timezone?: string;
    sessionMode?: "fresh" | "persistent" | "chat";
    createdBy?: string | null;
  }): Promise<ScheduledTask> {
    const row = await this.repo.add({
      id: randomUUID(),
      platform: params.platform,
      context_type: params.contextType,
      delivery_target: params.deliveryTarget,
      thread_ts: params.threadTs ?? null,
      prompt: params.prompt,
      schedule_type: params.scheduleType,
      schedule_value: params.scheduleValue,
      timezone: params.timezone ?? "UTC",
      session_mode: params.sessionMode ?? "fresh",
      created_by: params.createdBy ?? null,
      status: "active",
      next_run_at: null,
    });

    await this.scheduleTask(row);

    const updated = await this.repo.getById(row.id);
    return this.toScheduledTask(updated ?? row);
  }

  async updateTask(
    id: string,
    params: {
      prompt?: string;
      scheduleType?: "cron" | "interval" | "once";
      scheduleValue?: string;
      timezone?: string;
      sessionMode?: "fresh" | "persistent" | "chat";
    },
  ): Promise<ScheduledTask | null> {
    const fields: Record<string, string | null | undefined> = {};
    if (params.prompt !== undefined) fields.prompt = params.prompt;
    if (params.scheduleType !== undefined) fields.schedule_type = params.scheduleType;
    if (params.scheduleValue !== undefined) fields.schedule_value = params.scheduleValue;
    if (params.timezone !== undefined) fields.timezone = params.timezone;
    if (params.sessionMode !== undefined) fields.session_mode = params.sessionMode;

    const row = await this.repo.update(id, fields);
    if (!row) return null;

    const scheduleChanged =
      params.scheduleType !== undefined || params.scheduleValue !== undefined || params.timezone !== undefined;
    if (scheduleChanged && row.status === "active") {
      await this.scheduleTask(row);
    }

    const refreshed = await this.repo.getById(id);
    return refreshed ? this.toScheduledTask(refreshed) : null;
  }

  async removeTask(id: string): Promise<boolean> {
    this.unscheduleTask(id);
    return this.repo.remove(id);
  }

  async pauseTask(id: string): Promise<void> {
    this.unscheduleTask(id);
    await this.repo.updateStatus(id, "paused");
  }

  async resumeTask(id: string): Promise<void> {
    await this.repo.updateStatus(id, "active");
    const row = await this.repo.getById(id);
    if (row) {
      await this.scheduleTask(row);
    }
  }

  async listTasks(filter: { deliveryTarget?: string; createdBy?: string }): Promise<ScheduledTask[]> {
    let rows: ScheduledTaskRow[];
    if (filter.deliveryTarget) {
      rows = await this.repo.listByDeliveryTarget(filter.deliveryTarget);
    } else if (filter.createdBy) {
      rows = await this.repo.listByCreatedBy(filter.createdBy);
    } else {
      rows = await this.repo.listActive();
    }
    return rows.map((r) => this.toScheduledTask(r));
  }

  private toScheduledTask(row: ScheduledTaskRow): ScheduledTask {
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
    };
  }
}
