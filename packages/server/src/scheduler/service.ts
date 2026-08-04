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
import { constants, createWriteStream } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { workflowTriggerConfigSchema } from "@sketch/shared";
import { Cron } from "croner";
import type { Kysely } from "kysely";
import type { McpServerConfig, runAgent } from "../agent/runner";
import { resolveAgentRuntimeProviderConfigFromSettings } from "../agent/runtime/provider";
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
import { deliverProactiveDm } from "../whatsapp/proactive-delivery";
import { whatsappTargetFromDeliveryTarget } from "../whatsapp/provider";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { isSlackDmChannelId, isSlackUserId, resolveWorkflowDelivery } from "../workflows/delivery";
import {
  type AutomationExecutionResult,
  executeAutomation,
  resolveAutomationWorkspaceDir,
  testAutomationStep,
} from "../workflows/runtime";
import { createWorkflowDeliveryCapture } from "./delivery-capture";
import { parseOnceSchedule } from "./parse-once";
import { getScheduledTaskRowQueueKey } from "./queue-key";
import type { ScheduledTask } from "./types";

type AgentExecutionQueue = "interactive" | "scheduled";

function parseSlackTriggerSteps(value: string | null): Array<{ type?: string; triggerConfig?: unknown }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Array<{ type?: string; triggerConfig?: unknown }>) : [];
  } catch {
    return [];
  }
}

interface SlackTriggerFile {
  name?: unknown;
  urlPrivate?: unknown;
  mimetype?: unknown;
  size?: unknown;
  localPath?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CopiedSlackTriggerFiles {
  triggerData: unknown;
  localFileRoot?: string;
}

async function copySlackTriggerFilesToIsolatedWorkspace(params: {
  dataDir: string;
  task: ScheduledTaskRow;
  triggerData: unknown;
  sourceWorkspaceDir: string;
  logger: Logger;
}): Promise<CopiedSlackTriggerFiles> {
  if (!isRecord(params.triggerData) || !Array.isArray(params.triggerData.files)) {
    return { triggerData: params.triggerData };
  }

  const workspaceRoot = resolve(params.dataDir, "workspaces");
  const sourceWorkspace = resolve(params.sourceWorkspaceDir);
  const stagingRoot = resolve(params.dataDir, "automation-trigger-files");
  const destinationName = randomUUID();
  const destinationDir = join(stagingRoot, destinationName);
  let destinationDirPromise: Promise<string> | null = null;
  const prepareDestinationDir = () => {
    destinationDirPromise ??= (async () => {
      await mkdir(destinationDir, { recursive: true, mode: 0o700 });
      const [dataDirPath, stagingRootPath, destinationDirPath] = await Promise.all([
        realpath(params.dataDir),
        realpath(stagingRoot),
        realpath(destinationDir),
      ]);
      if (
        stagingRootPath !== join(dataDirPath, "automation-trigger-files") ||
        destinationDirPath !== join(stagingRootPath, destinationName)
      ) {
        throw new Error("Invalid automation trigger staging workspace");
      }
      return destinationDirPath;
    })();
    return destinationDirPromise;
  };
  const files = await Promise.all(
    params.triggerData.files.map(async (value): Promise<unknown> => {
      if (!isRecord(value)) return value;
      const file = value as SlackTriggerFile & Record<string, unknown>;
      if (typeof file.localPath !== "string") return file;

      try {
        const [sourcePath, sourceWorkspacePath, workspaceRootPath] = await Promise.all([
          realpath(resolve(file.localPath)),
          realpath(sourceWorkspace),
          realpath(workspaceRoot),
        ]);
        const relativeSourceWorkspace = sourceWorkspace.slice(workspaceRoot.length + 1);
        const expectedSourceWorkspacePath = resolve(workspaceRootPath, relativeSourceWorkspace);
        const sourceWorkspaceContained =
          sourceWorkspace.startsWith(`${workspaceRoot}${sep}`) && sourceWorkspacePath === expectedSourceWorkspacePath;
        const sourceFileContained =
          sourcePath === sourceWorkspacePath || sourcePath.startsWith(`${sourceWorkspacePath}${sep}`);
        if (!sourceWorkspaceContained || !sourceFileContained) {
          params.logger.warn(
            { taskId: params.task.id, fileName: file.name },
            "TaskScheduler: ignored Slack trigger file outside the source channel workspace",
          );
          const { localPath: _localPath, ...safeFile } = file;
          return safeFile;
        }

        const destinationDirPath = await prepareDestinationDir();
        const destinationPath = join(destinationDirPath, `${randomUUID()}-${basename(sourcePath)}`);
        const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const [openedStat, currentStat, currentPath] = await Promise.all([
            sourceHandle.stat(),
            stat(sourcePath),
            realpath(sourcePath),
          ]);
          if (currentPath !== sourcePath || openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
            throw new Error("Slack trigger file changed during validation");
          }
          await pipeline(
            sourceHandle.createReadStream({ autoClose: false }),
            createWriteStream(destinationPath, { flags: "wx" }),
          );
        } finally {
          await sourceHandle.close();
        }
        return { ...file, localPath: destinationPath };
      } catch (err) {
        params.logger.warn(
          { err, taskId: params.task.id, fileName: file.name },
          "TaskScheduler: failed to copy Slack trigger file into the automation workspace",
        );
        const { localPath: _localPath, ...safeFile } = file;
        return safeFile;
      }
    }),
  );

