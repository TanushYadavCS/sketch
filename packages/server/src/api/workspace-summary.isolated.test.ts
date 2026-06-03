import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createMcpServerRepository } from "../db/repositories/mcp-servers";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb } from "../test-utils";

vi.mock("../integrations/factory", () => ({
  createProvider: vi.fn(),
}));

async function writeSkill(dir: string, id: string, name: string) {
  const skillDir = join(dir, id);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    ["---", `name: ${JSON.stringify(name)}`, 'description: "Test skill"', 'category: "productivity"', "---", ""].join(
      "\n",
    ),
    "utf-8",
  );
}

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(password);
  await settings.create();
  const admin = await users.create({
    name: "Admin User",
    email,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin;
}

async function loginAdmin(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "testpassword123" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function getMemberCookie(db: Kysely<DB>, userId: string): Promise<string> {
  const settings = createSettingsRepository(db);
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found in test DB");
  const token = await signJwt(userId, "member", row.jwt_secret);
  return `sketch_session=${token}`;
}

describe("Workspace summary API", () => {
  let db: Kysely<DB>;
  let dataDir: string;
  let claudeConfigDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-summary-data-"));
    claudeConfigDir = await mkdtemp(join(tmpdir(), "sketch-summary-claude-"));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
    await rm(claudeConfigDir, { recursive: true, force: true });
  });

  it("returns dashboard counts from existing workspace data", async () => {
    const admin = await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const member = await users.create({ name: "Alice Member", email: "alice@test.com" });
    await users.create({ name: "Research Agent", type: "agent", email: "agent@test.com" });

    await tasks.add({
      id: "task-active",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Daily summary",
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: admin.id,
      status: "active",
      next_run_at: "2026-05-26T08:00:00.000Z",
    });
    await tasks.add({
      id: "task-paused",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D456",
      thread_ts: null,
      prompt: "Paused summary",
      schedule_type: "cron",
      schedule_value: "0 10 * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: member.id,
      status: "paused",
      next_run_at: null,
    });
    await db
      .insertInto("automation_runs")
      .values({
        id: "run-active",
        task_id: "task-active",
        status: "running",
        trigger_data: null,
        step_outputs: "{}",
        error_message: null,
      })
      .execute();

    await writeSkill(join(claudeConfigDir, "skills"), "shared-research", "Shared Research");
    await writeSkill(join(dataDir, "workspaces", admin.id, ".claude", "skills"), "my-admin-skill", "My Admin Skill");

    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeConfigDir }), {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/workspace/summary", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      automations: {
        total: 2,
        active: 1,
        paused: 1,
        completed: 0,
        running: 1,
        nextRunAt: "2026-05-26T08:00:00.000Z",
      },
      skills: {
        total: 2,
        yours: 1,
        shared: 1,
      },
      integrations: {
        connected: 0,
        appNames: [],
      },
      team: {
        total: 3,
        humans: 2,
        agents: 1,
      },
    });
  });

  it("scopes automation counts to the signed-in member", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice Member", email: "alice@test.com" });
    const bob = await users.create({ name: "Bob Member", email: "bob@test.com" });

    await tasks.add({
      id: "task-alice",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Alice summary",
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: "2026-05-26T08:00:00.000Z",
    });
    await tasks.add({
      id: "task-bob",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D456",
      thread_ts: null,
      prompt: "Bob summary",
      schedule_type: "cron",
      schedule_value: "0 10 * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: bob.id,
      status: "active",
      next_run_at: "2026-05-27T08:00:00.000Z",
    });

    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeConfigDir }), {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });

    const res = await app.request("/api/workspace/summary", {
      headers: { Cookie: await getMemberCookie(db, alice.id) },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.automations).toMatchObject({
      total: 1,
      active: 1,
      nextRunAt: "2026-05-26T08:00:00.000Z",
    });
  });

  it("counts active integration connections from the configured provider", async () => {
    await seedAdmin(db);
    const mcpServers = createMcpServerRepository(db);
    const providerRow = await mcpServers.create({
      type: "canvas",
      displayName: "Canvas",
      url: "https://canvas.example.com/mcp",
      apiUrl: "https://canvas.example.com",
      credentials: JSON.stringify({ apiKey: "sk-test" }),
    });
    const mockProvider = {
      type: "canvas",
      listApps: vi.fn(),
      initiateConnection: vi.fn(),
      listConnections: vi.fn().mockResolvedValue([
        {
          id: "conn-gmail",
          providerId: providerRow.id,
          appId: "gmail",
          appName: "Gmail",
          status: "active",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        {
          id: "conn-slack",
          providerId: providerRow.id,
          appId: "slack",
          appName: "Slack",
          status: "active",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        {
          id: "conn-expired",
          providerId: providerRow.id,
          appId: "linear",
          appName: "Linear",
          status: "expired",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
      removeConnection: vi.fn(),
      isBrokerCapable: () => false,
      getBrokerSpec: () => null,
    };
    const { createProvider } = await import("../integrations/factory");
    vi.mocked(createProvider).mockReturnValue(mockProvider);

    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeConfigDir }), {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/workspace/summary", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.integrations).toEqual({
      connected: 2,
      appNames: ["Gmail", "Slack"],
    });
    expect(mockProvider.listConnections).toHaveBeenCalledWith("admin@test.com");
  });
});
