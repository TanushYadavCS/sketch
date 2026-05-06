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
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppBot } from "../whatsapp/bot";
import { executeAutomation } from "../workflows/runtime";
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
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  automationRunsRepo: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo: ReturnType<typeof createAutomationStepContentRepository>;
  userRepo: ReturnType<typeof createUserRepository>;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  sendDm?: Parameters<typeof runAgent>[0]["sendDm"];
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
      try {
        await this.scheduleTask(task);
      } catch (err) {
        this.deps.logger.error(
          { err, taskId: task.id, scheduleType: task.schedule_type, scheduleValue: task.schedule_value },
          "TaskScheduler: failed to schedule task, pausing it",
        );
        await this.repo.updateStatus(task.id, "paused").catch(() => {});
      }
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
    const { config, logger, queueManager, getSlack, whatsapp, loadIntegrationProvider } = this.deps;

    // Build onMessage callback for delivery
    let onMessage: (text: string) => Promise<void>;

    if (task.platform === "slack") {
      const slack = getSlack();
      if (!slack) {
        logger.warn({ taskId: task.id }, "TaskScheduler: Slack bot unavailable, skipping task");
        return;
      }

      // Determine output target: use output_target if set (for workflows), else delivery_target
      const outputTarget = task.output_target ?? task.delivery_target;

      if (
        task.context_type === "channel" &&
        task.session_mode !== "fresh" &&
        task.thread_ts &&
        outputTarget === task.delivery_target
      ) {
        const threadTs = task.thread_ts;
        onMessage = async (text) => {
          await slack.postThreadReply(outputTarget, threadTs, text);
        };
      } else {
        onMessage = async (text) => {
          await slack.postMessage(outputTarget, text);
        };
      }
    } else {
      if (!whatsapp.isConnected) {
        logger.warn({ taskId: task.id }, "TaskScheduler: WhatsApp not connected, skipping task");
        return;
      }
      onMessage = async (text) => {
        await whatsapp.sendText(task.output_target ?? task.delivery_target, text);
      };
    }

    // Queue key: chat-mode keeps original key (sequential with conversation), everything else is isolated
    let queueKey: string;
    if (task.session_mode === "chat") {
      // Chat mode: original queue key logic
      const userId = task.created_by ?? task.delivery_target;
      if (task.context_type === "dm") {
        queueKey = userId;
      } else if (task.platform === "slack" && task.context_type === "channel") {
        queueKey = task.thread_ts ? `${task.delivery_target}:${task.thread_ts}` : task.delivery_target;
      } else {
        const groupId = task.delivery_target.replace("@g.us", "");
        queueKey = `wa-group-${groupId}`;
      }
    } else {
      // Fresh/persistent: isolated queue key
      queueKey = `task-${task.id}`;
    }

    queueManager.getQueue(queueKey).enqueue(async () => {
      try {
        await executeAutomation({
          task,
          triggerData: { scheduledAt: new Date().toISOString(), taskId: task.id },
          db: this.deps.db,
          logger,
          config,
          runsRepo: this.deps.automationRunsRepo,
          stepContentRepo: this.deps.stepContentRepo,
          loadIntegrationProvider,
          userRepo: this.deps.userRepo,
          runAgent: this.deps.runAgent,
          buildMcpServers: this.deps.buildMcpServers,
          inboxMessagesRepo: this.deps.inboxMessagesRepo,
          sendDm: this.deps.sendDm,
          sendMessage: onMessage,
        });
      } catch (err) {
        logger.error({ err, taskId: task.id }, "Automation execution failed");
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
    title?: string | null;
    description?: string | null;
    steps?: string | null;
    edges?: string | null;
    outputTarget?: string | null;
    outputPlatform?: string | null;
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
      title: params.title ?? null,
      description: params.description ?? null,
      steps: params.steps ?? null,
      edges: params.edges ?? null,
      output_target: params.outputTarget ?? null,
      output_platform: params.outputPlatform ?? null,
    });

    try {
      await this.scheduleTask(row);
    } catch (err) {
      this.deps.logger.error({ err, taskId: row.id }, "TaskScheduler: failed to schedule new task, pausing it");
      await this.repo.updateStatus(row.id, "paused");
      const paused = await this.repo.getById(row.id);
      return this.toScheduledTask(paused ?? row);
    }

    const updated = await this.repo.getById(row.id);
    return this.toScheduledTask(updated ?? row);
  }

  async executeTaskById(id: string): Promise<void> {
    const row = await this.repo.getById(id);
    if (!row) throw new Error(`Task ${id} not found`);
    if (row.status !== "active") throw new Error(`Task ${id} is not active`);
    await this.executeTask(row);
  }

  async getTaskById(id: string): Promise<ScheduledTask | null> {
    const row = await this.repo.getById(id);
    return row ? this.toScheduledTask(row) : null;
  }

  async updateTask(id: string, params: Record<string, string | null | undefined>): Promise<ScheduledTask | null> {
    const fields: Record<string, string | null | undefined> = {};
    if (params.prompt !== undefined) fields.prompt = params.prompt;
    if (params.scheduleType !== undefined) fields.schedule_type = params.scheduleType;
    if (params.scheduleValue !== undefined) fields.schedule_value = params.scheduleValue;
    if (params.timezone !== undefined) fields.timezone = params.timezone;
    if (params.sessionMode !== undefined) fields.session_mode = params.sessionMode;
    if (params.title !== undefined) fields.title = params.title;
    if (params.description !== undefined) fields.description = params.description;
    if (params.steps !== undefined) fields.steps = params.steps;
    if (params.edges !== undefined) fields.edges = params.edges;
    if (params.outputTarget !== undefined) fields.output_target = params.outputTarget;
    if (params.outputPlatform !== undefined) fields.output_platform = params.outputPlatform;

    const row = await this.repo.update(id, fields);
    if (!row) return null;

    const scheduleChanged =
      params.scheduleType !== undefined || params.scheduleValue !== undefined || params.timezone !== undefined;
    if (scheduleChanged && row.status === "active") {
      try {
        await this.scheduleTask(row);
      } catch (err) {
        this.deps.logger.error({ err, taskId: id }, "TaskScheduler: failed to reschedule updated task, pausing it");
        await this.repo.updateStatus(id, "paused");
      }
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
      title: row.title,
      description: row.description,
      steps: row.steps,
      edges: row.edges,
      outputTarget: row.output_target,
      outputPlatform: row.output_platform,
    };
  }
}
