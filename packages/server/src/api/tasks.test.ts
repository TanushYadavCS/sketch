import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createTaskRepository } from "../db/repositories/tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const PASSWORD = "testpassword123";
const ADMIN_EMAIL = "admin-tasks@test.com";
const MEMBER_EMAIL = "member-tasks@test.com";
const OTHER_EMAIL = "other-tasks@test.com";

describe("GET/PATCH /api/tasks/:taskId", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminId: string;
  let memberId: string;
  let otherId: string;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    const settings = createSettingsRepository(db);
    const users = createUserRepository(db);
    await settings.create();
    const passwordHash = await hashPassword(PASSWORD);
    await users.create({
      name: "Admin",
      email: ADMIN_EMAIL,
      emailVerified: true,
      passwordHash,
      authRole: "admin",
    });
    await users.create({
      name: "Member",
      email: MEMBER_EMAIL,
      emailVerified: true,
      passwordHash,
      authRole: "member",
    });
    await users.create({
      name: "Other",
      email: OTHER_EMAIL,
      emailVerified: true,
      passwordHash,
      authRole: "member",
    });
    await settings.update({ onboardingCompletedAt: new Date().toISOString() });
    adminId = (await users.findByEmail(ADMIN_EMAIL))?.id ?? "";
    memberId = (await users.findByEmail(MEMBER_EMAIL))?.id ?? "";
    otherId = (await users.findByEmail(OTHER_EMAIL))?.id ?? "";
    await seedPerson(db, "person-member", "Member", MEMBER_EMAIL);
    app = createApp(db, createTestConfig(), { logger: createTestLogger() });
    adminCookie = await login(app, ADMIN_EMAIL);
    memberCookie = await login(app, MEMBER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("gets and updates a creator-owned null-parent local task", async () => {
    const task = await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Ownerless task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "ownerless-task",
      createdByUserId: memberId,
    });

    const get = await app.request(`/api/tasks/${task.taskId}`, { headers: { Cookie: memberCookie } });
    const patch = await app.request(`/api/tasks/${task.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const retry = await app.request(`/api/tasks/${task.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      task: {
        id: task.taskId,
        parentEntityId: null,
        status: "open",
        isOwnedByViewer: true,
        canEditStatus: true,
        readonlyReason: null,
      },
    });
    expect(patch.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      task: { id: task.taskId, status: "done", statusRaw: "done", canEditStatus: true },
    });
    await expect(
      db
        .selectFrom("task_activity_events")
        .select(["task_id", "event_kind", "actor_type", "actor_user_id", "surface", "changes_json"])
        .where("task_id", "=", task.taskId)
        .execute(),
    ).resolves.toEqual([
      {
        task_id: task.taskId,
        event_kind: "status_changed",
        actor_type: "user",
        actor_user_id: memberId,
        surface: "web",
        changes_json: JSON.stringify({ status: { before: "open", after: "done" } }),
      },
    ]);
  });

  it("lets an assignee and admin update local tasks while hiding them from unrelated members", async () => {
    const repo = createTaskRepository(db);
    const assigned = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Assigned task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: "person-member",
      assigneeName: "Member",
      priority: "high",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "assigned-task",
      createdByUserId: adminId,
    });
    const privateTask = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Other private task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "other-private-task",
      createdByUserId: otherId,
    });

    const assigneeGet = await app.request(`/api/tasks/${assigned.taskId}`, { headers: { Cookie: memberCookie } });
    const assigneePatch = await app.request(`/api/tasks/${assigned.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    const hiddenGet = await app.request(`/api/tasks/${privateTask.taskId}`, { headers: { Cookie: memberCookie } });
    const hiddenPatch = await app.request(`/api/tasks/${privateTask.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const adminPatch = await app.request(`/api/tasks/${privateTask.taskId}`, {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(assigneeGet.status).toBe(200);
    await expect(assigneeGet.json()).resolves.toMatchObject({
      task: { id: assigned.taskId, isOwnedByViewer: false, canEditStatus: true },
    });
    expect(assigneePatch.status).toBe(200);
    expect(hiddenGet.status).toBe(404);
    expect(hiddenPatch.status).toBe(404);
    expect(adminPatch.status).toBe(200);
  });

  it("returns visible structural tasks as read-only", async () => {
    await seedVisibleTaskFile(db, adminId);
    const repo = createTaskRepository(db);
    const structural = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "linear",
      externalRef: "LIN-1",
      title: "External task",
      status: "in_progress",
      statusRaw: "In Review",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "linear-task",
    });
    await repo.upsertEvidence(structural.taskId, "file", "task-file");

    const get = await app.request(`/api/tasks/${structural.taskId}`, { headers: { Cookie: memberCookie } });
    const patch = await app.request(`/api/tasks/${structural.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      task: {
        id: structural.taskId,
        statusRaw: "In Review",
        statusAuthority: "external",
        canEditStatus: false,
        readonlyReason: "external_authority",
      },
    });
    expect(patch.status).toBe(403);
  });

  it("rejects invalid status and returns 404 for missing, expired, or invisible task ids", async () => {
    const repo = createTaskRepository(db);
    const expired = await repo.upsertTask({
      parentEntityId: null,
      parentSourceRef: null,
      parentName: null,
      source: "summary",
      externalRef: null,
      title: "Expired task",
      status: "open",
      statusRaw: "action_item",
      statusAuthority: "local",
      assigneeEntityId: null,
      assigneeName: null,
      priority: "medium",
      dueAt: null,
      provenance: "summary",
      sourceTaskId: "expired-task",
      createdByUserId: memberId,
    });
    await db
      .updateTable("tasks")
      .set({ valid_to: new Date().toISOString() })
      .where("id", "=", expired.taskId)
      .execute();

    const invalid = await app.request(`/api/tasks/${expired.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    const missing = await app.request("/api/tasks/missing", { headers: { Cookie: memberCookie } });
    const expiredGet = await app.request(`/api/tasks/${expired.taskId}`, { headers: { Cookie: memberCookie } });
    const expiredPatch = await app.request(`/api/tasks/${expired.taskId}`, {
      method: "PATCH",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(expiredGet.status).toBe(404);
    expect(expiredPatch.status).toBe(404);
  });
});

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return response.headers.get("set-cookie") ?? "";
}

async function seedPerson(db: Kysely<DB>, id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      aliases: JSON.stringify([email]),
      metadata: JSON.stringify({ email }),
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedVisibleTaskFile(db: Kysely<DB>, ownerId: string): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "task-connector",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ownerId,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "task-file",
      connector_config_id: "task-connector",
      provider_file_id: "task-file",
      file_name: "Task evidence",
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: "task-file-hash",
      share_with_everyone: 1,
      synced_at: new Date().toISOString(),
    })
    .execute();
}
