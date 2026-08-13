import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { createAutomationSharesRepository } from "../../db/repositories/automation-shares";
import type { DB } from "../../db/schema";
import type { TaskScheduler } from "../../scheduler/service";
import type { TaskContext } from "../../scheduler/types";
import type { SearchableUserRepo, ToolResult } from "./types";

const manageAutomationSharesSchema = {
  action: z.enum(["list", "grant", "revoke"]).describe(`Action to perform.
- 'list': list the users this automation is shared with (requires task_id)
- 'grant': share an automation with a user (requires task_id and user)
- 'revoke': stop sharing an automation with a user (requires task_id and user)`),
  task_id: z.string().min(1).describe("ID of the automation to manage sharing for."),
  user: z
    .string()
    .optional()
    .describe("User to grant or revoke access for. Match by full email or by a name substring."),
};

export type ManageAutomationSharesParams = {
  action: "list" | "grant" | "revoke";
  task_id?: string;
  user?: string;
};

export interface ManageAutomationSharesDeps {
  scheduler: TaskScheduler;
  taskContext: TaskContext;
  db?: Kysely<DB>;
  userRepo?: SearchableUserRepo;
}

function taskTitle(task: { title: string | null; prompt: string }): string {
  return task.title?.trim() || task.prompt.trim() || "this automation";
}

/**
 * Resolve a user reference by exact email first, then by name substring.
 * Admin users are excluded from grant/revoke targets to match the web picker
 * contract (auth_role !== 'admin'); ambiguous name matches are rejected with
 * the candidate names so the caller can ask for a full email; zero matches
 * resolve to null.
 */
async function resolveUser(
  userRepo: SearchableUserRepo | undefined,
  query: string,
): Promise<{ id: string; name: string } | { ambiguous: string[] } | null> {
  if (!userRepo) return null;
  if (userRepo.findByEmail) {
    const byEmail = await userRepo.findByEmail(query).catch(() => undefined);
    if (byEmail && byEmail.auth_role !== "admin") return { id: byEmail.id, name: byEmail.name };
  }
  if (!userRepo.searchByNameSubstring) return null;
  const byName = await userRepo.searchByNameSubstring(query, 10).catch(() => []);
  const nonAdmins = byName.filter((user) => user.auth_role !== "admin");
  if (nonAdmins.length === 1) return { id: nonAdmins[0].id, name: nonAdmins[0].name };
  if (nonAdmins.length > 1) return { ambiguous: nonAdmins.map((user) => user.name) };
  return null;
}

export async function handleManageAutomationShares(
  params: ManageAutomationSharesParams,
  deps: ManageAutomationSharesDeps,
): Promise<ToolResult> {
  const text = (msg: string): ToolResult => ({ content: [{ type: "text" as const, text: msg }] });

  const taskId = params.task_id?.trim();
  if (!taskId) return text("Error: task_id is required for this action.");

  const createdBy = deps.taskContext.createdBy;
  const task = await deps.scheduler.getTaskById(taskId);
  if (!task || !createdBy) return text("Error: task not found.");
  if (task.createdBy !== createdBy) {
    return text(`Error: Only the owner can change sharing for "${taskTitle(task)}".`);
  }
  const db = deps.db;
  if (!db) return text("Error: automation sharing is not available in this context.");

  const shares = createAutomationSharesRepository(db);
  switch (params.action) {
    case "list": {
      const rows = await db
        .selectFrom("automation_task_shares")
        .selectAll()
        .where("task_id", "=", taskId)
        .orderBy("granted_at", "desc")
        .execute();
      const withNames = await Promise.all(
        rows.map(async (row) => ({
          user_id: row.user_id,
          name: (await deps.userRepo?.findById(row.user_id).catch(() => undefined))?.name ?? null,
          granted_by_user_id: row.granted_by_user_id,
          granted_at: row.granted_at,
        })),
      );
      return text(JSON.stringify(withNames, null, 2));
    }

    case "grant":
    case "revoke": {
      const userParam = params.user?.trim();
      if (!userParam) return text("Error: user is required for grant and revoke actions.");
      const resolved = await resolveUser(deps.userRepo, userParam);
      if (resolved === null) return text(`Error: No user matches "${userParam}".`);
      if ("ambiguous" in resolved) {
        return text(
          `Error: "${userParam}" matches multiple users (${resolved.ambiguous.join(", ")}). Use their full email instead.`,
        );
      }
      if (params.action === "grant") {
        await shares.grant({ taskId, userId: resolved.id, grantedByUserId: createdBy });
        return text(`Shared automation "${taskTitle(task)}" with ${resolved.name}.`);
      }
      const removed = await shares.revoke({ taskId, userId: resolved.id });
      return removed
        ? text(`Removed ${resolved.name}'s access to automation "${taskTitle(task)}".`)
        : text(`Error: ${resolved.name} does not have access to automation "${taskTitle(task)}".`);
    }
  }
}

export function createManageAutomationSharesTool(deps: Partial<ManageAutomationSharesDeps>) {
  return tool(
    "ManageAutomationShares",
    "Manage which users an automation is shared with. Platform, delivery target, and creator are filled in automatically from context. Do not ask the user for these.",
    manageAutomationSharesSchema,
    async (params) => {
      if (!deps.scheduler || !deps.taskContext) {
        return { content: [{ type: "text" as const, text: "Automation sharing is not available in this context." }] };
      }
      return handleManageAutomationShares(params, {
        scheduler: deps.scheduler,
        taskContext: deps.taskContext,
        db: deps.db,
        userRepo: deps.userRepo,
      });
    },
  );
}
