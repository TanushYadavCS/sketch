/**
 * Unit tests for steal-confirmation delivery (lock-confirmations.ts): WhatsApp
 * CONFIRM-STEAL / DENY-STEAL parsing, notification rendering, holder delivery
 * dispatch, and the shared approve/deny response flow with requester outcome
 * delivery.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockHolderFields } from "../db/repositories/automation-locks";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  type StealNotificationSenders,
  handleStealResponse,
  notifyStealRequested,
  parseWhatsAppStealCommand,
  renderStealOutcomeText,
  renderStealResponseConfirmation,
  renderWhatsAppStealRequest,
} from "./lock-confirmations";

const HOLDER_ALICE: LockHolderFields = { userId: "u1", platform: "slack", surface: "dm", conversationId: "C1" };
const REQUESTER_BOB: LockHolderFields = { userId: "u2", platform: "slack", surface: "dm", conversationId: "D2" };

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

async function seedUsers(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: "u1", name: "Alice" }).execute();
  await db.insertInto("users").values({ id: "u2", name: "Bob" }).execute();
}

async function seedTask(db: Kysely<DB>, taskId = "task-1", title = "Monthly Report"): Promise<void> {
  await db
    .insertInto("scheduled_tasks")
    .values({
      id: taskId,
      platform: "slack",
      context_type: "dm",
      delivery_target: "D1",
      prompt: "Send the report",
      schedule_type: "cron",
      schedule_value: "0 * * * *",
      status: "active",
      title,
    })
    .execute();
}

async function seedPendingSteal(
  db: Kysely<DB>,
  params: { taskId?: string; holder?: LockHolderFields; requester?: LockHolderFields } = {},
): Promise<void> {
  const locks = createAutomationLocksRepository(db);
  const now = futureIso(-10_000);
  await locks.insertIfAbsent(params.holder ?? HOLDER_ALICE, {
    taskId: params.taskId ?? "task-1",
    now,
    expiresAt: futureIso(10 * 60 * 1000),
  });
  await locks.requestSteal(params.requester ?? REQUESTER_BOB, {
    taskId: params.taskId ?? "task-1",
    stealRequestedAt: now,
    stealExpiresAt: futureIso(5 * 60 * 1000),
  });
}

function makeSenders(): StealNotificationSenders & {
  slack: { postLockStealRequest: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> };
  whatsapp: { sendText: ReturnType<typeof vi.fn> };
} {
  return {
    slack: {
      postLockStealRequest: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    },
    whatsapp: {
      sendText: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("parseWhatsAppStealCommand", () => {
  it.each([
    ["CONFIRM-STEAL task-1", "confirm", "task-1"],
    ["  confirm-steal  task-1  ", "confirm", "task-1"],
    ["Confirm-Steal task-1", "confirm", "task-1"],
    ["DENY-STEAL task-1", "deny", "task-1"],
    ["deny-steal 123e4567-e89b-12d3-a456-426614174000", "deny", "123e4567-e89b-12d3-a456-426614174000"],
  ])("parses %s as %s %s", (text, kind, taskId) => {
    expect(parseWhatsAppStealCommand(text)).toEqual({ kind, taskId });
  });

  it.each([
    ["", "empty text"],
    ["CONFIRM-STEAL", "missing task id"],
    ["DENY-STEAL", "missing task id"],
    ["CONFIRM-STEAL task-1 please", "trailing words"],
    ["APPROVE-STEAL task-1", "unknown verb"],
    ["confirm steal task-1", "missing hyphen"],
    ["CONFIRM-STEAL task id", "whitespace inside id"],
    ["I want to take over task-1", "plain sentence"],
  ])("treats %j as unrecognized (%s)", (text) => {
    expect(parseWhatsAppStealCommand(text)).toEqual({ kind: "unrecognized" });
  });
});

describe("steal notification rendering", () => {
  it("renders the holder-facing WhatsApp request with both reply codes", () => {
    expect(renderWhatsAppStealRequest({ requesterName: "Bob", taskTitle: "Monthly Report", taskId: "task-1" })).toBe(
      'Bob wants to take over editing "Monthly Report". Reply CONFIRM-STEAL task-1 to approve or DENY-STEAL task-1 to deny.',
    );
  });

  it("renders requester-facing outcomes for approve and deny", () => {
    expect(renderStealOutcomeText({ responderName: "Alice", taskTitle: "Monthly Report", approved: true })).toBe(
      'Alice approved your request to take over editing "Monthly Report". You can now edit it.',
    );
    expect(renderStealOutcomeText({ responderName: "Alice", taskTitle: "Monthly Report", approved: false })).toBe(
      'Alice denied your request to take over editing "Monthly Report".',
    );
  });

  it("renders responder-facing confirmations for every outcome kind", () => {
    expect(renderStealResponseConfirmation({ kind: "approved" })).toContain("approved");
    expect(renderStealResponseConfirmation({ kind: "denied" })).toContain("denied");
    expect(renderStealResponseConfirmation({ kind: "not_found" })).toContain("no longer exists");
    expect(renderStealResponseConfirmation({ kind: "not_holder" })).toContain("current editor");
    expect(renderStealResponseConfirmation({ kind: "no_pending_steal" })).toContain("no pending take-over");
  });
});

describe("notifyStealRequested", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    await seedTask(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("posts a block-kit steal request to a Slack holder's conversation", async () => {
    await seedPendingSteal(db);
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.slack.postLockStealRequest).toHaveBeenCalledWith({
      channelId: "C1",
      taskId: "task-1",
      requesterName: "Bob",
      taskTitle: "Monthly Report",
    });
    expect(senders.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it("sends the WhatsApp text code message to a WhatsApp holder's JID", async () => {
    await seedPendingSteal(db, {
      holder: { userId: "u1", platform: "whatsapp", surface: "dm", conversationId: "dm:+1234567890" },
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.whatsapp.sendText).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+1234567890" },
      renderWhatsAppStealRequest({ requesterName: "Bob", taskTitle: "Monthly Report", taskId: "task-1" }),
    );
    expect(senders.slack.postLockStealRequest).not.toHaveBeenCalled();
  });

  it("skips web-builder holders entirely", async () => {
    await seedPendingSteal(db, {
      holder: { userId: "u1", platform: "web", surface: "builder", conversationId: null },
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.slack.postLockStealRequest).not.toHaveBeenCalled();
    expect(senders.whatsapp.sendText).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs taskId and holder only when a Slack holder has no conversation id", async () => {
    await seedPendingSteal(db, {
      holder: { userId: "u1", platform: "slack", surface: "dm", conversationId: null },
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.slack.postLockStealRequest).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: "task-1", holderUserId: "u1" },
      "Cannot deliver steal request to Slack holder",
    );
  });

  it("logs and swallows Slack delivery failures", async () => {
    await seedPendingSteal(db);
    const senders = makeSenders();
    senders.slack.postLockStealRequest.mockRejectedValue(new Error("slack down"));
    const logger = { warn: vi.fn() };

    await expect(
      notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", holderUserId: "u1" }),
      "Slack steal request delivery failed",
    );
  });

  it("is a no-op without a pending steal", async () => {
    const locks = createAutomationLocksRepository(db);
    await locks.insertIfAbsent(HOLDER_ALICE, {
      taskId: "task-1",
      now: futureIso(-10_000),
      expiresAt: futureIso(10 * 60 * 1000),
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.slack.postLockStealRequest).not.toHaveBeenCalled();
    expect(senders.whatsapp.sendText).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is a no-op when the pending steal has expired", async () => {
    const locks = createAutomationLocksRepository(db);
    await locks.insertIfAbsent(HOLDER_ALICE, {
      taskId: "task-1",
      now: futureIso(-10 * 60 * 1000),
      expiresAt: futureIso(10 * 60 * 1000),
    });
    await locks.requestSteal(REQUESTER_BOB, {
      taskId: "task-1",
      stealRequestedAt: futureIso(-10 * 60 * 1000),
      stealExpiresAt: futureIso(-5 * 60 * 1000),
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.slack.postLockStealRequest).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns for an unknown holder platform", async () => {
    await seedPendingSteal(db, {
      holder: { userId: "u1", platform: "teams", surface: "dm", conversationId: "T1" },
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await notifyStealRequested({ db, logger: logger as never, taskId: "task-1", senders });

    expect(senders.slack.postLockStealRequest).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: "task-1", holderUserId: "u1", holderPlatform: "teams" },
      "Unknown holder platform for steal request delivery",
    );
  });
});

describe("handleStealResponse", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    await seedTask(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("approves the steal, flips the holder, and delivers the outcome to the requester", async () => {
    await seedPendingSteal(db);
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u1",
      responderName: "Alice",
      approve: true,
      senders,
    });

    expect(outcome).toEqual({ kind: "approved" });
    const row = await createAutomationLocksRepository(db).getByTaskId("task-1");
    expect(row?.holder_user_id).toBe("u2");
    expect(row?.holder_conversation_id).toBe("D2");
    expect(row?.steal_requester_user_id).toBeNull();
    expect(row?.steal_expires_at).toBeNull();
    expect(senders.slack.sendText).toHaveBeenCalledWith(
      "D2",
      'Alice approved your request to take over editing "Monthly Report". You can now edit it.',
    );
  });

  it("denies the steal, keeps the holder, clears the request, and notifies the requester", async () => {
    await seedPendingSteal(db);
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u1",
      responderName: "Alice",
      approve: false,
      senders,
    });

    expect(outcome).toEqual({ kind: "denied" });
    const row = await createAutomationLocksRepository(db).getByTaskId("task-1");
    expect(row?.holder_user_id).toBe("u1");
    expect(row?.steal_requester_user_id).toBeNull();
    expect(senders.slack.sendText).toHaveBeenCalledWith(
      "D2",
      'Alice denied your request to take over editing "Monthly Report".',
    );
  });

  it("delivers the outcome to a WhatsApp requester's JID", async () => {
    await seedPendingSteal(db, {
      requester: { userId: "u2", platform: "whatsapp", surface: "dm", conversationId: "dm:+919876543210" },
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u1",
      responderName: "Alice",
      approve: true,
      senders,
    });

    expect(senders.whatsapp.sendText).toHaveBeenCalledWith(
      { kind: "dm", phoneE164: "+919876543210" },
      'Alice approved your request to take over editing "Monthly Report". You can now edit it.',
    );
  });

  it("skips outcome delivery for web-builder requesters", async () => {
    await seedPendingSteal(db, {
      requester: { userId: "u2", platform: "web", surface: "builder", conversationId: null },
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u1",
      responderName: "Alice",
      approve: true,
      senders,
    });

    expect(outcome).toEqual({ kind: "approved" });
    expect(senders.slack.sendText).not.toHaveBeenCalled();
    expect(senders.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it("rejects a responder who is not the holder", async () => {
    await seedPendingSteal(db);
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u2",
      responderName: "Bob",
      approve: true,
      senders,
    });

    expect(outcome).toEqual({ kind: "not_holder" });
    const row = await createAutomationLocksRepository(db).getByTaskId("task-1");
    expect(row?.holder_user_id).toBe("u1");
    expect(row?.steal_requester_user_id).toBe("u2");
    expect(senders.slack.sendText).not.toHaveBeenCalled();
  });

  it("reports no_pending_steal without delivering anything", async () => {
    const locks = createAutomationLocksRepository(db);
    await locks.insertIfAbsent(HOLDER_ALICE, {
      taskId: "task-1",
      now: futureIso(-10_000),
      expiresAt: futureIso(10 * 60 * 1000),
    });
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u1",
      responderName: "Alice",
      approve: true,
      senders,
    });

    expect(outcome).toEqual({ kind: "no_pending_steal" });
    expect(senders.slack.sendText).not.toHaveBeenCalled();
  });

  it("reports not_found for a missing lock row", async () => {
    const senders = makeSenders();
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "missing",
      responderUserId: "u1",
      responderName: "Alice",
      approve: true,
      senders,
    });

    expect(outcome).toEqual({ kind: "not_found" });
    expect(senders.slack.sendText).not.toHaveBeenCalled();
  });

  it("logs and swallows requester outcome delivery failures", async () => {
    await seedPendingSteal(db);
    const senders = makeSenders();
    senders.slack.sendText.mockRejectedValue(new Error("slack down"));
    const logger = { warn: vi.fn() };

    const outcome = await handleStealResponse({
      db,
      logger: logger as never,
      taskId: "task-1",
      responderUserId: "u1",
      responderName: "Alice",
      approve: true,
      senders,
    });

    expect(outcome).toEqual({ kind: "approved" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", requesterUserId: "u2" }),
      "Slack steal outcome delivery failed",
    );
  });
});