  return {
    triggerData: { ...params.triggerData, files },
    ...(destinationDirPromise ? { localFileRoot: await destinationDirPromise } : {}),
  };
}

export interface TaskSchedulerDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  queueManager: QueueManager;
  getSlack: () => SlackBot | null;
  whatsapp: WhatsAppRuntime;
  settingsRepo: ReturnType<typeof createSettingsRepository>;
  runAgent: typeof runAgent;
  runScheduledAgent: typeof runAgent;
  buildMcpServers: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  automationRunsRepo: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo: ReturnType<typeof createAutomationStepContentRepository>;
  userRepo: ReturnType<typeof createUserRepository>;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  sendDm?: Parameters<typeof runAgent>[0]["sendDm"];
  recordWorkflowStep?: RecordWorkflowStep;
  limitAgentExecution?: <T>(work: () => Promise<T>) => Promise<T>;
  limitScheduledAgentExecution: <T>(work: () => Promise<T>) => Promise<T>;
}

export class TaskScheduler {
  private cronInstances: Map<string, Cron> = new Map();
  private inflightTaskRuns: Set<string> = new Set();
  private repo: ReturnType<typeof createScheduledTaskRepository>;
  private deliveryCapture: ReturnType<typeof createWorkflowDeliveryCapture>;
  private conversations: ReturnType<typeof createConversationRepository>;
  private deps: TaskSchedulerDeps;

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps;
    this.repo = createScheduledTaskRepository(deps.db);
    this.conversations = createConversationRepository(deps.db);
    this.deliveryCapture = createWorkflowDeliveryCapture({
      conversations: this.conversations,
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

  /**
   * Fired by the cron/interval scheduler. Single-flight per task: if the
   * previous scheduled run is still queued or running, the new firing is
   * skipped instead of piling onto the queue. This prevents unbounded run and
   * memory growth when an interval fires faster than its agent run completes.
   * Manual triggers (executeTaskById/enqueueTaskById) are deliberate and stay
   * outside this guard; they still serialize behind the same queue key.
   */
  async executeTask(task: ScheduledTaskRow): Promise<void> {
    if (this.inflightTaskRuns.has(task.id)) {
      this.deps.logger.warn(
        { taskId: task.id, scheduleType: task.schedule_type },
        "TaskScheduler: previous scheduled run still in flight, skipping this firing",
      );
      return;
    }
    this.inflightTaskRuns.add(task.id);
    this.enqueueTaskRun(task, () => this.getRunnableTask(task.id, false), "scheduled")
      .catch((err) => {
        this.deps.logger.error({ err, taskId: task.id }, "Automation execution failed");
      })
      .finally(() => {
        this.inflightTaskRuns.delete(task.id);
      });
  }

  private async executeTaskNow(
    task: ScheduledTaskRow,
    executionQueue: AgentExecutionQueue,
    trigger?: { provided: boolean; data: unknown; localFileRoot?: string },
  ): Promise<AutomationExecutionResult> {
    const { config, logger, loadIntegrationProvider } = this.deps;
    const delivery = resolveWorkflowDelivery(task);
    const sendMessage = this.getSendMessage(task);

    if (!sendMessage && delivery.mode !== "silent") {
      throw new Error(`Delivery target for task ${task.id} is unavailable`);
    }

    const result = await executeAutomation({
      task,
      triggerData: trigger?.provided ? trigger.data : { scheduledAt: new Date().toISOString(), taskId: task.id },
      db: this.deps.db,
      logger,
      config,
      runsRepo: this.deps.automationRunsRepo,
      stepContentRepo: this.deps.stepContentRepo,
      loadIntegrationProvider,
      listAgentEnvForRuntime: this.deps.listAgentEnvForRuntime,
      userRepo: this.deps.userRepo,
      runAgent: executionQueue === "scheduled" ? this.deps.runScheduledAgent : this.deps.runAgent,
      buildMcpServers: this.deps.buildMcpServers,
      getSlack: this.deps.getSlack,
      inboxMessagesRepo: this.deps.inboxMessagesRepo,
      sendDm: this.deps.sendDm,
      sendMessage: sendMessage ?? undefined,
      recordWorkflowStep: this.deps.recordWorkflowStep,
      limitAgentExecution:
        executionQueue === "scheduled" ? this.deps.limitScheduledAgentExecution : this.deps.limitAgentExecution,
      loadAgentRuntimeProviderConfig: async () =>
        resolveAgentRuntimeProviderConfigFromSettings(await this.deps.settingsRepo.get()),
      trustedLocalFileRoot: trigger?.localFileRoot,
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
    executionQueue: AgentExecutionQueue,
    trigger?: { provided: boolean; data: unknown; localFileRoot?: string },
  ): Promise<AutomationExecutionResult | null> {
    const queueKey = this.getQueueKey(task);
    return new Promise<AutomationExecutionResult | null>((resolve, reject) => {
      const accepted = this.deps.queueManager.getQueue(queueKey).enqueue(async () => {
        try {
          const current = await getTask();
          if (!current) {
            resolve(null);
            return;
          }
          resolve(await this.executeTaskNow(current, executionQueue, trigger));
        } catch (err) {
          reject(err);
        }
      });
      if (!accepted) {
        reject(new Error(`Task ${task.id} run shed: queue ${queueKey} backlog is full`));
      }
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
      const target = whatsappTargetFromDeliveryTarget(delivery.targetId);
      const result =
        target.kind === "dm"
          ? await this.deliverWhatsAppDmForTask(task, target, text)
          : { mode: "text" as const, sent: await whatsapp.sendText(target, text) };
      const messageRef = result.sent?.providerMessageId;
      if (!messageRef || result.mode !== "text") return;
      await this.deliveryCapture.captureWhatsApp({
        deliveryTarget: "deliveryTarget" in result ? result.deliveryTarget : delivery.targetId,
        messageRef,
        providerTimestamp: result.sent?.providerTimestamp ?? null,
        text,
      });
    };
  }

  private async deliverWhatsAppDmForTask(
    task: ScheduledTaskRow,
    target: ReturnType<typeof whatsappTargetFromDeliveryTarget>,
    text: string,
  ) {
    if (target.kind !== "dm") throw new Error("Expected WhatsApp DM target");
    if (!task.created_by) throw new Error(`Task ${task.id} has no creator for WhatsApp DM delivery`);
    if (!this.deps.inboxMessagesRepo) throw new Error("Inbox storage is not available for WhatsApp DM delivery");
    const recipient = await this.deps.userRepo.findById(task.created_by);
    return deliverProactiveDm({
      target,
      recipientUserId: task.created_by,
      senderUserId: task.created_by,
      text,
      whatsapp: this.deps.whatsapp,
      conversations: this.conversations,
      inboxMessages: this.deps.inboxMessagesRepo,
      logger: this.deps.logger,
      recipientName: recipient?.name,
      recipientPhoneE164: recipient?.whatsapp_number ?? target.phoneE164,
      inboxMetadata: { source: "scheduled_task", taskId: task.id },
    });
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
    return this.enqueueTaskRun(row, () => this.getRunnableTask(id, true), "interactive");
  }

  async enqueueTaskById(
    id: string,
    ...triggerData: [] | [unknown] | [unknown, { localFileRoot: string }]
  ): Promise<void> {
    const row = await this.repo.getById(id);
    if (!row) throw new Error(`Task ${id} not found`);
    if (row.status === "completed" && row.schedule_type === "once") return;
    if (row.status !== "active") throw new Error(`Task ${id} is not active`);

    const trigger =
      triggerData.length === 0
        ? undefined
        : { provided: true, data: triggerData[0], localFileRoot: triggerData[1]?.localFileRoot };
    this.enqueueTaskRun(row, () => this.getRunnableTask(id, true), "interactive", trigger)
      .catch((err) => {
        this.deps.logger.error({ err, taskId: id }, "Automation background execution failed");
      })
      .finally(async () => {
        if (trigger?.localFileRoot) await rm(trigger.localFileRoot, { recursive: true, force: true });
      });
  }

  private async canDispatchSlackChannelMessage(task: ScheduledTaskRow, channelId: string): Promise<boolean> {
    if (!task.created_by) {
      this.deps.logger.warn({ taskId: task.id, channelId }, "TaskScheduler: skipping Slack trigger without a creator");
      return false;
    }

    try {
      const creator = await this.deps.userRepo.findById(task.created_by);
      if (!creator?.slack_user_id) {
        this.deps.logger.warn(
          { taskId: task.id, channelId },
          "TaskScheduler: skipping Slack trigger without a Slack creator",
        );
        return false;
      }

      const slack = this.deps.getSlack();
      if (!slack) {
        this.deps.logger.warn(
          { taskId: task.id, channelId },
          "TaskScheduler: skipping Slack trigger while Slack is unavailable",
        );
        return false;
      }

      const isMember = await slack.isUserInChannel(channelId, creator.slack_user_id);
      if (!isMember) {
        this.deps.logger.warn(
          { taskId: task.id, channelId },
          "TaskScheduler: skipping Slack trigger for a non-member creator",
        );
      }
      return isMember;
    } catch (err) {
      this.deps.logger.warn(
        { err, taskId: task.id, channelId },
        "TaskScheduler: failed to verify Slack trigger membership",
      );
      return false;
    }
  }

  async dispatchSlackChannelMessage(
    channelId: string,
    triggerData: unknown,
    options?: { sourceWorkspaceDir?: string },
  ): Promise<void> {
    const tasks = await this.repo.listActiveSlackChannelMessageTriggers();
    const membershipChecks = new Map<string, Promise<boolean>>();
    for (const task of tasks) {
      const steps = parseSlackTriggerSteps(task.steps);
      const trigger = steps.find((step) => step?.type === "trigger")?.triggerConfig;
      const parsed = workflowTriggerConfigSchema.safeParse(trigger);
      if (!parsed.success || parsed.data.type !== "slack_channel_message" || parsed.data.channelId !== channelId)
        continue;
      const membershipKey = task.created_by ?? `task:${task.id}`;
      let membershipCheck = membershipChecks.get(membershipKey);
      if (!membershipCheck) {
        membershipCheck = this.canDispatchSlackChannelMessage(task, channelId);
        membershipChecks.set(membershipKey, membershipCheck);
      }
      if (!(await membershipCheck)) continue;
      let localFileRoot: string | undefined;
      try {
        const copied = await copySlackTriggerFilesToIsolatedWorkspace({
          dataDir: this.deps.config.DATA_DIR,
          task,
          triggerData,
          sourceWorkspaceDir:
            options?.sourceWorkspaceDir ??
            (/^[A-Za-z0-9_-]+$/.test(channelId)
              ? resolve(this.deps.config.DATA_DIR, "workspaces", `channel-${channelId}`)
              : resolve(this.deps.config.DATA_DIR, "workspaces", ".invalid-slack-channel")),
          logger: this.deps.logger,
        });
        localFileRoot = copied.localFileRoot;
        if (localFileRoot) {
          await this.enqueueTaskById(task.id, copied.triggerData, { localFileRoot });
        } else {
          await this.enqueueTaskById(task.id, copied.triggerData);
        }
      } catch (err) {
        if (localFileRoot) await rm(localFileRoot, { recursive: true, force: true });
        this.deps.logger.warn(
          { err, taskId: task.id, channelId },
          "TaskScheduler: failed to enqueue Slack channel message trigger",
        );
      }
    }
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
      limitAgentExecution: this.deps.limitAgentExecution,
      loadAgentRuntimeProviderConfig: async () =>
        resolveAgentRuntimeProviderConfigFromSettings(await this.deps.settingsRepo.get()),
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

  async listTasks(filter: { deliveryTarget?: string; createdBy?: string; includeInactive?: boolean }): Promise<
    ScheduledTask[]
  > {
    let rows: ScheduledTaskRow[];
    if (filter.deliveryTarget) {
      rows = await this.repo.listByDeliveryTarget(filter.deliveryTarget);
    } else if (filter.createdBy) {
      rows = await this.repo.listByCreatedBy(filter.createdBy);
    } else if (filter.includeInactive) {
      rows = await this.repo.listAll();
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
      revision: row.revision,
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
