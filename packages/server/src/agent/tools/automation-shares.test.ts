/**
 * Tool tests for ManageAutomationShares: owner-only grant/revoke/list with
 * email and name-substring user resolution, admin and grantee denial, and
 * user-facing errors for unknown or ambiguous users.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationDefinition } from "../../automation/persistence";
import { createAutomationSharesRepository } from "../../db/repositories/automation-shares";
import { createUserRepository } from "../../db/repositories/users";
import type { TaskScheduler } from "../../scheduler/service";
import { createTestDb } from "../../test-utils";
import { handleManageAutomationShares } from "./automation-shares";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function definition() {
  return {
    title: "Daily account brief",
    description: "Summarize account activity.",
    prompt: "Summarize account activity.",
    executionMode: "hybrid" as const,
    scheduleType: "interval" as const,
    scheduleValue: "120",
    timezone: "UTC",
    status: "active" as const,
    delivery: {
      platform: "slack" as const,
      targetType: "dm" as const,
      targetId: "D123",
      threadTs: null,
      mode: "deliver" as const,
    },
    steps: [
      {
        id: "trigger",
        type: "trigger" as const,
        label: "Every two minutes",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: {
          type: "schedule" as const,
          scheduleType: "interval" as const,
          scheduleValue: "120",
          timezone: "UTC",
        },
      },
      {
        id: "agent",
        type: "agent" as const,
        label: "Summarize activity",
        icon: "sketch-ai",
        position: { x: 260, y: 0 },
        agentMode: "sketch" as const,
      },
    ],
    edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
    stepContent: {
      agent: {
        taskId: "client-task-id",
        stepId: "agent",
        contentType: "prompt" as const,
        content: "Check activity and summarize changes.",
        apps: null,
      },
    },
  };
}

function context(taskId: string, createdBy = "owner-1") {
  return {
    id: taskId,
    platform: "slack" as const,
    contextType: "dm" as const,
    deliveryTarget: "D123",
    threadTs: null,
    createdBy,
    originPlatform: "web" as const,
    originConversationId: "conversation-1",
    originProviderThreadId: null,
    originMessageId: 12,
  };
}

/** TaskContext for tool calls: threadTs is optional there, not nullable. */
function taskContextFor(taskId: string, createdBy = "owner-1") {
  const ctx = context(taskId, createdBy);
  return { ...ctx, threadTs: undefined };
}

function schedulerFor(taskId: string, createdBy = "owner-1") {
  const task = {
    id: taskId,
    platform: "slack",
    contextType: "dm",
    deliveryTarget: "D123",
    threadTs: null,
    prompt: "Summarize account activity.",
    scheduleType: "interval",
    scheduleValue: "120",
    timezone: "UTC",
    sessionMode: "fresh",
    nextRunAt: null,
    lastRunAt: null,
    status: "active",
    createdBy,
    createdAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    title: "Daily account brief",
    description: "Summarize account activity.",
    originChat: null,
    steps: null,
    edges: null,
    outputTarget: "D123",
    outputPlatform: "slack",
    outputThreadTs: null,
    outputMode: "deliver",
    delivery: { platform: "slack", targetType: "dm", targetId: "D123", threadTs: null, mode: "deliver" },
  };
  return {
    getTaskById: vi.fn().mockImplementation(async (id: string) => (id === "no-such-task" ? null : task)),
  } as unknown as TaskScheduler;
}

