import type { Context } from "hono";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import pino from "pino";
import { ensureWorkspace } from "../agent/workspace";
import {
  type AutomationTaskConversationLockSummary,
  type BuilderConversationAccessResult,
  createAutomationTaskConversationService,
} from "../automation/task-conversations";
import type { Config } from "../config";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { resolveScheduledTaskAccess } from "../scheduler/access";
import { readWebChatTranscript, readWebChatTranscriptUpdatedAt } from "./web-chat";

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CONVERSATION_KINDS = new Set(["builder", "web_chat"]);

interface ScheduledTaskConversationRouteOptions {
  logger?: Logger;
  /** Web-chat transcript storage; required for the transcript-content route. */
  config?: Config;
}

function errorResponse(
  c: Context,
  code: string,
  message: string,
  status: 400 | 403 | 404 | 409 | 503,
  details: Record<string, unknown> = {},
) {
  return c.json({ error: { code, message, ...details } }, status);
}

function builderLockError(c: Context, lock: AutomationTaskConversationLockSummary) {
  return c.json(
    {
      error: {
        code: "BUILDER_CHAT_LOCKED",
        message: "This automation's builder chat is in use by another session",
        builderLock: lock,
      },
    },
    409,
  );
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
 * Exposes task-scoped conversation association metadata. Owners and admins may
 * list and open every transcript association (including the transcript user's
 * name); other members remain scoped to their own associations. Transcript
 * message content is served by the existing web-chat transcript endpoint.
 */
export function scheduledTaskConversationRoutes(db: Kysely<DB>, options: ScheduledTaskConversationRouteOptions = {}) {
  const routes = new Hono();
  const tasks = createScheduledTaskRepository(db);
  const shares = createAutomationSharesRepository(db);
  const conversations = createAutomationTaskConversationService(db);
  const conversationRows = createScheduledTaskConversationRepository(db);
  const logger = options.logger ?? pino({ level: "silent" });

  async function loadAccessibleTask(c: Context, taskId: string) {
    const row = await tasks.getById(taskId);
    if (!row) {
      return { response: errorResponse(c, "NOT_FOUND", "Scheduled task not found", 404) };
    }

    const userId = await resolveUserId(db, c.get("sub"));
    const hasGrant = userId ? await shares.hasGrant(taskId, userId) : false;
    const accessibleTask = resolveScheduledTaskAccess(
      row,
      row.created_by,
      hasGrant ? new Set(userId ? [userId] : []) : new Set<string>(),
      {
        userId,
        role: c.get("role"),
      },
    );
    if (!accessibleTask) {
      options.logger?.warn({ taskId, userId, ownerUserId: row.created_by }, "task-conversations: task access denied");
      return { response: errorResponse(c, "NOT_FOUND", "Scheduled task not found", 404) };
    }

    const isOwner = userId !== null && row.created_by === userId;
    const isAdmin = c.get("role") === "admin";
    return {
      row: accessibleTask,
      userId,
      transcriptAccess: isOwner ? ("owner" as const) : isAdmin ? ("admin" as const) : ("viewer" as const),
    };
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
    const taskConversations =
      access.transcriptAccess === "viewer"
        ? await conversations.listForTranscriptUser(taskId, access.userId, { includeArchived })
        : await conversations.listForTask(taskId, { includeArchived });
    const builderLock = await conversations.getBuilderLock(taskId, access.userId);
    return c.json({ taskId, conversations: taskConversations, builderLock, transcriptAccess: access.transcriptAccess });
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

    let result:
      | {
          kind: "created";
          association: Awaited<ReturnType<typeof conversations.associate>>;
          created: true;
          lock: AutomationTaskConversationLockSummary;
        }
      | BuilderConversationAccessResult;
    if (kind === "builder" && !requestedConversationId && body.createNew === true) {
      result = await conversations.createBuilderConversation(taskId, access.userId);
    } else if (!requestedConversationId) {
      const activeBuilder = await conversations.listForTranscriptUser(taskId, access.userId, { kind: "builder" });
      const existingConversationId = activeBuilder[0]?.conversationId;
      if (!existingConversationId) {
        const builderLock = await conversations.getBuilderLock(taskId, access.userId);
        if (builderLock.state === "held") return builderLockError(c, builderLock);
        return errorResponse(
          c,
          "CONVERSATION_NOT_FOUND",
          "No active builder conversation exists; start a new chat explicitly",
          404,
        );
      }
      result = await conversations.selectBuilderConversation(taskId, existingConversationId, access.userId, "builder");
    } else {
      const existing = await conversations.getForTranscriptUser(taskId, requestedConversationId, access.userId, {
        includeArchived: true,
      });
      if (!existing) {
        return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation is not associated with this task", 404);
      }

      const active = await conversations.getForTranscriptUser(taskId, requestedConversationId, access.userId);
      if (!active) {
        return errorResponse(c, "CONVERSATION_ARCHIVED", "Conversation is archived; restore it before selecting", 409);
      }
      if (!active.kinds.includes(kind)) {
        return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation kind is not associated with this task", 404);
      }

      result =
        kind === "builder"
          ? await conversations.selectBuilderConversation(taskId, requestedConversationId, access.userId, kind)
          : {
              kind: "active" as const,
              association: await conversations.associate({
                taskId,
                conversationId: requestedConversationId,
                transcriptUserId: access.userId,
                kind,
              }),
              lock: await conversations.getBuilderLock(taskId, access.userId),
              created: false as const,
            };
    }

    if (result.kind === "locked") return builderLockError(c, result.lock);
    if (result.kind !== "active" && result.kind !== "created") {
      return errorResponse(c, "CONVERSATION_UNAVAILABLE", "Conversation is temporarily unavailable", 409);
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

    const response = {
      conversation: summary,
      created: result.kind === "created",
      builderLock: result.lock,
    };
    return result.created ? c.json(response, 201) : c.json(response);
  });

  routes.get("/:id/conversations/:conversationId/messages", async (c) => {
    const taskId = c.req.param("id");
    const conversationId = parseConversationId(c.req.param("conversationId"));
    if (!conversationId) return errorResponse(c, "VALIDATION_ERROR", "Conversation id is invalid", 400);
    if (!options.config) {
      return errorResponse(c, "TRANSCRIPT_UNAVAILABLE", "Transcript storage is not configured", 503);
    }

    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    // Owners and admins may read any associated conversation's transcript;
    // other members stay scoped to their own transcript user id.
    const rows =
      access.transcriptAccess === "viewer"
        ? await conversationRows.listByTaskConversationForTranscriptUser(taskId, conversationId, access.userId, {
            includeArchived: true,
          })
        : await conversationRows.listByTaskConversationForTask(taskId, conversationId, { includeArchived: true });
    if (rows.length === 0) {
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation is not associated with this task", 404);
    }

    const transcriptUserId = rows[0].transcript_user_id;
    const workspaceDir = await ensureWorkspace(options.config, transcriptUserId);
    const messages = await readWebChatTranscript(
      options.config,
      workspaceDir,
      transcriptUserId,
      logger,
      conversationId,
    );
    const updatedAt = await readWebChatTranscriptUpdatedAt(
      options.config,
      workspaceDir,
      transcriptUserId,
      logger,
      conversationId,
    );
    return c.json({ messages, updatedAt });
  });

  routes.get("/:id/conversations/:conversationId", async (c) => {
    const taskId = c.req.param("id");
    const conversationId = parseConversationId(c.req.param("conversationId"));
    if (!conversationId) return errorResponse(c, "VALIDATION_ERROR", "Conversation id is invalid", 400);

    const access = await loadAccessibleTask(c, taskId);
    if ("response" in access) return access.response;
    if (!access.userId) return errorResponse(c, "TRANSCRIPT_ACCESS_DENIED", "Transcript access is viewer-scoped", 403);

    const summary =
      access.transcriptAccess === "viewer"
        ? await conversations.getForTranscriptUser(taskId, conversationId, access.userId, { includeArchived: true })
        : await conversations.getForTask(taskId, conversationId, { includeArchived: true });
    if (!summary)
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation is not associated with this task", 404);
    return c.json({
      conversation: summary,
      builderLock: await conversations.getBuilderLock(taskId, access.userId),
    });
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
    if (!existing) {
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation is not associated with this task", 404);
    }
    const active = await conversations.getForTranscriptUser(taskId, conversationId, access.userId);
    if (!active) {
      return errorResponse(c, "CONVERSATION_ARCHIVED", "Conversation is archived; restore it before selecting", 409);
    }
    if (body.kind !== undefined && !active.kinds.includes(kind)) {
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation kind is not associated with this task", 404);
    }
    const selectedKind = body.kind === undefined ? active.kinds[0] : kind;
    if (!selectedKind) {
      return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation association is unavailable", 404);
    }
    let lock = await conversations.getBuilderLock(taskId, access.userId);
    if (selectedKind === "builder") {
      const selection = await conversations.selectBuilderConversation(
        taskId,
        conversationId,
        access.userId,
        selectedKind,
      );
      if (selection.kind === "locked") return builderLockError(c, selection.lock);
      if (selection.kind !== "active") {
        return errorResponse(c, "CONVERSATION_UNAVAILABLE", "Conversation is temporarily unavailable", 409);
      }
      lock = selection.lock;
    } else {
      await conversations.associate({
        taskId,
        conversationId,
        transcriptUserId: access.userId,
        kind: selectedKind,
      });
    }
    const summary = await conversations.getForTranscriptUser(taskId, conversationId, access.userId, {
      includeArchived: true,
    });
    if (!summary) return errorResponse(c, "CONVERSATION_NOT_FOUND", "Conversation association was not persisted", 409);

    const response = { conversation: summary, created: false, builderLock: lock };
    return c.json(response);
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
    return c.json({
      conversation: summary,
      builderLock: await conversations.getBuilderLock(taskId, access.userId),
    });
  });

  return routes;
}
