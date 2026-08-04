import type { Context } from "hono";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { createAutomationTaskConversationService } from "../automation/task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { resolveScheduledTaskAccess } from "../scheduler/access";

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CONVERSATION_KINDS = new Set(["builder", "web_chat"]);

interface ScheduledTaskConversationRouteOptions {
  logger?: Logger;
}

function errorResponse(c: Context, code: string, message: string, status: 400 | 403 | 404 | 409) {
  return c.json({ error: { code, message } }, status);
}

function parseConversationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const conversationId = value.trim();
  return CONVERSATION_ID_RE.test(conversationId) ? conversationId : null;
}

function parseKind(value: unknown): "builder" | "web_chat" | null {
  if (typeof value !== "string" || !CONVERSATION_KINDS.has(value)) return null;
  return value as "builder" | "web_chat";
}

async function resolveUserId(db: Kysely<DB>, subject: string | undefined): Promise<string | null> {
  if (!subject) return null;
  const users = createUserRepository(db);
  if (subject.includes("@")) {
    const user = await users.findByEmail(subject);
    return user?.id ?? null;
  }
  const user = await users.findById(subject);
  return user?.id ?? null;
}

/**
 * Exposes task-scoped conversation association metadata without exposing
 * transcript content. Clients must use the returned conversation ID with the
 * existing viewer-scoped web-chat transcript endpoint.
 */
export function scheduledTaskConversationRoutes(db: Kysely<DB>, options: ScheduledTaskConversationRouteOptions = {}) {
  const routes = new Hono();
  const tasks = createScheduledTaskRepository(db);
  const conversations = createAutomationTaskConversationService(db);

  async function loadAccessibleTask(c: Context, taskId: string) {
    const row = await tasks.getById(taskId);
    if (!row) {
      return { response: errorResponse(c, "NOT_FOUND", "Scheduled task not found", 404) };
    }

    const userId = await resolveUserId(db, c.get("sub"));
    const accessibleTask = resolveScheduledTaskAccess(row, row.created_by, {
      userId,
      role: c.get("role"),
    });
    if (!accessibleTask) {
      options.logger?.warn({ taskId, userId, ownerUserId: row.created_by }, "task-conversations: task access denied");
      return { response: errorResponse(c, "NOT_FOUND", "Scheduled task not found", 404) };
    }

    return { row: accessibleTask, userId };
  }

  async function readBody(c: Context): Promise<Record<string, unknown>> {
    const body = await c.req.json().catch(() => ({}));
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  }

  routes.get("/:id/conversations", async (c) => {
    const taskId = c.req.param("id");
    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    const includeArchived = c.req.query("includeArchived") === "true";
    const taskConversations = await conversations.listForTranscriptUser(taskId, access.userId, { includeArchived });
    return c.json({ taskId, conversations: taskConversations, transcriptAccess: "viewer" as const });
  });

  routes.post("/:id/conversations", async (c) => {
    const taskId = c.req.param("id");
    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    const body = await readBody(c);
    const requestedConversationId =
      body.conversationId === undefined ? undefined : parseConversationId(body.conversationId);
    if (requestedConversationId === null) {
      return errorResponse(c, "VALIDATION_ERROR", "Conversation id is invalid", 400);
    }
    const kind = body.kind === undefined ? "builder" : parseKind(body.kind);
    if (!kind) return errorResponse(c, "VALIDATION_ERROR", "Conversation kind is invalid", 400);

    if (kind === "web_chat" && !requestedConversationId) {
      return errorResponse(c, "VALIDATION_ERROR", "A web chat conversation id is required", 400);
    }

    let result: { association: Awaited<ReturnType<typeof conversations.associate>>; created: boolean };
    if (kind === "builder" && !requestedConversationId && body.createNew !== true) {
      result = await conversations.getOrCreateBuilderConversation(taskId, access.userId);
    } else if (kind === "builder") {
      const existing = requestedConversationId
        ? await conversations.getForTranscriptUser(taskId, requestedConversationId, access.userId, {
            includeArchived: true,
          })
        : undefined;
      result = await conversations.createBuilderConversation(taskId, access.userId, requestedConversationId);
      result.created = !existing;
    } else {
      const existing = await conversations.getForTranscriptUser(
        taskId,
        requestedConversationId as string,
        access.userId,
        {
          includeArchived: true,
        },
      );
      result = {
        association: await conversations.associate({
          taskId,
          conversationId: requestedConversationId as string,
          transcriptUserId: access.userId,
          kind,
        }),
        created: !existing,
      };
    }

    const summary = await conversations.getForTranscriptUser(
      taskId,
      result.association.conversation_id,
      access.userId,
      { includeArchived: true },
    );
    if (!summary) {
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation association was not persisted", 409);
    }

    const response = { conversation: summary, created: result.created };
    return result.created ? c.json(response, 201) : c.json(response);
  });

  routes.get("/:id/conversations/:conversationId", async (c) => {
    const taskId = c.req.param("id");
    const conversationId = parseConversationId(c.req.param("conversationId"));
    if (!conversationId) return errorResponse(c, "VALIDATION_ERROR", "Conversation id is invalid", 400);

    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    const summary = await conversations.getForTranscriptUser(taskId, conversationId, access.userId, {
      includeArchived: true,
    });
    if (!summary)
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation is not associated with this task", 404);
    return c.json({ conversation: summary });
  });

  routes.put("/:id/conversations/:conversationId", async (c) => {
    const taskId = c.req.param("id");
    const conversationId = parseConversationId(c.req.param("conversationId"));
    if (!conversationId) return errorResponse(c, "VALIDATION_ERROR", "Conversation id is invalid", 400);

    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    const body = await readBody(c);
    const kind = body.kind === undefined ? "builder" : parseKind(body.kind);
    if (!kind) return errorResponse(c, "VALIDATION_ERROR", "Conversation kind is invalid", 400);

    const existing = await conversations.getForTranscriptUser(taskId, conversationId, access.userId, {
      includeArchived: true,
    });
    await conversations.associate({
      taskId,
      conversationId,
      transcriptUserId: access.userId,
      kind,
    });
    const summary = await conversations.getForTranscriptUser(taskId, conversationId, access.userId, {
      includeArchived: true,
    });
    if (!summary) return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation association was not persisted", 409);

    const response = { conversation: summary, created: !existing };
    return existing ? c.json(response) : c.json(response, 201);
  });

  routes.patch("/:id/conversations/:conversationId", async (c) => {
    const taskId = c.req.param("id");
    const conversationId = parseConversationId(c.req.param("conversationId"));
    if (!conversationId) return errorResponse(c, "VALIDATION_ERROR", "Conversation id is invalid", 400);

    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    const body = await readBody(c);
    if (typeof body.archived !== "boolean") {
      return errorResponse(c, "VALIDATION_ERROR", "archived must be a boolean", 400);
    }

    const summary = await conversations.archiveForTranscriptUser(taskId, conversationId, access.userId, body.archived);
    if (!summary)
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation is not associated with this task", 404);
    return c.json({ conversation: summary });
  });

  return routes;
}
