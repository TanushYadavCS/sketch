import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isAutomationWebhookTrigger, parseAutomationTriggerConfig } from "../automation/webhook";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import type { TaskScheduler } from "../scheduler/service";

const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

interface AutomationWebhookRouteDeps {
  db: Kysely<DB>;
  logger?: Logger;
  scheduler: Pick<TaskScheduler, "enqueueTaskById">;
}

export function automationWebhookRoutes(deps: AutomationWebhookRouteDeps) {
  const routes = new Hono();
  const tasks = createScheduledTaskRepository(deps.db);

  routes.post("/wf/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const task = await tasks.getById(taskId);
    const trigger = task
      ? parseAutomationTriggerConfig(task.steps, {
          scheduleType: task.schedule_type,
          scheduleValue: task.schedule_value,
        })
      : undefined;

    if (!task || !trigger || !isAutomationWebhookTrigger(trigger)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Webhook endpoint not found" } }, 404);
    }
    if (task.status !== "active") {
      return c.json({ error: { code: "AUTOMATION_INACTIVE", message: "Automation is not active" } }, 409);
    }

    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook payload is too large" } }, 413);
    }

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook payload is too large" } }, 413);
    }

    let data: unknown = null;
    if (rawBody.trim().length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = rawBody;
      }
    }

    const triggerData = {
      source: "webhook" as const,
      requestedAt: new Date().toISOString(),
      data,
    };

    try {
      await deps.scheduler.enqueueTaskById(taskId, triggerData, { propagateParentAbort: false });
    } catch (error) {
      deps.logger?.warn({ taskId, error }, "Automation webhook rejected by scheduler");
      return c.json({ error: { code: "AUTOMATION_UNAVAILABLE", message: "Automation could not be queued" } }, 503);
    }

    return c.json(
      {
        accepted: true,
        taskId,
        trigger: {
          type: trigger.type,
          method: "POST",
          contentType: "application/json",
        },
      },
      202,
    );
  });

  return routes;
}
