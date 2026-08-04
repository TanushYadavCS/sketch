import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createAutomationTaskConversationService } from "../automation/task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb } from "../test-utils";

const config = createTestConfig();

async function seedAdmin(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  const admin = await users.create({
    name: "Admin",
    email: "admin-conversations@test.com",
    emailVerified: true,
    passwordHash: await hashPassword("testpassword123"),
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  return admin;
}

async function loginAdmin(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin-conversations@test.com", password: "testpassword123" }),
  });
  return response.headers.get("set-cookie") ?? "";
}

async function memberCookie(db: Kysely<DB>, userId: string): Promise<string> {
  const settings = createSettingsRepository(db);
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("JWT secret not found");
  return `sketch_session=${await signJwt(userId, "member", row.jwt_secret)}`;
}

async function seedTask(db: Kysely<DB>, id: string, createdBy: string) {
  await createScheduledTaskRepository(db).add({
    id,
    platform: "slack",
    context_type: "dm",
    delivery_target: "D123",
    thread_ts: null,
    prompt: "Summarize the task",
    schedule_type: "cron",
    schedule_value: "0 9 * * *",
    timezone: "UTC",
    session_mode: "fresh",
    created_by: createdBy,
    status: "active",
    next_run_at: null,
  });
}

describe("scheduled task conversation API", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates one stable builder association, supports new chats, and archives without deleting", async () => {
    const admin = await seedAdmin(db);
    const member = await createUserRepository(db).create({ name: "Member", email: "member-conversations@test.com" });
    await seedTask(db, "task-conversations", member.id);

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await memberCookie(db, member.id);

    const first = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const firstConversationId = firstBody.conversation.conversationId;
    expect(firstConversationId).toMatch(/^builder-/);

    const refresh = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).conversation.conversationId).toBe(firstConversationId);

    const second = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true }),
    });
    expect(second.status).toBe(201);
    const secondConversationId = (await second.json()).conversation.conversationId;
    expect(secondConversationId).not.toBe(firstConversationId);

    const list = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      headers: { Cookie: cookie },
    });
    expect(list.status).toBe(200);
    expect((await list.json()).conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: firstConversationId, state: "active" }),
        expect.objectContaining({ conversationId: secondConversationId, state: "active" }),
      ]),
    );

    const archive = await app.request(`/api/scheduled-tasks/task-conversations/conversations/${firstConversationId}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archive.status).toBe(200);
    expect((await archive.json()).conversation).toMatchObject({
      conversationId: firstConversationId,
      state: "archived",
    });

    const selectArchived = await app.request(
      `/api/scheduled-tasks/task-conversations/conversations/${firstConversationId}`,
      {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(selectArchived.status).toBe(409);
    await expect(selectArchived.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_ARCHIVED" },
    });
    const archivedRows = await db
      .selectFrom("scheduled_task_conversations")
      .select(["archived_at"])
      .where("task_id", "=", "task-conversations")
      .where("conversation_id", "=", firstConversationId)
      .execute();
    expect(archivedRows.every((row) => row.archived_at !== null)).toBe(true);

    const activeList = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      headers: { Cookie: cookie },
    });
    expect((await activeList.json()).conversations).toEqual([
      expect.objectContaining({ conversationId: secondConversationId, state: "active" }),
    ]);

    const historicalList = await app.request(
      "/api/scheduled-tasks/task-conversations/conversations?includeArchived=true",
      { headers: { Cookie: cookie } },
    );
    expect((await historicalList.json()).conversations).toEqual(
      expect.arrayContaining([expect.objectContaining({ conversationId: firstConversationId, state: "archived" })]),
    );

    await expect(
      db.selectFrom("scheduled_task_conversations").selectAll().where("task_id", "=", "task-conversations").execute(),
    ).resolves.toHaveLength(2);
    expect(admin.id).not.toBe(member.id);
  });

  it("keeps foreign-owner transcripts out of admin task navigation", async () => {
    const admin = await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-conversations@test.com" });
    const member = await createUserRepository(db).create({ name: "Member", email: "member-two@test.com" });
    await seedTask(db, "foreign-task", owner.id);
    await createAutomationTaskConversationService(db).associate({
      taskId: "foreign-task",
      conversationId: "owner-private-chat",
      transcriptUserId: owner.id,
      kind: "builder",
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const adminCookie = await loginAdmin(app);
    const adminList = await app.request("/api/scheduled-tasks/foreign-task/conversations", {
      headers: { Cookie: adminCookie },
    });
    expect(adminList.status).toBe(200);
    await expect(adminList.json()).resolves.toMatchObject({ conversations: [], transcriptAccess: "viewer" });

    const adminDetail = await app.request("/api/scheduled-tasks/foreign-task/conversations/owner-private-chat", {
      headers: { Cookie: adminCookie },
    });
    expect(adminDetail.status).toBe(404);
    await expect(adminDetail.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    const memberResponse = await app.request("/api/scheduled-tasks/foreign-task/conversations", {
      headers: { Cookie: await memberCookie(db, member.id) },
    });
    expect(memberResponse.status).toBe(404);
    expect(admin.id).not.toBe(owner.id);
  });

  it("rejects unrelated or malformed selections without creating associations", async () => {
    const admin = await seedAdmin(db);
    await seedTask(db, "safe-task", admin.id);
    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const cookie = await loginAdmin(app);

    const malformed = await app.request("/api/scheduled-tasks/safe-task/conversations/has%20space", {
      headers: { Cookie: cookie },
    });
    expect(malformed.status).toBe(400);

    const unrelated = await app.request("/api/scheduled-tasks/safe-task/conversations/not-associated", {
      headers: { Cookie: cookie },
    });
    expect(unrelated.status).toBe(404);

    const putUnrelated = await app.request("/api/scheduled-tasks/safe-task/conversations/not-associated", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(putUnrelated.status).toBe(404);
    await expect(putUnrelated.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    const postGuessed = await app.request("/api/scheduled-tasks/safe-task/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "guessed-builder", createNew: true }),
    });
    expect(postGuessed.status).toBe(404);
    await expect(postGuessed.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    await expect(
      db.selectFrom("scheduled_task_conversations").selectAll().where("task_id", "=", "safe-task").execute(),
    ).resolves.toEqual([]);
  });
});
