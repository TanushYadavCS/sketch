import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb } from "../test-utils";

const config = createTestConfig();

async function seedAdmin(db: Kysely<DB>, email = "admin@test.com", password = "testpassword123") {
  const settings = createSettingsRepository(db);
  const hash = await hashPassword(password);
  await settings.create({ adminEmail: email, adminPasswordHash: hash });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
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

describe("Scheduled Tasks API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("returns all tasks for admins with resolved labels", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const groups = createWhatsAppGroupRepository(db);

    const member = await users.create({ name: "Alice Member", email: "alice@test.com" });

    await db
      .insertInto("channels")
      .values({
        id: "channel-1",
        slack_channel_id: "C123",
        name: "ops",
        type: "public_channel",
      })
      .execute();

    await groups.upsert({
      jid: "999@g.us",
      name: "Leads Group",
      description: "Daily leads",
      updated_at: "2026-03-13T12:00:00.000Z",
    });

    await tasks.add({
      id: "task-channel",
      platform: "slack",
      context_type: "channel",
      delivery_target: "C123",
      thread_ts: null,
      prompt: "Post the ops summary",
      schedule_type: "cron",
      schedule_value: "0 9 * * 1",
      timezone: "Asia/Kolkata",
      session_mode: "fresh",
      created_by: member.id,
      status: "active",
      next_run_at: null,
    });
    await tasks.add({
      id: "task-group",
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "999@g.us",
      thread_ts: null,
      prompt: "Share a WhatsApp update",
      schedule_type: "interval",
      schedule_value: "7200",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: member.id,
      status: "paused",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks).toHaveLength(2);
    const labels = body.tasks.map((task: { targetLabel: string }) => task.targetLabel);
    expect(labels).toContain("#ops");
    expect(labels).toContain("Leads Group");

    const slackTask = body.tasks.find((task: { id: string }) => task.id === "task-channel");
    const whatsappTask = body.tasks.find((task: { id: string }) => task.id === "task-group");
    expect(slackTask.creatorName).toBe("Alice Member");
    expect(slackTask.targetKindLabel).toBe("Slack channel");
    expect(whatsappTask.targetKindLabel).toBe("WhatsApp group");
    expect(whatsappTask.canResume).toBe(true);
  });

  it("returns all tasks regardless of who created them", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);

    const alice = await users.create({ name: "Alice", email: "alice@test.com" });
    const bob = await users.create({ name: "Bob", email: "bob@test.com" });

    await tasks.add({
      id: "task-alice",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Alice task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "chat",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });
    await tasks.add({
      id: "task-bob",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "bob@s.whatsapp.net",
      thread_ts: null,
      prompt: "Bob task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "chat",
      created_by: bob.id,
      status: "active",
      next_run_at: null,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await getMemberCookie(db, alice.id);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks).toHaveLength(2);
    const ids = body.tasks.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual(["task-alice", "task-bob"]);
  });

  it("falls back to raw delivery targets when metadata is missing", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-missing-group",
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "unknown@g.us",
      thread_ts: null,
      prompt: "Missing metadata",
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tasks[0].targetLabel).toBe("unknown@g.us");
  });

  it("returns 403 when a member pauses another user's task", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });
    const bob = await users.create({ name: "Bob", email: "bob@test.com" });

    await tasks.add({
      id: "task-bob",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Bob task",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "chat",
      created_by: bob.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await getMemberCookie(db, alice.id);

    const res = await app.request("/api/scheduled-tasks/task-bob/pause", {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(403);
    expect(scheduler.pauseTask).not.toHaveBeenCalled();
  });


  it("returns the updated task after pause and resume", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-1",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Check in",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "chat",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(async (id: string) => {
        await tasks.updateStatus(id, "paused");
      }),
      resumeTask: vi.fn(async (id: string) => {
        await tasks.updateStatus(id, "active");
      }),
      removeTask: vi.fn(async () => true),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const pauseRes = await app.request("/api/scheduled-tasks/task-1/pause", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(pauseRes.status).toBe(200);
    expect((await pauseRes.json()).task.status).toBe("paused");

    const resumeRes = await app.request("/api/scheduled-tasks/task-1/resume", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).task.status).toBe("active");
  });

  it("deletes tasks successfully", async () => {
    await seedAdmin(db);
    const users = createUserRepository(db);
    const tasks = createScheduledTaskRepository(db);
    const alice = await users.create({ name: "Alice", email: "alice@test.com" });

    await tasks.add({
      id: "task-delete",
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "alice@s.whatsapp.net",
      thread_ts: null,
      prompt: "Delete me",
      schedule_type: "interval",
      schedule_value: "3600",
      timezone: "UTC",
      session_mode: "chat",
      created_by: alice.id,
      status: "active",
      next_run_at: null,
    });

    const scheduler = {
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      removeTask: vi.fn(async (id: string) => tasks.remove(id)),
      executeTaskById: vi.fn(),
    };
    const app = createApp(db, config, { scheduler });
    const cookie = await loginAdmin(app);

    const res = await app.request("/api/scheduled-tasks/task-delete", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    await expect(tasks.getById("task-delete")).resolves.toBeUndefined();
  });
});
