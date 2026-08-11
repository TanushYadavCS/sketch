import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isAutomationWebhookTrigger, parseAutomationTriggerConfig } from "../automation/webhook";
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_ID_MAX_LENGTH,
  WEBHOOK_SIGNATURE_HEADER,
  verifyWebhookAuth,
} from "../automation/webhook-auth";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createWebhookDeliveryRepository } from "../db/repositories/webhook-deliveries";
import { createWebhookEndpointRepository } from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import type { TaskScheduler } from "../scheduler/service";

const JSON_MEDIA_TYPE = "application/json";

type WebhookRouteKind = "endpoint" | "compatibility";
type WebhookAdmissionResult = Awaited<ReturnType<ReturnType<typeof createWebhookDeliveryRepository>["insertOrGet"]>>;

interface AutomationWebhookRouteDeps {
  db: Kysely<DB>;
  encryptionKey?: string;
  logger?: Logger;
  scheduler: Pick<TaskScheduler, "enqueueWebhookDelivery">;
}

class WebhookBodyTooLargeError extends Error {}

async function readRawBody(request: Request): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      size += chunk.byteLength;
      if (size > WEBHOOK_BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new WebhookBodyTooLargeError("Webhook payload is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function isJsonMediaType(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;
}

function errorResponse(c: Context, code: string, message: string, status: 400 | 401 | 404 | 409 | 413 | 415 | 503) {
  return c.json({ error: { code, message } }, status);
}

function requestEventId(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0 || value.length > WEBHOOK_EVENT_ID_MAX_LENGTH) return undefined;
  return value;
}

export function automationWebhookRoutes(deps: AutomationWebhookRouteDeps) {
  const routes = new Hono();
  const tasks = createScheduledTaskRepository(deps.db);
  const endpoints = createWebhookEndpointRepository(deps.db, deps.encryptionKey);
  const deliveries = createWebhookDeliveryRepository(deps.db);

  const handleWebhook = async (c: Context, kind: WebhookRouteKind) => {
    const identifier = c.req.param(kind === "endpoint" ? "endpointId" : "taskId");
    let stored: Awaited<ReturnType<typeof endpoints.getSecretById>>;
    try {
      stored =
        kind === "endpoint" ? await endpoints.getSecretById(identifier) : await endpoints.getSecretByTaskId(identifier);
    } catch (error) {
      deps.logger?.error({ err: error, endpointId: identifier }, "Webhook credential lookup failed");
      return errorResponse(c, "WEBHOOK_UNAVAILABLE", "Webhook credentials are temporarily unavailable", 503);
    }

    if (!stored || stored.endpoint.status !== "active") {
      return errorResponse(c, "NOT_FOUND", "Webhook endpoint not found", 404);
    }

    const task = await tasks.getById(stored.endpoint.task_id);
    const trigger = task
      ? parseAutomationTriggerConfig(task.steps, {
          scheduleType: task.schedule_type,
          scheduleValue: task.schedule_value,
        })
      : undefined;
    if (!task || !trigger || !isAutomationWebhookTrigger(trigger)) {
      return errorResponse(c, "NOT_FOUND", "Webhook endpoint not found", 404);
    }

    if (!isJsonMediaType(c.req.header("content-type"))) {
      return errorResponse(c, "UNSUPPORTED_MEDIA_TYPE", "Webhook content type must be application/json", 415);
    }

    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader !== undefined) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > WEBHOOK_BODY_LIMIT_BYTES) {
        return errorResponse(c, "PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
      }
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(c.req.raw);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        return errorResponse(c, "PAYLOAD_TOO_LARGE", "Webhook payload is too large", 413);
      }
      throw error;
    }

    const rawBodyText = rawBody.toString("utf8");
    const auth = verifyWebhookAuth({
      secret: stored.secret,
      rawBody,
      authorization: c.req.header("authorization"),
      signature: c.req.header(WEBHOOK_SIGNATURE_HEADER),
    });
    if (!auth.ok) {
      return errorResponse(c, "UNAUTHORIZED", "Webhook credentials are invalid", 401);
    }

    if (task.status !== "active") {
      return errorResponse(c, "AUTOMATION_INACTIVE", "Automation is not active", 409);
    }

    let data: unknown;
    try {
      data = JSON.parse(rawBodyText);
    } catch {
      return errorResponse(c, "INVALID_JSON", "Webhook payload must be valid JSON", 400);
    }

    const eventId = requestEventId(c.req.header(WEBHOOK_EVENT_ID_HEADER));
    if (eventId === undefined) {
      return errorResponse(c, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be between 1 and 200 characters", 400);
    }
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const triggerData = {
      source: "webhook" as const,
      requestedAt: new Date().toISOString(),
      eventId,
      data,
    };

    let admission: WebhookAdmissionResult;
    try {
      admission = await deps.db.transaction().execute((trx) =>
        createWebhookDeliveryRepository(trx).insertOrGet({
          endpointId: stored.endpoint.id,
          taskId: stored.endpoint.task_id,
          eventId,
          payloadHash,
          triggerData,
          taskRevision: task.revision,
          endpointGeneration: stored.endpoint.generation,
        }),
      );
    } catch (error) {
      deps.logger?.error({ err: error, endpointId: stored.endpoint.id }, "Webhook durable admission failed");
      return errorResponse(c, "ADMISSION_UNAVAILABLE", "Webhook admission is temporarily unavailable", 503);
    }

    const { delivery, created } = admission;
    if (delivery.payload_hash !== payloadHash) {
      return errorResponse(c, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different payload", 409);
    }

    try {
      await deps.scheduler.enqueueWebhookDelivery(delivery.id);
    } catch (error) {
      deps.logger?.warn({ error, deliveryId: delivery.id }, "Webhook delivery handoff failed");
    }

    return c.json(
      {
        accepted: true,
        duplicate: !created,
        deliveryId: delivery.id,
        eventId: delivery.event_id,
        taskId: task.id,
        trigger: {
          type: trigger.type,
          method: "POST",
          contentType: JSON_MEDIA_TYPE,
        },
      },
      202,
    );
  };

  routes.post("/v1/:endpointId", (c) => handleWebhook(c, "endpoint"));
  routes.post("/wf/:taskId", (c) => handleWebhook(c, "compatibility"));

  return routes;
}
