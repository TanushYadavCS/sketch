import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createAutomationTaskConversationService } from "../automation/task-conversations";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
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
    const clientSessionId = "tab-conversations";

    const first = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true, clientSessionId }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const firstConversationId = firstBody.conversation.conversationId;
    expect(firstConversationId).toMatch(/^builder-/);

    const refresh = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientSessionId, generation: firstBody.builderLock.generation }),
    });
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).conversation.conversationId).toBe(firstConversationId);

    const archive = await app.request(`/api/scheduled-tasks/task-conversations/conversations/${firstConversationId}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true, clientSessionId, generation: firstBody.builderLock.generation }),
    });
    expect(archive.status).toBe(200);

    const second = await app.request("/api/scheduled-tasks/task-conversations/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true, clientSessionId }),
    });
    expect(second.status).toBe(201);
    const secondConversationId = (await second.json()).conversation.conversationId;
    expect(secondConversationId).not.toBe(firstConversationId);

    const list = await app.request("/api/scheduled-tasks/task-conversations/conversations?includeArchived=true", {
      headers: { Cookie: cookie },
    });
    expect(list.status).toBe(200);
    expect((await list.json()).conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: firstConversationId, state: "archived" }),
        expect.objectContaining({ conversationId: secondConversationId, state: "active" }),
      ]),
    );

    expect((await archive.json()).conversation).toMatchObject({
      conversationId: firstConversationId,
      state: "archived",
    });

    const selectArchived = await app.request(
      `/api/scheduled-tasks/task-conversations/conversations/${firstConversationId}`,
      {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ clientSessionId }),
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

  it("gives admins full read access to every transcript of a foreign task", async () => {
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
    // The admin can navigate the foreign task (task access re-granted) and the
    // transcript list is now task-scoped: every association is visible with
    // the transcript user's name.
    const adminList = await app.request("/api/scheduled-tasks/foreign-task/conversations", {
      headers: { Cookie: adminCookie },
    });
    expect(adminList.status).toBe(200);
    await expect(adminList.json()).resolves.toEqual({
      taskId: "foreign-task",
      conversations: [expect.objectContaining({ conversationId: "owner-private-chat", transcriptUserName: "Owner" })],
      builderLock: { state: "available", conversationId: null, owner: null, expiresAt: null, generation: null },
      transcriptAccess: "admin",
    });

    // The admin can open the owner's transcript read-only.
    const adminDetail = await app.request("/api/scheduled-tasks/foreign-task/conversations/owner-private-chat", {
      headers: { Cookie: adminCookie },
    });
    expect(adminDetail.status).toBe(200);
    await expect(adminDetail.json()).resolves.toMatchObject({
      conversation: { conversationId: "owner-private-chat", transcriptUserName: "Owner" },
    });

    // Admin reads stay read-only: selecting or archiving someone else's
    // transcript is still refused by the viewer-scoped mutation paths.
    const adminSelect = await app.request("/api/scheduled-tasks/foreign-task/conversations/owner-private-chat", {
      method: "PUT",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(adminSelect.status).toBe(404);
    const adminArchive = await app.request("/api/scheduled-tasks/foreign-task/conversations/owner-private-chat", {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(adminArchive.status).toBe(404);

    const memberResponse = await app.request("/api/scheduled-tasks/foreign-task/conversations", {
      headers: { Cookie: await memberCookie(db, member.id) },
    });
    expect(memberResponse.status).toBe(404);

    const ownerList = await app.request("/api/scheduled-tasks/foreign-task/conversations", {
      headers: { Cookie: await memberCookie(db, owner.id) },
    });
    expect(ownerList.status).toBe(200);
    await expect(ownerList.json()).resolves.toMatchObject({ transcriptAccess: "owner" });
    expect(admin.id).not.toBe(owner.id);
  });

  it("shows every transcript to the owner with names and keeps member access viewer-scoped", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-all-transcripts@test.com" });
    const member = await createUserRepository(db).create({ name: "Maya", email: "maya-all-transcripts@test.com" });
    await seedTask(db, "all-transcripts-task", owner.id);
    await createAutomationTaskConversationService(db).associate({
      taskId: "all-transcripts-task",
      conversationId: "owner-chat",
      transcriptUserId: owner.id,
      kind: "builder",
    });
    await createAutomationTaskConversationService(db).associate({
      taskId: "all-transcripts-task",
      conversationId: "maya-chat",
      transcriptUserId: member.id,
      kind: "builder",
    });
    await createAutomationSharesRepository(db).grant({
      taskId: "all-transcripts-task",
      userId: member.id,
      grantedByUserId: owner.id,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const ownerCookie = await memberCookie(db, owner.id);
    const memberCookieValue = await memberCookie(db, member.id);

    // The owner sees every builder chat with the member's name.
    const ownerList = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations", {
      headers: { Cookie: ownerCookie },
    });
    expect(ownerList.status).toBe(200);
    await expect(ownerList.json()).resolves.toMatchObject({
      transcriptAccess: "owner",
      conversations: expect.arrayContaining([
        expect.objectContaining({ conversationId: "owner-chat", transcriptUserName: "Owner" }),
        expect.objectContaining({ conversationId: "maya-chat", transcriptUserName: "Maya" }),
      ]),
    });

    // The owner can open the member's transcript read-only.
    const ownerReadMember = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/maya-chat", {
      headers: { Cookie: ownerCookie },
    });
    expect(ownerReadMember.status).toBe(200);
    await expect(ownerReadMember.json()).resolves.toMatchObject({
      conversation: { conversationId: "maya-chat", transcriptUserName: "Maya" },
    });

    // The admin sees the same full list for an automation they neither own nor
    // were granted.
    const adminCookie = await loginAdmin(app);
    const adminList = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations", {
      headers: { Cookie: adminCookie },
    });
    expect(adminList.status).toBe(200);
    await expect(adminList.json()).resolves.toMatchObject({
      transcriptAccess: "admin",
      conversations: expect.arrayContaining([
        expect.objectContaining({ conversationId: "owner-chat", transcriptUserName: "Owner" }),
        expect.objectContaining({ conversationId: "maya-chat", transcriptUserName: "Maya" }),
      ]),
    });
    const adminRead = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/maya-chat", {
      headers: { Cookie: adminCookie },
    });
    expect(adminRead.status).toBe(200);

    // The granted member still sees only their own transcript.
    const memberList = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations", {
      headers: { Cookie: memberCookieValue },
    });
    expect(memberList.status).toBe(200);
    await expect(memberList.json()).resolves.toMatchObject({
      transcriptAccess: "viewer",
      conversations: [expect.objectContaining({ conversationId: "maya-chat" })],
    });
    const memberReadOwner = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/owner-chat", {
      headers: { Cookie: memberCookieValue },
    });
    expect(memberReadOwner.status).toBe(404);

    // Member mutations stay viewer-scoped: the owner's transcript is not a
    // valid target even though the member can read the task.
    const memberSelectOwner = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/owner-chat", {
      method: "PUT",
      headers: { Cookie: memberCookieValue, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(memberSelectOwner.status).toBe(404);
    const memberArchiveOwner = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/owner-chat", {
      method: "PATCH",
      headers: { Cookie: memberCookieValue, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(memberArchiveOwner.status).toBe(404);

    // Owner reads are read-only too: the owner cannot select or archive the
    // member's transcript through the viewer-scoped mutation paths.
    const ownerSelectMember = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/maya-chat", {
      method: "PUT",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(ownerSelectMember.status).toBe(404);
    const ownerArchiveMember = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/maya-chat", {
      method: "PATCH",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(ownerArchiveMember.status).toBe(404);

    // The member can still select and archive their own transcript.
    const memberArchiveOwn = await app.request("/api/scheduled-tasks/all-transcripts-task/conversations/maya-chat", {
      method: "PATCH",
      headers: { Cookie: memberCookieValue, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(memberArchiveOwn.status).toBe(200);

    // The owner's broad list includes the member's archived chat with its name.
    const ownerHistorical = await app.request(
      "/api/scheduled-tasks/all-transcripts-task/conversations?includeArchived=true",
      { headers: { Cookie: ownerCookie } },
    );
    expect(ownerHistorical.status).toBe(200);
    await expect(ownerHistorical.json()).resolves.toMatchObject({
      conversations: expect.arrayContaining([
        expect.objectContaining({ conversationId: "maya-chat", state: "archived", transcriptUserName: "Maya" }),
      ]),
    });
  });

  it("opens task conversations to an explicit grantee", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-grantee-conv@test.com" });
    const member = await createUserRepository(db).create({ name: "Member", email: "member-grantee-conv@test.com" });
    await seedTask(db, "granted-task", owner.id);
    await createAutomationSharesRepository(db).grant({
      taskId: "granted-task",
      userId: member.id,
      grantedByUserId: owner.id,
    });
    await createAutomationTaskConversationService(db).associate({
      taskId: "granted-task",
      conversationId: "shared-builder-chat",
      transcriptUserId: member.id,
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
    const memberCookieValue = await memberCookie(db, member.id);

    const listRes = await app.request("/api/scheduled-tasks/granted-task/conversations", {
      headers: { Cookie: memberCookieValue },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.conversations).toEqual([
      expect.objectContaining({ conversationId: "shared-builder-chat", state: "active" }),
    ]);

    const detailRes = await app.request("/api/scheduled-tasks/granted-task/conversations/shared-builder-chat", {
      headers: { Cookie: memberCookieValue },
    });
    expect(detailRes.status).toBe(200);
    await expect(detailRes.json()).resolves.toMatchObject({
      conversation: { conversationId: "shared-builder-chat" },
    });
  });

  it("lets an explicit grantee create a builder conversation", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-create-grantee@test.com" });
    const member = await createUserRepository(db).create({ name: "Member", email: "member-create-grantee@test.com" });
    await seedTask(db, "granted-create-task", owner.id);
    await createAutomationSharesRepository(db).grant({
      taskId: "granted-create-task",
      userId: member.id,
      grantedByUserId: owner.id,
    });

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const response = await app.request("/api/scheduled-tasks/granted-create-task/conversations", {
      method: "POST",
      headers: { Cookie: await memberCookie(db, member.id), "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true, clientSessionId: "tab-grantee" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation.conversationId).toMatch(/^builder-/);
    await expect(
      db
        .selectFrom("scheduled_task_conversations")
        .select(["transcript_user_id", "kind"])
        .where("task_id", "=", "granted-create-task")
        .execute(),
    ).resolves.toEqual([{ transcript_user_id: member.id, kind: "builder" }]);
  });

  it("keeps the builder-chat lock discipline for admins on a foreign task", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-builder-lock@test.com" });
    await seedTask(db, "locked-task", owner.id);

    const app = createApp(db, config, {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    const ownerCookie = await memberCookie(db, owner.id);
    const ownerStart = await app.request("/api/scheduled-tasks/locked-task/conversations", {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true, clientSessionId: "tab-owner" }),
    });
    expect(ownerStart.status).toBe(201);

    const adminCookie = await loginAdmin(app);
    const adminStart = await app.request("/api/scheduled-tasks/locked-task/conversations", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true, clientSessionId: "tab-admin" }),
    });
    // The admin passes the task access gate but the builder-chat lock is held
    // by the owner, so the create is refused — lock discipline is uniform.
    expect(adminStart.status).toBe(409);
    await expect(adminStart.json()).resolves.toMatchObject({ error: { code: "BUILDER_CHAT_LOCKED" } });

    const ownerSecond = await app.request("/api/scheduled-tasks/locked-task/conversations", {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ createNew: true, clientSessionId: "tab-owner" }),
    });
    expect(ownerSecond.status).toBe(409);
    await expect(ownerSecond.json()).resolves.toMatchObject({
      error: { code: "BUILDER_CHAT_LOCKED" },
    });
    await expect(
      db.selectFrom("scheduled_task_conversations").selectAll().where("task_id", "=", "locked-task").execute(),
    ).resolves.toEqual([expect.objectContaining({ transcript_user_id: owner.id, kind: "builder" })]);
  });

  it("selects a builder with one session and conflicts for another session of the same user", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({
      name: "Owner",
      email: "owner-session-select@test.com",
    });
    await seedTask(db, "session-select-task", owner.id);
    await createAutomationTaskConversationService(db).associate({
      taskId: "session-select-task",
      conversationId: "session-builder",
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
    const cookie = await memberCookie(db, owner.id);
    const first = await app.request("/api/scheduled-tasks/session-select-task/conversations/session-builder", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientSessionId: "tab-a", generation: 1 }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.builderLock).toMatchObject({ state: "held", owner: "self", generation: 1 });

    const sameSession = await app.request("/api/scheduled-tasks/session-select-task/conversations/session-builder", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientSessionId: "tab-a", generation: firstBody.builderLock.generation }),
    });
    expect(sameSession.status).toBe(200);

    const second = await app.request("/api/scheduled-tasks/session-select-task/conversations/session-builder", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientSessionId: "tab-b" }),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "BUILDER_CHAT_LOCKED", builderLock: { owner: "other", generation: 1 } },
    });
    await expect(
      db
        .selectFrom("automation_task_locks")
        .select(["holder_user_id", "holder_session_id", "generation"])
        .where("task_id", "=", "session-select-task")
        .executeTakeFirst(),
    ).resolves.toEqual({ holder_user_id: owner.id, holder_session_id: "tab-a", generation: 1 });
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
      body: JSON.stringify({ conversationId: "guessed-builder", createNew: true, clientSessionId: "tab-safe" }),
    });
    expect(postGuessed.status).toBe(404);
    await expect(postGuessed.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_NOT_FOUND" },
    });

    await expect(
      db.selectFrom("scheduled_task_conversations").selectAll().where("task_id", "=", "safe-task").execute(),
    ).resolves.toEqual([]);
  });

  async function writeTranscript(
    dataDir: string,
    userId: string,
    conversationId: string,
    messages: unknown[],
  ): Promise<void> {
    const transcriptDir = join(dataDir, "web-chat", userId);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, `${conversationId}.json`),
      `${JSON.stringify({ version: 1, messages }, null, 2)}\n`,
    );
  }

  it("serves task-scoped transcript messages to the owner and admin while keeping members viewer-scoped", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-messages@test.com" });
    const member = await createUserRepository(db).create({ name: "Maya", email: "maya-messages@test.com" });
    await seedTask(db, "messages-task", owner.id);
    await createAutomationTaskConversationService(db).associate({
      taskId: "messages-task",
      conversationId: "owner-chat",
      transcriptUserId: owner.id,
      kind: "builder",
    });
    await createAutomationSharesRepository(db).grant({
      taskId: "messages-task",
      userId: member.id,
      grantedByUserId: owner.id,
    });

    const dataDir = await mkdtemp(join(tmpdir(), "sketch-conv-messages-"));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    await writeTranscript(dataDir, owner.id, "owner-chat", [
      {
        id: "msg-1",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ type: "text", text: "Build the account brief" }],
      },
      {
        id: "msg-2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:01.000Z",
        parts: [{ type: "text", text: "Brief is ready." }],
      },
    ]);

    // The owner reads the transcript of their own conversation.
    const ownerRes = await app.request("/api/scheduled-tasks/messages-task/conversations/owner-chat/messages", {
      headers: { Cookie: await memberCookie(db, owner.id) },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = await ownerRes.json();
    expect(ownerBody.messages).toEqual([
      expect.objectContaining({ id: "msg-1", role: "user" }),
      expect.objectContaining({ id: "msg-2", role: "assistant" }),
    ]);
    expect(typeof ownerBody.updatedAt).toBe("string");

    // The admin reads the owner's transcript content.
    const adminRes = await app.request("/api/scheduled-tasks/messages-task/conversations/owner-chat/messages", {
      headers: { Cookie: await loginAdmin(app) },
    });
    expect(adminRes.status).toBe(200);
    await expect(adminRes.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "msg-1" }), expect.objectContaining({ id: "msg-2" })],
    });

    // A granted member cannot read the owner's transcript content (viewer scope).
    const memberRes = await app.request("/api/scheduled-tasks/messages-task/conversations/owner-chat/messages", {
      headers: { Cookie: await memberCookie(db, member.id) },
    });
    expect(memberRes.status).toBe(404);
    await expect(memberRes.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_NOT_FOUND" },
    });
  });

  it("serves a member's own conversation transcript but never another member's", async () => {
    await seedAdmin(db);
    const owner = await createUserRepository(db).create({ name: "Owner", email: "owner-scope@test.com" });
    const maya = await createUserRepository(db).create({ name: "Maya", email: "maya-scope@test.com" });
    const nora = await createUserRepository(db).create({ name: "Nora", email: "nora-scope@test.com" });
    await seedTask(db, "scope-task", owner.id);
    await createAutomationTaskConversationService(db).associate({
      taskId: "scope-task",
      conversationId: "maya-chat",
      transcriptUserId: maya.id,
      kind: "builder",
    });
    await createAutomationTaskConversationService(db).associate({
      taskId: "scope-task",
      conversationId: "nora-chat",
      transcriptUserId: nora.id,
      kind: "builder",
    });
    for (const member of [maya, nora]) {
      await createAutomationSharesRepository(db).grant({
        taskId: "scope-task",
        userId: member.id,
        grantedByUserId: owner.id,
      });
    }

    const dataDir = await mkdtemp(join(tmpdir(), "sketch-conv-scope-"));
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      scheduler: {
        pauseTask: vi.fn(),
        resumeTask: vi.fn(),
        removeTask: vi.fn(),
        executeTaskById: vi.fn(),
      },
    });
    await writeTranscript(dataDir, maya.id, "maya-chat", [
      { id: "m-1", role: "user", parts: [{ type: "text", text: "Maya's message" }] },
    ]);

    const mayaRes = await app.request("/api/scheduled-tasks/scope-task/conversations/maya-chat/messages", {
      headers: { Cookie: await memberCookie(db, maya.id) },
    });
    expect(mayaRes.status).toBe(200);
    await expect(mayaRes.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "m-1", role: "user" })],
    });

    const noraRes = await app.request("/api/scheduled-tasks/scope-task/conversations/maya-chat/messages", {
      headers: { Cookie: await memberCookie(db, nora.id) },
    });
    expect(noraRes.status).toBe(404);

    // The owner still sees the member's transcript content.
    const ownerRes = await app.request("/api/scheduled-tasks/scope-task/conversations/maya-chat/messages", {
      headers: { Cookie: await memberCookie(db, owner.id) },
    });
    expect(ownerRes.status).toBe(200);
    await expect(ownerRes.json()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "m-1" })],
    });
  });
});