describe("ManageAutomationShares", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    for (const user of [
      { id: "owner-1", name: "Owner Person", email: "owner@sketch.test" },
      { id: "admin-1", name: "Admin Person", email: "admin@sketch.test" },
      { id: "member-1", name: "Member Person", email: "member@sketch.test" },
      { id: "member-2", name: "Member Two", email: "two@sketch.test" },
    ]) {
      await db.insertInto("users").values(user).execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function createTask(taskId: string) {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context(taskId),
      brokerCapable: true,
      encryptionKey: ENCRYPTION_KEY,
    });
  }

  const userRepo = () => createUserRepository(db);

  it("grants an automation to a user resolved by email", async () => {
    await createTask("share-grant-email");

    const result = await handleManageAutomationShares(
      { action: "grant", task_id: "share-grant-email", user: "member@sketch.test" },
      {
        db,
        scheduler: schedulerFor("share-grant-email"),
        taskContext: taskContextFor("share-grant-email", "owner-1"),
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe('Shared automation "Daily account brief" with Member Person.');
    await expect(createAutomationSharesRepository(db).hasGrant("share-grant-email", "member-1")).resolves.toBe(true);
  });

  it("grants an automation to a user resolved by name substring", async () => {
    await createTask("share-grant-name");

    const result = await handleManageAutomationShares(
      { action: "grant", task_id: "share-grant-name", user: "Member Per" },
      {
        db,
        scheduler: schedulerFor("share-grant-name"),
        taskContext: taskContextFor("share-grant-name", "owner-1"),
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe('Shared automation "Daily account brief" with Member Person.');
    await expect(createAutomationSharesRepository(db).hasGrant("share-grant-name", "member-1")).resolves.toBe(true);
  });

  it("revokes an automation from a user", async () => {
    await createTask("share-revoke");
    await createAutomationSharesRepository(db).grant({
      taskId: "share-revoke",
      userId: "member-1",
      grantedByUserId: "owner-1",
    });

    const result = await handleManageAutomationShares(
      { action: "revoke", task_id: "share-revoke", user: "Member Person" },
      {
        db,
        scheduler: schedulerFor("share-revoke"),
        taskContext: taskContextFor("share-revoke", "owner-1"),
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe('Removed Member Person\'s access to automation "Daily account brief".');
    await expect(createAutomationSharesRepository(db).hasGrant("share-revoke", "member-1")).resolves.toBe(false);
  });

  it("reports a no-op revoke for a user without access", async () => {
    await createTask("share-revoke-missing");

    const result = await handleManageAutomationShares(
      { action: "revoke", task_id: "share-revoke-missing", user: "Member Person" },
      {
        db,
        scheduler: schedulerFor("share-revoke-missing"),
        taskContext: taskContextFor("share-revoke-missing", "owner-1"),
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe(
      'Error: Member Person does not have access to automation "Daily account brief".',
    );
  });

  it("lists the users an automation is shared with, resolving display names", async () => {
    await createTask("share-list");
    await createAutomationSharesRepository(db).grant({
      taskId: "share-list",
      userId: "member-1",
      grantedByUserId: "owner-1",
    });
    await createAutomationSharesRepository(db).grant({
      taskId: "share-list",
      userId: "member-2",
      grantedByUserId: "owner-1",
    });

    const result = await handleManageAutomationShares(
      { action: "list", task_id: "share-list" },
      {
        db,
        scheduler: schedulerFor("share-list"),
        taskContext: taskContextFor("share-list", "owner-1"),
        userRepo: userRepo(),
      },
    );

    const listed = JSON.parse(result.content[0].text);
    expect(listed).toEqual([
      expect.objectContaining({ user_id: "member-1", name: "Member Person", granted_by_user_id: "owner-1" }),
      expect.objectContaining({ user_id: "member-2", name: "Member Two", granted_by_user_id: "owner-1" }),
    ]);
  });

  it("lists no shares for an automation that was never shared", async () => {
    await createTask("share-list-empty");

    const result = await handleManageAutomationShares(
      { action: "list", task_id: "share-list-empty" },
      {
        db,
        scheduler: schedulerFor("share-list-empty"),
        taskContext: taskContextFor("share-list-empty", "owner-1"),
        userRepo: userRepo(),
      },
    );

    expect(JSON.parse(result.content[0].text)).toEqual([]);
  });

  it("denies every action to a non-owner member with an owner-only message", async () => {
    await createTask("share-member-denied");

    const grant = await handleManageAutomationShares(
      { action: "grant", task_id: "share-member-denied", user: "member-2" },
      {
        db,
        scheduler: schedulerFor("share-member-denied"),
        taskContext: taskContextFor("share-member-denied", "member-1"),
        userRepo: userRepo(),
      },
    );
    expect(grant.content[0].text).toBe('Error: Only the owner can change sharing for "Daily account brief".');

    const revoke = await handleManageAutomationShares(
      { action: "revoke", task_id: "share-member-denied", user: "member-2" },
      {
        db,
        scheduler: schedulerFor("share-member-denied"),
        taskContext: taskContextFor("share-member-denied", "member-1"),
        userRepo: userRepo(),
      },
    );
    expect(revoke.content[0].text).toBe('Error: Only the owner can change sharing for "Daily account brief".');

    const list = await handleManageAutomationShares(
      { action: "list", task_id: "share-member-denied" },
      {
        db,
        scheduler: schedulerFor("share-member-denied"),
        taskContext: taskContextFor("share-member-denied", "member-1"),
        userRepo: userRepo(),
      },
    );
    expect(list.content[0].text).toBe('Error: Only the owner can change sharing for "Daily account brief".');
  });

  it("denies every action to an admin who is not the owner (no admin bypass)", async () => {
    await createTask("share-admin-denied");

    const result = await handleManageAutomationShares(
      { action: "grant", task_id: "share-admin-denied", user: "member-2" },
      {
        db,
        scheduler: schedulerFor("share-admin-denied"),
        taskContext: { ...taskContextFor("share-admin-denied", "admin-1"), canManageAnyTask: true },
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe('Error: Only the owner can change sharing for "Daily account brief".');
    await expect(createAutomationSharesRepository(db).hasGrant("share-admin-denied", "member-2")).resolves.toBe(false);
  });

  it("excludes admin users from grant/revoke resolution targets", async () => {
    await createTask("share-admin-excluded");
    await db
      .insertInto("users")
      .values({ id: "admin-2", name: "Admin Two", email: "admin-two@sketch.test", auth_role: "admin" })
      .execute();

    const byEmail = await handleManageAutomationShares(
      { action: "grant", task_id: "share-admin-excluded", user: "admin-two@sketch.test" },
      {
        db,
        scheduler: schedulerFor("share-admin-excluded"),
        taskContext: taskContextFor("share-admin-excluded", "owner-1"),
        userRepo: userRepo(),
      },
    );
    expect(byEmail.content[0].text).toBe('Error: No user matches "admin-two@sketch.test".');

    const byName = await handleManageAutomationShares(
      { action: "revoke", task_id: "share-admin-excluded", user: "Admin Two" },
      {
        db,
        scheduler: schedulerFor("share-admin-excluded"),
        taskContext: taskContextFor("share-admin-excluded", "owner-1"),
        userRepo: userRepo(),
      },
    );
    expect(byName.content[0].text).toBe('Error: No user matches "Admin Two".');

    await expect(createAutomationSharesRepository(db).hasGrant("share-admin-excluded", "admin-2")).resolves.toBe(false);
  });

  it("denies a granted member further grant/revoke control (no grant bypass)", async () => {
    await createTask("share-grantee-denied");
    await createAutomationSharesRepository(db).grant({
      taskId: "share-grantee-denied",
      userId: "member-1",
      grantedByUserId: "owner-1",
    });

    const result = await handleManageAutomationShares(
      { action: "grant", task_id: "share-grantee-denied", user: "member-2" },
      {
        db,
        scheduler: schedulerFor("share-grantee-denied"),
        taskContext: taskContextFor("share-grantee-denied", "member-1"),
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe('Error: Only the owner can change sharing for "Daily account brief".');
    await expect(createAutomationSharesRepository(db).hasGrant("share-grantee-denied", "member-2")).resolves.toBe(
      false,
    );
  });

  it("rejects unknown users and ambiguous name matches with user-facing errors", async () => {
    await createTask("share-unknown");

    const unknown = await handleManageAutomationShares(
      { action: "grant", task_id: "share-unknown", user: "nobody@sketch.test" },
      {
        db,
        scheduler: schedulerFor("share-unknown"),
        taskContext: taskContextFor("share-unknown", "owner-1"),
        userRepo: userRepo(),
      },
    );
    expect(unknown.content[0].text).toBe('Error: No user matches "nobody@sketch.test".');

    await db
      .insertInto("users")
      .values({ id: "member-3", name: "Member Person Two", email: "three@sketch.test" })
      .execute();
    const ambiguous = await handleManageAutomationShares(
      { action: "grant", task_id: "share-unknown", user: "Member Person" },
      {
        db,
        scheduler: schedulerFor("share-unknown"),
        taskContext: taskContextFor("share-unknown", "owner-1"),
        userRepo: userRepo(),
      },
    );
    expect(ambiguous.content[0].text).toContain("matches multiple users");
    expect(ambiguous.content[0].text).toContain("Use their full email instead.");
  });

  it("rejects a missing user reference and a missing task id", async () => {
    await createTask("share-missing-user");

    const noUser = await handleManageAutomationShares(
      { action: "grant", task_id: "share-missing-user" },
      {
        db,
        scheduler: schedulerFor("share-missing-user"),
        taskContext: taskContextFor("share-missing-user", "owner-1"),
        userRepo: userRepo(),
      },
    );
    expect(noUser.content[0].text).toBe("Error: user is required for grant and revoke actions.");

    const noTask = await handleManageAutomationShares(
      { action: "grant", user: "member-1" },
      {
        db,
        scheduler: schedulerFor("share-missing-user"),
        taskContext: taskContextFor("share-missing-user", "owner-1"),
        userRepo: userRepo(),
      },
    );
    expect(noTask.content[0].text).toBe("Error: task_id is required for this action.");
  });

  it("reports a missing task as not found", async () => {
    const result = await handleManageAutomationShares(
      { action: "list", task_id: "no-such-task" },
      {
        db,
        scheduler: schedulerFor("no-such-task"),
        taskContext: taskContextFor("no-such-task", "owner-1"),
        userRepo: userRepo(),
      },
    );

    expect(result.content[0].text).toBe("Error: task not found.");
  });
});
