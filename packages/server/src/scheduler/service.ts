/**
 * TaskScheduler manages all scheduled agent runs using croner for cron and interval scheduling.
 *
 * On startup it loads all active tasks from the DB and creates live croner instances for each.
 * On each fire it enqueues an agent run through QueueManager using the same runAgent pipeline
 * used by Slack and WhatsApp message handlers. Scheduled tasks always run with
 * fresh session state so automations cannot re-enter a live chat queue.
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
import type { Config } from "../config";
import type { AgentEnvironmentRuntimeContext } from "../db/repositories/agent-environment-variables";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createConversationRepository } from "../db/repositories/conversations";
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
import type { RecordWorkflowStep } from "../telemetry/agent-run-telemetry";
import type { WhatsAppBot } from "../whatsapp/bot";
import { isSlackDmChannelId, isSlackUserId, resolveWorkflowDelivery } from "../workflows/delivery";
import { type AutomationExecutionResult, executeAutomation } from "../workflows/runtime";
import { testAutomationStep } from "../workflows/runtime";
import { createWorkflowDeliveryCapture, providerTimestampFromWhatsApp } from "./delivery-capture";
import { parseOnceSchedule } from "./parse-once";
import { getScheduledTaskRowQueueKey } from "./queue-key";
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
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  automationRunsRepo: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo: ReturnType<typeof createAutomationStepContentRepository>;
  userRepo: ReturnType<typeof createUserRepository>;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  sendDm?: Parameters<typeof runAgent>[0]["sendDm"];
  recordWorkflowStep?: RecordWorkflowStep;
}

export class TaskScheduler {
  private cronInstances: Map<string, Cron> = new Map();
  private repo: ReturnType<typeof createScheduledTaskRepository>;
  private deliveryCapture: ReturnType<typeof createWorkflowDeliveryCapture>;
  private deps: TaskSchedulerDeps;

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
    this.repo = createScheduledTaskRepository(deps.db);
    this.deliveryCapture = createWorkflowDeliveryCapture({
      conversations: createConversationRepository(deps.db),
      settingsRepo: deps.settingsRepo,
      logger: deps.logger,
    });
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

    if (task.schedule_type === "external") {
      await this.repo.update(task.id, { next_run_at: null });
      this.deps.logger.debug({ taskId: task.id }, "TaskScheduler: external trigger task has no local schedule");
      return;
    }

    if (task.schedule_type === "once") {
      const runAt = parseOnceSchedule(task.schedule_value, task.timezone || "UTC");
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
    this.enqueueTaskRun(task, () => this.getRunnableTask(task.id, false)).catch((err) => {
      this.deps.logger.error({ err, taskId: task.id }, "Automation execution failed");
    });
  }

  private async executeTaskNow(task: ScheduledTaskRow): Promise<AutomationExecutionResult> {
    const { config, logger, loadIntegrationProvider } = this.deps;
    const delivery = resolveWorkflowDelivery(task);
    const sendMessage = this.getSendMessage(task);

    if (!sendMessage && delivery.mode !== "silent") {
      throw new Error(`Delivery target for task ${task.id} is unavailable`);
    }

    const result = await executeAutomation({
      task,
      triggerData: { scheduledAt: new Date().toISOString(), taskId: task.id },
      db: this.deps.db,
      logger,
      config,
      runsRepo: this.deps.automationRunsRepo,
      stepContentRepo: this.deps.stepContentRepo,
      loadIntegrationProvider,
      listAgentEnvForRuntime: this.deps.listAgentEnvForRuntime,
      userRepo: this.deps.userRepo,
      runAgent: this.deps.runAgent,
      buildMcpServers: this.deps.buildMcpServers,
      getSlack: this.deps.getSlack,
      inboxMessagesRepo: this.deps.inboxMessagesRepo,
      sendDm: this.deps.sendDm,
      sendMessage: sendMessage ?? undefined,
      recordWorkflowStep: this.deps.recordWorkflowStep,
    });

    const now = new Date().toISOString();
    const cron = this.cronInstances.get(task.id);
    const nextRun = task.schedule_type === "once" ? null : (cron?.nextRun()?.toISOString() ?? null);
    await this.repo.updateRunTimestamps(task.id, now, nextRun);

    if (task.schedule_type === "once") {
      await this.repo.updateStatus(task.id, "completed");
      await this.repo.update(task.id, { next_run_at: null });
      this.unscheduleTask(task.id);
      this.deps.logger.debug({ taskId: task.id }, "TaskScheduler: once task completed, unscheduled");
    }

    return result;
  }

  private enqueueTaskRun(
    task: ScheduledTaskRow,
    getTask: () => Promise<ScheduledTaskRow | null>,
  ): Promise<AutomationExecutionResult | null> {
    const queueKey = this.getQueueKey(task);
    return new Promise<AutomationExecutionResult | null>((resolve, reject) => {
      this.deps.queueManager.getQueue(queueKey).enqueue(async () => {
        try {
          const current = await getTask();
          if (!current) {
            resolve(null);
            return;
          }
          resolve(await this.executeTaskNow(current));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private async getRunnableTask(id: string, strict: boolean): Promise<ScheduledTaskRow | null> {
    const row = await this.repo.getById(id);
    if (!row) {
      if (strict) throw new Error(`Task ${id} not found`);
      return null;
    }
    if (row.status === "completed" && row.schedule_type === "once") return null;
    if (row.status !== "active") {
      if (strict) throw new Error(`Task ${id} is not active`);
      return null;
    }
    return row;
  }

  private getSendMessage(task: ScheduledTaskRow): ((text: string) => Promise<void>) | null {
    const { logger, getSlack, whatsapp } = this.deps;
    const delivery = resolveWorkflowDelivery(task);

    if (delivery.platform === "slack") {
      const slack = getSlack();
      if (!slack) {
        logger.warn({ taskId: task.id }, "TaskScheduler: Slack bot unavailable, skipping task");
        return null;
      }

      if (delivery.threadTs) {
        return async (text) => {
          const messageRef = await slack.postThreadReply(delivery.targetId, delivery.threadTs as string, text);
          await this.deliveryCapture.captureSlack({
            deliveryTarget: delivery.targetId,
            threadTs: delivery.threadTs,
            messageRef,
            text,
          });
        };
      }

      return async (text) => {
        let targetId = delivery.targetId;
        if (delivery.targetType === "dm" && isSlackUserId(targetId) && !isSlackDmChannelId(targetId)) {
          const settings = await this.deps.settingsRepo.get();
          const dmChannelId = await slack.openDmChannel(targetId, settings?.slack_bot_token ?? undefined);
          if (!dmChannelId) {
            logger.warn({ taskId: task.id, slackUserId: targetId }, "TaskScheduler: failed to open Slack DM channel");
            throw new Error(`Failed to open Slack DM channel for task ${task.id}`);
          }
          targetId = dmChannelId;
        }
        const messageRef = await slack.postMessage(targetId, text);
        await this.deliveryCapture.captureSlack({
          deliveryTarget: targetId,
          threadTs: null,
          messageRef,
          text,
        });
      };
    }

    if (!whatsapp.isConnected) {
      logger.warn({ taskId: task.id }, "TaskScheduler: WhatsApp not connected, skipping task");
      return null;
    }

    return async (text) => {
      const sent = await whatsapp.sendText(delivery.targetId, text);
      const messageRef = sent?.key?.id;
      if (!messageRef) return;
      await this.deliveryCapture.captureWhatsApp({
        deliveryTarget: delivery.targetId,
        messageRef,
        providerTimestamp: providerTimestampFromWhatsApp(sent),
        text,
      });
    };
  }

  private getQueueKey(task: ScheduledTaskRow): string {
    return getScheduledTaskRowQueueKey(task);
  }

  async addTask(params: {
    platform: "slack" | "whatsapp";
    contextType: "dm" | "channel" | "group";
    deliveryTarget: string;
    threadTs?: string | null;
    prompt: string;
    scheduleType: "cron" | "interval" | "once" | "external";
    scheduleValue: string;
    timezone?: string;
    sessionMode?: "fresh";
    createdBy?: string | null;
    title?: string | null;
    description?: string | null;
    steps?: string | null;
    edges?: string | null;
    outputTarget?: string | null;
    outputPlatform?: string | null;
    outputThreadTs?: string | null;
    outputMode?: "deliver" | "silent";
    originPlatform?: "web" | "slack" | "whatsapp" | null;
    originConversationId?: string | null;
    originProviderThreadId?: string | null;
    originMessageId?: number | null;
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
      session_mode: "fresh",
      created_by: params.createdBy ?? null,
      status: "active",
      next_run_at: null,
      title: params.title ?? null,
      description: params.description ?? null,
      steps: params.steps ?? null,
      edges: params.edges ?? null,
      output_target: params.outputTarget ?? null,
      output_platform: params.outputPlatform ?? null,
      output_thread_ts: params.outputThreadTs ?? null,
      output_mode: params.outputMode ?? "deliver",
      origin_platform: params.originPlatform ?? null,
      origin_conversation_id: params.originConversationId ?? null,
      origin_provider_thread_id: params.originProviderThreadId ?? null,
      origin_message_id: params.originMessageId ?? null,
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

  async executeTaskById(id: string): Promise<AutomationExecutionResult | null> {
    const row = await this.repo.getById(id);
    if (!row) throw new Error(`Task ${id} not found`);
    if (row.status === "completed" && row.schedule_type === "once") return null;
    if (row.status !== "active") throw new Error(`Task ${id} is not active`);
    return this.enqueueTaskRun(row, () => this.getRunnableTask(id, true));
  }

  async enqueueTaskById(id: string): Promise<void> {
    const row = await this.repo.getById(id);
    if (!row) throw new Error(`Task ${id} not found`);
    if (row.status === "completed" && row.schedule_type === "once") return;
    if (row.status !== "active") throw new Error(`Task ${id} is not active`);

    this.enqueueTaskRun(row, () => this.getRunnableTask(id, true)).catch((err) => {
      this.deps.logger.error({ err, taskId: id }, "Automation background execution failed");
    });
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
    if (params.sessionMode !== undefined) fields.session_mode = "fresh";
    if (params.title !== undefined) fields.title = params.title;
    if (params.description !== undefined) fields.description = params.description;
    if (params.steps !== undefined) fields.steps = params.steps;
    if (params.edges !== undefined) fields.edges = params.edges;
    if (params.outputTarget !== undefined) fields.output_target = params.outputTarget;
    if (params.outputPlatform !== undefined) fields.output_platform = params.outputPlatform;
    if (params.outputThreadTs !== undefined) fields.output_thread_ts = params.outputThreadTs;
    if (params.outputMode !== undefined) fields.output_mode = params.outputMode;

    const row = await this.repo.update(id, fields, { incrementRevision: true });
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

  async refreshTaskSchedule(id: string): Promise<ScheduledTask | null> {
    const row = await this.repo.getById(id);
    if (!row) return null;
    this.unscheduleTask(id);
    if (row.status === "active") {
      try {
        await this.scheduleTask(row);
      } catch (err) {
        this.deps.logger.error({ err, taskId: id }, "TaskScheduler: failed to refresh task schedule, pausing it");
        await this.repo.updateStatus(id, "paused");
      }
    }
    const refreshed = await this.repo.getById(id);
    return refreshed ? this.toScheduledTask(refreshed) : null;
  }

  async executeStepById(
    id: string,
    stepId: string,
    options: { input?: unknown; useLatestUpstreamOutput?: boolean } = {},
  ): Promise<AutomationExecutionResult | null> {
    const row = await this.repo.getById(id);
    if (!row) throw new Error(`Task ${id} not found`);
    return testAutomationStep({
      task: row,
      triggerData: { testedAt: new Date().toISOString(), taskId: id, stepId },
      db: this.deps.db,
      logger: this.deps.logger,
      config: this.deps.config,
      runsRepo: this.deps.automationRunsRepo,
      stepContentRepo: this.deps.stepContentRepo,
      loadIntegrationProvider: this.deps.loadIntegrationProvider,
      listAgentEnvForRuntime: this.deps.listAgentEnvForRuntime,
      userRepo: this.deps.userRepo,
      runAgent: this.deps.runAgent,
      buildMcpServers: this.deps.buildMcpServers,
      getSlack: this.deps.getSlack,
      inboxMessagesRepo: this.deps.inboxMessagesRepo,
      sendDm: this.deps.sendDm,
      recordWorkflowStep: this.deps.recordWorkflowStep,
      stepId,
      input: options.input,
      useLatestUpstreamOutput: options.useLatestUpstreamOutput,
    });
  }

  async removeTask(id: string): Promise<boolean> {
    this.unscheduleTask(id);
    return this.repo.remove(id);
  }

  async pauseTask(id: string): Promise<void> {
    this.unscheduleTask(id);
    await this.repo.updateStatus(id, "paused", { incrementRevision: true });
  }

  async resumeTask(id: string): Promise<void> {
    await this.repo.updateStatus(id, "active", { incrementRevision: true });
    const row = await this.repo.getById(id);
    if (row) {
      await this.scheduleTask(row);
    }
  }

  async touchTaskRevision(id: string): Promise<void> {
    await this.repo.update(id, {}, { incrementRevision: true });
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
      scheduleType: row.schedule_type as "cron" | "interval" | "once" | "external",
      scheduleValue: row.schedule_value,
      timezone: row.timezone,
      sessionMode: "fresh",
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      status: row.status as "active" | "paused" | "completed",
      createdBy: row.created_by,
      createdAt: row.created_at,
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
      steps: row.steps,
      edges: row.edges,
      outputTarget: row.output_target,
      outputPlatform: row.output_platform,
      outputThreadTs: row.output_thread_ts,
      outputMode: row.output_mode === "silent" ? "silent" : "deliver",
      delivery: resolveWorkflowDelivery(row),
    };
  }
}
