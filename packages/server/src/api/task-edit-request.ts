import type { Context } from "hono";
import type { HumanTaskChanges } from "../db/repositories/local-task-mutations";

const TASK_EDIT_REQUEST_LIMIT = 8 * 1024;
const TASK_EDIT_KEYS = new Set(["expectedRevision", "title", "priority", "dueAt", "status"]);
const TASK_EDIT_STATUSES = new Set(["open", "in_progress", "done", "dropped"]);
const TASK_EDIT_PRIORITIES = new Set(["high", "medium", "low"]);

export type TaskEditRequest = {
  expectedRevision?: number;
  changes: HumanTaskChanges;
};

export type TaskEditRequestResult =
  | { ok: true; value: TaskEditRequest }
  | { ok: false; status: 400 | 413; code: "BAD_REQUEST" | "PAYLOAD_TOO_LARGE"; message: string };

export async function readTaskEditRequest(c: Context): Promise<TaskEditRequestResult> {
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > TASK_EDIT_REQUEST_LIMIT) {
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "Task edit request exceeds 8 KiB" };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return badRequest("Invalid JSON");
  }
  if (!isRecord(body)) return badRequest("Task edit request must be an object");
  if (Object.keys(body).some((key) => !TASK_EDIT_KEYS.has(key))) return badRequest("Unknown task edit field");

  const expectedRevision = body.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0)) {
    return badRequest("Invalid expectedRevision");
  }

  const changes: HumanTaskChanges = {};
  if (Object.hasOwn(body, "title")) {
    if (typeof body.title !== "string") return badRequest("Invalid title");
    const title = body.title.trim();
    if (!title || [...title].length > 240) return badRequest("Invalid title");
    changes.title = title;
  }
  if (Object.hasOwn(body, "priority")) {
    if (body.priority !== null && (typeof body.priority !== "string" || !TASK_EDIT_PRIORITIES.has(body.priority))) {
      return badRequest("Invalid priority");
    }
    changes.priority = body.priority as HumanTaskChanges["priority"];
  }
  if (Object.hasOwn(body, "dueAt")) {
    if (body.dueAt !== null && (typeof body.dueAt !== "string" || !isCalendarDate(body.dueAt))) {
      return badRequest("Invalid dueAt");
    }
    changes.dueAt = body.dueAt as string | null;
  }
  if (Object.hasOwn(body, "status")) {
    if (typeof body.status !== "string" || !TASK_EDIT_STATUSES.has(body.status)) {
      return badRequest("Invalid status");
    }
    changes.status = body.status as HumanTaskChanges["status"];
  }
  if (Object.keys(changes).length === 0) return badRequest("At least one task field is required");

  const changesMetadata =
    Object.hasOwn(changes, "title") || Object.hasOwn(changes, "priority") || Object.hasOwn(changes, "dueAt");
  if (changesMetadata && expectedRevision === undefined) {
    return badRequest("expectedRevision is required for metadata edits");
  }
  return { ok: true, value: { expectedRevision: expectedRevision as number | undefined, changes } };
}

function badRequest(message: string): TaskEditRequestResult {
  return { ok: false, status: 400, code: "BAD_REQUEST", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
