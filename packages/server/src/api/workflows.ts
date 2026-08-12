import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { McpServerConfig, RunAgentParams, runAgent } from "../agent/runner";
import { resolveAgentRuntimeProviderConfigFromSettings } from "../agent/runtime/provider";
import type { Config } from "../config";
import type { AgentEnvironmentRuntimeContext } from "../db/repositories/agent-environment-variables";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createConversationRepository } from "../db/repositories/conversations";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { type ScheduledTaskRow, createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { createCliIntegrationService } from "../integrations/cli/service";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import { createWorkflowDeliveryCapture } from "../scheduler/delivery-capture";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppSocketFacade } from "../whatsapp/facade-contract";
import { deliverProactiveDm } from "../whatsapp/proactive-delivery";
import { whatsappTargetFromDeliveryTarget } from "../whatsapp/provider";
import type { WhatsAppRuntime } from "../whatsapp/runtime";
import { isSlackDmChannelId, isSlackUserId, resolveWorkflowDelivery } from "../workflows/delivery";
import { executeAutomation } from "../workflows/runtime";

const deliveryModeSchema = z.enum(["silent", "target"]).default("silent");
const responseModeSchema = z.enum(["sse", "json"]).default("sse");
const workflowRunSourceSchema = z.enum(["external-api", "canvas"]).default("external-api");
const nullableCanvasMetadataStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().min(1).optional(),
);

const workflowRunSchema = z
  .object({
    requesterUserId: z.string().min(1).optional(),
    triggerData: z.unknown().optional(),
    deliveryMode: deliveryModeSchema,
    responseMode: responseModeSchema,
    source: workflowRunSourceSchema,
    canvasWorkflowId: nullableCanvasMetadataStringSchema,
    canvasTriggerNodeId: nullableCanvasMetadataStringSchema,
    canvasActionNodeId: nullableCanvasMetadataStringSchema,
    canvasRunId: nullableCanvasMetadataStringSchema,
    triggerComponentKey: nullableCanvasMetadataStringSchema,
  })
  .superRefine((value, ctx) => {
    if (value.source === "external-api" && !value.requesterUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requesterUserId"],
        message: "requesterUserId is required for external-api workflow runs",
      });
    }
  });

interface WorkflowRouteDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  users: ReturnType<typeof createUserRepository>;
  getSlack?: () => SlackBot | null;
  whatsapp?: WhatsAppSocketFacade;
  whatsappRuntime?: WhatsAppRuntime;
  runAgent?: typeof runAgent;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  listAgentEnvForRuntime?: (context: AgentEnvironmentRuntimeContext) => Promise<Record<string, string>>;
  cliIntegrations?: ReturnType<typeof createCliIntegrationService>;
  inboxMessagesRepo?: ReturnType<typeof createInboxMessagesRepository>;
  sendDm?: RunAgentParams["sendDm"];
  queueManager?: { getQueue: (key: string) => { enqueue: (fn: () => Promise<void>) => boolean } };
  limitAgentExecution?: <T>(work: () => Promise<T>) => Promise<T>;
}

class WorkflowApiError extends Error {
  code: string;
  status: 400 | 404 | 429;

