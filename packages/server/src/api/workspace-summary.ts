import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Kysely, Selectable } from "kysely";
import type { Config } from "../config";
import type { createMcpServerRepository } from "../db/repositories/mcp-servers";
import type { createUserRepository } from "../db/repositories/users";
import type { DB, ScheduledTasksTable } from "../db/schema";
import { createProvider } from "../integrations/factory";
import { loadClaudeSkillsFromDirAsync } from "../skills/loader";

type UserRepo = ReturnType<typeof createUserRepository>;
type McpServerRepo = ReturnType<typeof createMcpServerRepository>;
type ScheduledTaskRow = Selectable<ScheduledTasksTable>;

interface WorkspaceSummaryDeps {
  db: Kysely<DB>;
  config: Pick<Config, "DATA_DIR" | "CLAUDE_CONFIG_DIR">;
  users: UserRepo;
  mcpServers: McpServerRepo;
}

function workspaceRoot(dataDir: string): string {
  return join(dataDir, "workspaces");
}

async function loadWorkspaceSkillIds(dataDir: string): Promise<Array<{ workspaceId: string; skillId: string }>> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(workspaceRoot(dataDir), { withFileTypes: true });
  } catch {
    return [];
  }

  const skillsByWorkspace = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillsDir = join(workspaceRoot(dataDir), entry.name, ".claude", "skills");
        const skills = await loadClaudeSkillsFromDirAsync(skillsDir);
        return skills.map((skill) => ({ workspaceId: entry.name, skillId: skill.id }));
      }),
  );

  return skillsByWorkspace.flat();
}

async function buildSkillsSummary(config: WorkspaceSummaryDeps["config"], userId: string | null) {
  const orgSkills = await loadClaudeSkillsFromDirAsync(join(config.CLAUDE_CONFIG_DIR, "skills"));
  const workspaceSkills = await loadWorkspaceSkillIds(config.DATA_DIR);
  const orgSkillIds = new Set(orgSkills.map((skill) => skill.id));
  const librarySkillIds = new Set(orgSkillIds);
  const yours = new Set(
    userId ? workspaceSkills.filter((skill) => skill.workspaceId === userId).map((skill) => skill.skillId) : [],
  );

  for (const { skillId } of workspaceSkills) {
    librarySkillIds.add(skillId);
  }

  return {
    total: librarySkillIds.size,
    yours: yours.size,
    shared: orgSkillIds.size,
  };
}

function summarizeAutomations(tasks: ScheduledTaskRow[], running: number) {
  const activeTasks = tasks.filter((task) => task.status === "active");
  const nextRunAt =
    activeTasks
      .map((task) => task.next_run_at)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;

  return {
    total: tasks.length,
    active: activeTasks.length,
    paused: tasks.filter((task) => task.status === "paused").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    running,
    nextRunAt,
  };
}

async function countRunningAutomationRuns(db: Kysely<DB>, taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;

  const row = await db
    .selectFrom("automation_runs")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("task_id", "in", taskIds)
    .where("status", "=", "running")
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

async function listVisibleTasks(db: Kysely<DB>, role: "admin" | "member", userId: string | null) {
  if (role !== "admin" && !userId) return [];

  let query = db.selectFrom("scheduled_tasks").selectAll();
  if (role !== "admin") {
    query = query.where("created_by", "=", userId);
  }

  return query.execute();
}

async function resolveCurrentUser(users: UserRepo, sub: string, email: string | null) {
  const byId = await users.findById(sub);
  if (byId) return byId;
  if (email) return users.findByEmail(email);
  if (sub.includes("@")) return users.findByEmail(sub);
  return null;
}

async function buildIntegrationSummary(mcpServers: McpServerRepo, userEmail: string | null) {
  if (!userEmail) return { connected: 0, appNames: [] as string[] };

  try {
    const row = await mcpServers.findIntegrationProvider();
    if (!row?.type || !row.api_url) return { connected: 0, appNames: [] as string[] };

    const provider = createProvider(row.type, row.api_url, row.credentials, row.id);
    const connections = await provider.listConnections(userEmail);
    const activeConnections = connections.filter((connection) => connection.status === "active");
    const appNames = Array.from(new Set(activeConnections.map((connection) => connection.appName).filter(Boolean)));
    return { connected: activeConnections.length, appNames };
  } catch {
    return { connected: 0, appNames: [] as string[] };
  }
}

async function buildTeamSummary(users: UserRepo) {
  const rows = await users.list();
  const agents = rows.filter((user) => user.type === "agent").length;
  return {
    total: rows.length,
    humans: rows.length - agents,
    agents,
  };
}

export function workspaceSummaryRoutes(deps: WorkspaceSummaryDeps) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const role = c.get("role");
    const sub = c.get("sub");
    const email = c.get("email");
    const user = await resolveCurrentUser(deps.users, sub, email);
    const visibleTasks = await listVisibleTasks(deps.db, role, user?.id ?? null);
    const running = await countRunningAutomationRuns(
      deps.db,
      visibleTasks.map((task) => task.id),
    );
    const [skills, integrations, team] = await Promise.all([
      buildSkillsSummary(deps.config, user?.id ?? null),
      buildIntegrationSummary(deps.mcpServers, user?.email ?? email),
      buildTeamSummary(deps.users),
    ]);

    return c.json({
      automations: summarizeAutomations(visibleTasks, running),
      skills,
      integrations,
      team,
    });
  });

  return routes;
}
