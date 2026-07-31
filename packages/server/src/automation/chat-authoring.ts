import { randomUUID } from "node:crypto";
import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import type { Kysely } from "kysely";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import type { TaskScheduler } from "../scheduler/service";
import type { TaskContext } from "../scheduler/types";
import type { ScheduledTask } from "../scheduler/types";
import type { AutomationAuthoringService } from "./authoring/service";
import { buildAutomationDefinition } from "./definition";
import { createAutomationDefinition, replaceAutomationDefinition } from "./persistence";

type AuthoringScheduler = Pick<TaskScheduler, "getTaskById" | "refreshTaskSchedule">;

export interface ChatAutomationAuthoringInput {
  action: "create" | "edit";
  request: string;
  taskId?: string;
  taskContext: TaskContext;
}

export type ChatAutomationAuthoringResult =
  | {
      kind: "saved";
      task: ScheduledTask;
      artifact: {
        steps: Array<AutomationBuilderSaveRequest["steps"][number] & { apps?: string[] }>;
        scheduleType: string;
        scheduleValue: string;
        timezone: string;
      };
    }
  | { kind: "clarification"; message: string }
  | { kind: "error"; message: string };

export interface ChatAutomationAuthoring {
  author(input: ChatAutomationAuthoringInput): Promise<ChatAutomationAuthoringResult>;
}

function artifactFromDefinition(definition: AutomationBuilderSaveRequest) {
  return {
    steps: definition.steps.map((step) => {
      const apps = definition.stepContent[step.id]?.apps;
      return apps ? { ...step, apps } : step;
    }),
    scheduleType: definition.scheduleType,
    scheduleValue: definition.scheduleValue,
    timezone: definition.timezone,
  };
}

async function brokerCapable(
  loadIntegrationProvider: () => Promise<Pick<IntegrationProvider, "isBrokerCapable"> | null>,
): Promise<boolean> {
  const provider = await loadIntegrationProvider();
  return Boolean(provider?.isBrokerCapable());
}

async function refreshPersistedTask(scheduler: AuthoringScheduler, taskId: string): Promise<ScheduledTask | null> {
  return (await scheduler.refreshTaskSchedule(taskId)) ?? scheduler.getTaskById(taskId);
}

export function createChatAutomationAuthoring(deps: {
  db: Kysely<DB>;
  authoring: AutomationAuthoringService;
  scheduler: AuthoringScheduler;
  loadIntegrationProvider: () => Promise<Pick<IntegrationProvider, "isBrokerCapable"> | null>;
  createId?: () => string;
  now?: () => Date;
}): ChatAutomationAuthoring {
  const createId = deps.createId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const tasks = createScheduledTaskRepository(deps.db);
  const stepContent = createAutomationStepContentRepository(deps.db);

  async function refreshOrError(
    taskId: string,
    artifact: ReturnType<typeof artifactFromDefinition>,
  ): Promise<ChatAutomationAuthoringResult> {
    try {
      const task = await refreshPersistedTask(deps.scheduler, taskId);
      if (!task) {
        return {
          kind: "error",
          message: "Automation was saved, but its refreshed scheduler state could not be loaded.",
        };
      }
      return { kind: "saved", task, artifact };
    } catch {
      return {
        kind: "error",
        message:
          "Automation was saved, but its schedule could not be refreshed. Restart the scheduler before relying on it.",
      };
    }
  }

  async function create(input: ChatAutomationAuthoringInput): Promise<ChatAutomationAuthoringResult> {
    if (!input.taskContext.createdBy) {
      return { kind: "error", message: "Automation creator is not available in this context." };
    }
    const taskId = createId();
    const canUseBroker = await brokerCapable(deps.loadIntegrationProvider);
    const result = await deps.authoring.create({
      request: input.request,
      serverContext: {
        taskId,
        platform: input.taskContext.platform,
        contextType: input.taskContext.contextType,
        deliveryDefaults: {
          platform: input.taskContext.platform,
          targetType: input.taskContext.contextType,
          targetId: input.taskContext.deliveryTarget,
          threadTs: null,
          mode: "deliver",
        },
        timezone: input.taskContext.creatorTimezone?.trim() || "UTC",
        currentTime: now().toISOString(),
      },
      brokerCapable: canUseBroker,
    });
    if (result.kind === "clarification") {
      return { kind: "clarification", message: result.question };
    }

    await createAutomationDefinition({
      db: deps.db,
      request: result.definition,
      context: {
        id: taskId,
        platform: input.taskContext.platform,
        contextType: input.taskContext.contextType,
        deliveryTarget: input.taskContext.deliveryTarget,
        threadTs: input.taskContext.threadTs ?? null,
        createdBy: input.taskContext.createdBy,
        originPlatform: input.taskContext.origin?.platform ?? null,
        originConversationId: input.taskContext.origin?.conversationId ?? null,
        originProviderThreadId: input.taskContext.origin?.providerThreadId ?? null,
        originMessageId: input.taskContext.origin?.currentMessageId ?? null,
      },
      brokerCapable: canUseBroker,
    });
    return refreshOrError(taskId, artifactFromDefinition(result.definition));
  }

  async function edit(input: ChatAutomationAuthoringInput): Promise<ChatAutomationAuthoringResult> {
    if (!input.taskId) return { kind: "error", message: "Automation not found." };
    const row = await tasks.getById(input.taskId);
    if (
      !row ||
      !input.taskContext.createdBy ||
      (!input.taskContext.canManageAnyTask && row.created_by !== input.taskContext.createdBy)
    ) {
      return { kind: "error", message: "Automation not found." };
    }

    const stepContentRows = await stepContent.getByTask(row.id);
    const existing = buildAutomationDefinition({ row, stepContentRows, runRows: [] });
    const canUseBroker = await brokerCapable(deps.loadIntegrationProvider);
    const result = await deps.authoring.edit({
      request: input.request,
      existing,
      brokerCapable: canUseBroker,
    });
    if (result.kind === "clarification") {
      return { kind: "clarification", message: result.question };
    }

    const saved = await replaceAutomationDefinition({
      db: deps.db,
      taskId: row.id,
      request: result.definition,
      actor: {
        userId: input.taskContext.createdBy,
        canManageAnyTask: input.taskContext.canManageAnyTask ?? false,
      },
      brokerCapable: canUseBroker,
    });
    if (saved.kind === "not_found") return { kind: "error", message: "Automation not found." };
    if (saved.kind === "revision_conflict") {
      return {
        kind: "error",
        message: "Automation was changed by another editor. Refresh it and try again.",
      };
    }
    return refreshOrError(row.id, artifactFromDefinition(result.definition));
  }

  return {
    author(input: ChatAutomationAuthoringInput): Promise<ChatAutomationAuthoringResult> {
      return input.action === "create" ? create(input) : edit(input);
    },
  };
}
