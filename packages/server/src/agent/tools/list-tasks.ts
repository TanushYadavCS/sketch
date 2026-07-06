import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { type TaskStatus, createTaskRepository } from "../../db/repositories/tasks";
import type { SketchMcpDeps, ToolResult } from "./types";

export const listTasksToolDescription =
  "List current structural tasks from connected trackers by project entity or assignee entity. Returns tracker-owned status, assignee, project, and source references.";

export const listTasksToolSchema = {
  parentEntityId: z.string().optional().describe("Project entity ID whose tasks should be listed."),
  assigneeEntityId: z.string().optional().describe("Person entity ID whose assigned tasks should be listed."),
  status: z.enum(["open", "in_progress", "done", "dropped"]).optional().describe("Optional status filter."),
  limit: z.number().optional().describe("Maximum tasks to return. Default 50."),
};

type ListTasksArgs = z.infer<z.ZodObject<typeof listTasksToolSchema>>;

export async function handleListTasks(
  { parentEntityId, assigneeEntityId, status, limit }: ListTasksArgs,
  deps: SketchMcpDeps,
): Promise<ToolResult> {
  if (!deps.db) return { content: [{ type: "text", text: "Tasks are not available." }] };
  if (!parentEntityId && !assigneeEntityId) {
    return { content: [{ type: "text", text: "Provide parentEntityId or assigneeEntityId." }] };
  }
  const viewer = {
    email: await resolvePrimaryEmail(deps),
    isAdmin: false,
  };
  const repo = createTaskRepository(deps.db);
  const opts = {
    viewer,
    viewerUserId: deps.currentUserId,
    status: status as TaskStatus | undefined,
    limit: Math.min(limit ?? 50, 100),
  };
  const tasks = parentEntityId
    ? await repo.listTasksByParent(parentEntityId, opts)
    : await repo.listTasksByAssignee(assigneeEntityId as string, opts);
  if (tasks.length === 0) return { content: [{ type: "text", text: "No visible tasks found." }] };
  const lines = tasks.map((task) =>
    [
      `- ${task.title}`,
      `status=${task.status}`,
      task.status_raw ? `raw=${task.status_raw}` : null,
      task.external_ref ? `ref=${task.external_ref}` : null,
      task.source ? `source=${task.source}` : null,
      task.priority ? `priority=${task.priority}` : null,
      task.due_at ? `due=${task.due_at}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  );
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export function createListTasksTool(deps: SketchMcpDeps) {
  return tool("ListTasks", listTasksToolDescription, listTasksToolSchema, (args) => handleListTasks(args, deps));
}

async function resolvePrimaryEmail(deps: SketchMcpDeps): Promise<string | null> {
  if (deps.publicMcp?.userEmails?.length) return deps.publicMcp.userEmails[0];
  if (!deps.currentUserId || !deps.userRepo?.getAllEmailsForUser) return null;
  const emails = await deps.userRepo.getAllEmailsForUser(deps.currentUserId);
  return emails[0] ?? null;
}