  constructor(code: string, message: string, status: 400 | 404 | 429 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function parseStepOutputs(value: string | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function stepCount(task: ScheduledTaskRow): number {
  if (!task.steps) return 1;
  try {
    const steps = JSON.parse(task.steps);
    if (!Array.isArray(steps)) return 0;
    return steps.filter((step) => step?.type !== "trigger").length;
  } catch {
    return 0;
  }
}

function parseTriggerData(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function workflowMetadata(task: ScheduledTaskRow, summary?: { runCount: number; lastRunStatus: string | null }) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    platform: task.platform,
    contextType: task.context_type,
    deliveryTarget: task.delivery_target,
    outputTarget: task.output_target,
    outputPlatform: task.output_platform,
    outputThreadTs: task.output_thread_ts,
    outputMode: task.output_mode === "silent" ? "silent" : "deliver",
    delivery: resolveWorkflowDelivery(task),
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    timezone: task.timezone,
    sessionMode: "fresh",
    nextRunAt: task.next_run_at,
    lastRunAt: task.last_run_at,
    createdBy: task.created_by,
    createdAt: task.created_at,
    stepCount: stepCount(task),
    runCount: summary?.runCount ?? 0,
    lastRunStatus: summary?.lastRunStatus ?? null,
  };
}

async function listWorkflowMetadata(
  rows: ScheduledTaskRow[],
  runsRepo: ReturnType<typeof createAutomationRunsRepository>,
) {
  const summaries = rows.length > 0 ? await runsRepo.getRunSummaries(rows.map((task) => task.id)) : new Map();
  return rows.map((task) => workflowMetadata(task, summaries.get(task.id)));
}

function assertActiveWorkflow(task: ScheduledTaskRow | undefined): ScheduledTaskRow {
  if (!task) {
    throw new WorkflowApiError("WORKFLOW_NOT_FOUND", "Workflow not found", 404);
  }
  if (task.status !== "active") {
    throw new WorkflowApiError("INVALID_STATE", "Only active workflows can be invoked");
  }
  return task;
}

async function createDelivery(task: ScheduledTaskRow, deps: WorkflowRouteDeps) {
  const resolved = resolveWorkflowDelivery(task);
  if (resolved.mode === "silent") {
    return {
      delivery: { mode: "silent" },
      sendMessage: undefined,
    };
  }

  if (resolved.platform === "slack") {
    const slack = deps.getSlack?.() ?? null;
    if (!slack) {
      throw new WorkflowApiError("NOT_CONNECTED", "Slack is not connected");
    }
    const delivery: Record<string, unknown> = {
      mode: "target",
      platform: "slack",
      target: resolved.targetId,
      threadTs: resolved.threadTs,
    };
    return {
      delivery,
      sendMessage: async (text: string) => {
        if (resolved.threadTs) {
          const messageRef = await slack.postThreadReply(resolved.targetId, resolved.threadTs, text);
          delivery.messageRef = messageRef;
          return;
        }
        let targetId = resolved.targetId;
        if (resolved.targetType === "dm" && isSlackUserId(targetId) && !isSlackDmChannelId(targetId)) {
          const dmChannelId = await slack.openDmChannel(targetId);
          if (!dmChannelId) {
            throw new WorkflowApiError("NOT_CONNECTED", "Could not open Slack DM channel");
          }
          targetId = dmChannelId;
        }
        const messageRef = await slack.postMessage(targetId, text);
        delivery.messageRef = messageRef;
      },
    };
  }

  const whatsappConnected =
    deps.whatsappRuntime?.isConnected ?? (await deps.whatsapp?.pairing.status())?.connected ?? false;
  if (!whatsappConnected) {
    throw new WorkflowApiError("NOT_CONNECTED", "WhatsApp is not connected");
  }
  const delivery: Record<string, unknown> = { mode: "target", platform: "whatsapp", target: resolved.targetId };
  const conversations = createConversationRepository(deps.db);
  const capture = deps.whatsappRuntime
    ? createWorkflowDeliveryCapture({
        conversations,
        settingsRepo: createSettingsRepository(deps.db),
        logger: deps.logger,
      })
    : null;
  return {
    delivery,
    sendMessage: async (text: string) => {
      if (deps.whatsappRuntime) {
        const target = whatsappTargetFromDeliveryTarget(resolved.targetId);
        const result =
          target.kind === "dm"
            ? await deliverWorkflowWhatsAppDm(task, target, text, deps, conversations)
            : { mode: "text" as const, sent: await deps.whatsappRuntime.sendText(target, text) };
        const messageRef = result.sent?.providerMessageId;
        if (messageRef) delivery.messageRef = messageRef;
        if (messageRef && result.mode === "text") {
          await capture?.captureWhatsApp({
            deliveryTarget: "deliveryTarget" in result ? result.deliveryTarget : resolved.targetId,
            messageRef,
            providerTimestamp: result.sent?.providerTimestamp ?? null,
            text,
          });
        }
      } else {
        await deps.whatsapp?.send(resolved.targetId, { kind: "text", text }, { idempotencyKey: randomUUID() });
      }
    },
  };
}

async function deliverWorkflowWhatsAppDm(
  task: ScheduledTaskRow,
  target: ReturnType<typeof whatsappTargetFromDeliveryTarget>,
  text: string,
  deps: WorkflowRouteDeps,
  conversations: ReturnType<typeof createConversationRepository>,
) {
  if (target.kind !== "dm") throw new Error("Expected WhatsApp DM target");
  if (!task.created_by)
    throw new WorkflowApiError("INVALID_STATE", "Workflow creator is required for WhatsApp DM delivery");
  if (!deps.inboxMessagesRepo)
    throw new WorkflowApiError("INVALID_STATE", "Inbox storage is required for WhatsApp DM delivery");
  if (!deps.whatsappRuntime) throw new WorkflowApiError("NOT_CONNECTED", "WhatsApp is not connected");
  const recipient = await deps.users.findById(task.created_by);
  return deliverProactiveDm({
    target,
    recipientUserId: task.created_by,
    senderUserId: task.created_by,
    text,
    whatsapp: deps.whatsappRuntime,
    conversations,
    inboxMessages: deps.inboxMessagesRepo,
    logger: deps.logger,
    recipientName: recipient?.name,
    recipientPhoneE164: recipient?.whatsapp_number ?? target.phoneE164,
    inboxMetadata: { source: "workflow", taskId: task.id },
  });
}
function finalOutputSummary(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value.slice(0, 200) : JSON.stringify(value).slice(0, 200);
}

type WorkflowRunRequest = z.infer<typeof workflowRunSchema>;

interface ExecuteWorkflowRunParams {
  workflowId: string;
  task: ScheduledTaskRow;
  triggerData: unknown;
  parsed: WorkflowRunRequest;
  deps: WorkflowRouteDeps;
  runsRepo: ReturnType<typeof createAutomationRunsRepository>;
  stepContentRepo: ReturnType<typeof createAutomationStepContentRepository>;
  loadIntegrationProvider: () => Promise<IntegrationProvider | null>;
  onEvent?: Parameters<typeof executeAutomation>[0]["onEvent"];
}

async function executeWorkflowRun(params: ExecuteWorkflowRunParams) {
  const { workflowId, task, triggerData, parsed, deps, runsRepo, stepContentRepo, loadIntegrationProvider, onEvent } =
    params;
  const delivery =
    parsed.deliveryMode === "target"
      ? await createDelivery(task, deps)
      : { delivery: { mode: "silent" }, sendMessage: undefined };

  const result = await executeAutomation({
    task,
    triggerData,
    db: deps.db,
    logger: deps.logger,
    config: deps.config,
    runsRepo,
    stepContentRepo,
    loadIntegrationProvider,
    listAgentEnvForRuntime: deps.listAgentEnvForRuntime,
    cliIntegrations: deps.cliIntegrations,
    userRepo: deps.users,
    runAgent: deps.runAgent,
    buildMcpServers: deps.buildMcpServers,
    getSlack: deps.getSlack,
    inboxMessagesRepo: deps.inboxMessagesRepo,
    sendDm: deps.sendDm,
    sendMessage: delivery.sendMessage,
    onEvent,
    limitAgentExecution: deps.limitAgentExecution,
    loadAgentRuntimeProviderConfig: async () =>
      resolveAgentRuntimeProviderConfigFromSettings(
        await createSettingsRepository(deps.db, deps.config.ENCRYPTION_KEY).get(),
      ),
  });

  return {
    ok: result.status === "completed",
    workflowId,
    runId: result.runId,
    status: result.status,
    finalOutput: result.finalOutput,
    finalOutputSummary: finalOutputSummary(result.finalOutput),
    stepOutputs: result.stepOutputs,
    delivery: delivery.delivery,
  };
}

function enqueueWorkflowRun<T>(deps: WorkflowRouteDeps, workflowId: string, run: () => Promise<T>): Promise<T> {
  if (!deps.queueManager) return run();
  return new Promise<T>((resolve, reject) => {
    const accepted = deps.queueManager?.getQueue(`workflow-${workflowId}`).enqueue(async () => {
      try {
        resolve(await run());
      } catch (err) {
        reject(err);
      }
    });
    if (accepted === false) {
      reject(new WorkflowApiError("QUEUE_SATURATED", "Workflow queue is full; try again later.", 429));
    }
  });
}

async function authorizeWorkflowOwner(
  c: import("hono").Context,
  task: ScheduledTaskRow,
  users: ReturnType<typeof createUserRepository>,
): Promise<void> {
  if (c.get("role") === "admin") return;
  const subject = c.get("sub");
  const user = subject?.includes("@") ? await users.findByEmail(subject) : await users.findById(subject);
  if (!user || !task.created_by || task.created_by !== user.id) {
    throw new WorkflowApiError("WORKFLOW_NOT_FOUND", "Workflow not found", 404);
  }
}

async function resolveRequesterId(
  parsed: WorkflowRunRequest,
  task: ScheduledTaskRow,
  users: ReturnType<typeof createUserRepository>,
): Promise<string> {
  const requesterUserId = parsed.requesterUserId ?? (parsed.source === "canvas" ? task.created_by : undefined);
  if (!requesterUserId) {
    throw new WorkflowApiError("REQUESTER_NOT_FOUND", "Workflow requester could not be resolved", 404);
  }

  const requester = await users.findById(requesterUserId);
  if (!requester) {
    throw new WorkflowApiError("REQUESTER_NOT_FOUND", "Requester user not found", 404);
  }

  return requester.id;
}

function buildCanvasMetadata(parsed: WorkflowRunRequest) {
  if (parsed.source !== "canvas") return undefined;

  const canvas = {
    workflowId: parsed.canvasWorkflowId,
    triggerNodeId: parsed.canvasTriggerNodeId,
    actionNodeId: parsed.canvasActionNodeId,
    runId: parsed.canvasRunId,
    triggerComponentKey: parsed.triggerComponentKey,
  };
  const compact = Object.fromEntries(Object.entries(canvas).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function buildTriggerData(parsed: WorkflowRunRequest, requesterUserId: string) {
  const canvas = buildCanvasMetadata(parsed);
  return {
    source: parsed.source,
    requesterUserId,
    requestedAt: new Date().toISOString(),
    ...(canvas ? { canvas } : {}),
    data: parsed.triggerData ?? null,
  };
}

export function workflowRoutes(deps: WorkflowRouteDeps) {
  const routes = new Hono();
  const tasks = createScheduledTaskRepository(deps.db);
  const runsRepo = createAutomationRunsRepository(deps.db);
  const stepContentRepo = createAutomationStepContentRepository(deps.db);
  const loadIntegrationProvider = deps.loadIntegrationProvider ?? (async () => null);

  routes.get("/", async (c) => {
    const rows = await tasks.listActive();
    const subject = c.get("sub");
    const viewer = subject?.includes("@") ? await deps.users.findByEmail(subject) : await deps.users.findById(subject);
    const visibleRows = c.get("role") === "admin" ? rows : rows.filter((task) => task.created_by === viewer?.id);
    const workflows = await listWorkflowMetadata(visibleRows, runsRepo);
    return c.json({ workflows });
  });

  routes.post("/:workflowId/runs", async (c) => {
    const workflowId = c.req.param("workflowId");
    const body = await c.req.json().catch(() => ({}));
    const parsed = workflowRunSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(errorBody("VALIDATION_ERROR", message), 400);
    }

    let task: ScheduledTaskRow;
    try {
      task = assertActiveWorkflow(await tasks.getById(workflowId));
      await authorizeWorkflowOwner(c, task, deps.users);
      const requesterUserId = await resolveRequesterId(parsed.data, task, deps.users);
      if (c.get("role") !== "admin" && parsed.data.requesterUserId && parsed.data.requesterUserId !== requesterUserId) {
        throw new WorkflowApiError("WORKFLOW_NOT_FOUND", "Workflow not found", 404);
      }
      const triggerData = buildTriggerData(parsed.data, requesterUserId);

      if (parsed.data.responseMode === "json") {
        const response = await enqueueWorkflowRun(deps, workflowId, () =>
          executeWorkflowRun({
            workflowId,
            task,
            triggerData,
            parsed: parsed.data,
            deps,
            runsRepo,
            stepContentRepo,
            loadIntegrationProvider,
          }),
        );
        return c.json(response);
      }

      return streamSSE(c, async (stream) => {
        const writeEvent = async (event: string, data: unknown) => {
          if (stream.aborted) return;
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        };

        try {
          const response = await enqueueWorkflowRun(deps, workflowId, () =>
            executeWorkflowRun({
              workflowId,
              task,
              triggerData,
              parsed: parsed.data,
              deps,
              runsRepo,
              stepContentRepo,
              loadIntegrationProvider,
              onEvent: async (event) => {
                if (event.type === "completed") return;
                const { type, ...data } = event;
                await writeEvent(type, data);
              },
            }),
          );

          await writeEvent("completed", response);
        } catch (err) {
          if (stream.aborted) return;
          if (err instanceof WorkflowApiError) {
            await writeEvent("error", errorBody(err.code, err.message));
            return;
          }
          deps.logger.warn({ err, workflowId }, "Workflow invoke stream failed");
          const message = err instanceof Error ? err.message : "Workflow run failed";
          await writeEvent("error", errorBody("RUN_FAILED", message));
        }
      });
    } catch (err) {
      if (err instanceof WorkflowApiError) {
        return c.json(errorBody(err.code, err.message), err.status);
      }
      throw err;
    }
  });

  routes.get("/:workflowId/runs/:runId", async (c) => {
    const workflowId = c.req.param("workflowId");
    const runId = c.req.param("runId");
    const task = await tasks.getById(workflowId);
    if (!task) {
      return c.json(errorBody("WORKFLOW_NOT_FOUND", "Workflow not found"), 404);
    }
    try {
      await authorizeWorkflowOwner(c, task, deps.users);
    } catch (error) {
      if (error instanceof WorkflowApiError) return c.json(errorBody(error.code, error.message), error.status);
      throw error;
    }

    const run = await runsRepo.getById(runId);
    if (!run || run.task_id !== workflowId) {
      return c.json(errorBody("RUN_NOT_FOUND", "Run not found"), 404);
    }

    return c.json({
      run: {
        ...run,
        trigger_data: parseTriggerData(run.trigger_data),
        step_outputs: parseStepOutputs(run.step_outputs),
      },
    });
  });

  routes.get("/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    const task = await tasks.getById(workflowId);
    if (!task || task.status !== "active") {
      return c.json(errorBody("WORKFLOW_NOT_FOUND", "Workflow not found"), 404);
    }
    try {
      await authorizeWorkflowOwner(c, task, deps.users);
    } catch (error) {
      if (error instanceof WorkflowApiError) return c.json(errorBody(error.code, error.message), error.status);
      throw error;
    }
    const summaries = await runsRepo.getRunSummaries([task.id]);
    return c.json({ workflow: workflowMetadata(task, summaries.get(task.id)) });
  });

  return routes;
}
