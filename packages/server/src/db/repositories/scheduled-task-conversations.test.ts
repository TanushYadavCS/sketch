import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutomationTaskConversationService } from "../../automation/task-conversations";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createScheduledTaskConversationRepository } from "./scheduled-task-conversations";

describe("scheduled task conversation repository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("supports many-to-many links, idempotent upserts, grouped kinds, and archival without deletion", async () => {
    const repo = createScheduledTaskConversationRepository(db);

    await repo.upsert({
      taskId: "task-a",
      conversationId: "shared-chat",
      transcriptUserId: "owner-a",
      kind: "builder",
    });
    await repo.upsert({
      taskId: "task-a",
      conversationId: "shared-chat",
      transcriptUserId: "owner-a",
      kind: "builder",
    });
    await repo.upsert({
      taskId: "task-a",
      conversationId: "shared-chat",
      transcriptUserId: "owner-a",
      kind: "web_chat",
    });
    await repo.upsert({
      taskId: "task-a",
      conversationId: "builder-chat",
      transcriptUserId: "owner-a",
      kind: "builder",
    });
    await repo.upsert({
      taskId: "task-b",
      conversationId: "shared-chat",
      transcriptUserId: "owner-a",
      kind: "web_chat",
    });

    const service = createAutomationTaskConversationService(db);
    await expect(service.listForTranscriptUser("task-a", "owner-a")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: "shared-chat",
          kinds: ["builder", "web_chat"],
          state: "active",
        }),
        expect.objectContaining({ conversationId: "builder-chat", kinds: ["builder"], state: "active" }),
      ]),
    );
    await expect(service.listForTranscriptUser("task-b", "owner-a")).resolves.toEqual([
      expect.objectContaining({ conversationId: "shared-chat", kinds: ["web_chat"] }),
    ]);

    await expect(service.archiveForTranscriptUser("task-a", "shared-chat", "owner-a", true)).resolves.toMatchObject({
      conversationId: "shared-chat",
      state: "archived",
      kinds: ["builder", "web_chat"],
    });
    await expect(service.listForTranscriptUser("task-a", "owner-a")).resolves.toEqual([
      expect.objectContaining({ conversationId: "builder-chat" }),
    ]);
    await expect(service.listForTranscriptUser("task-a", "owner-a", { includeArchived: true })).resolves.toEqual([
      expect.objectContaining({ conversationId: "builder-chat", state: "active" }),
      expect.objectContaining({ conversationId: "shared-chat", state: "archived" }),
    ]);

    await expect(
      db
        .selectFrom("scheduled_task_conversations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 4 });
  });

  it("reuses the active builder association and creates a new one after archival", async () => {
    await db
      .insertInto("scheduled_tasks")
      .values({
        id: "task-reuse",
        platform: "slack",
        context_type: "dm",
        delivery_target: "D-reuse",
        prompt: "Reuse this task",
        schedule_type: "cron",
        schedule_value: "0 9 * * *",
        created_by: "owner-reuse",
      })
      .execute();
    const service = createAutomationTaskConversationService(db);
    const first = await service.getOrCreateBuilderConversation("task-reuse", "owner-reuse");
    const reused = await service.getOrCreateBuilderConversation("task-reuse", "owner-reuse");

    if (first.kind !== "created" || reused.kind !== "active") throw new Error("Expected builder lock acquisition");
    expect(first.created).toBe(true);
    expect(reused.created).toBe(false);
    expect(reused.association.conversation_id).toBe(first.association.conversation_id);

    await service.archiveForTranscriptUser("task-reuse", first.association.conversation_id, "owner-reuse", true);
    const replacement = await service.getOrCreateBuilderConversation("task-reuse", "owner-reuse");

    if (replacement.kind !== "created") throw new Error("Expected a replacement builder conversation");
    expect(replacement.created).toBe(true);
    expect(replacement.association.conversation_id).not.toBe(first.association.conversation_id);
    await expect(
      service.listForTranscriptUser("task-reuse", "owner-reuse", { includeArchived: true }),
    ).resolves.toHaveLength(2);
  });

  it("serializes builder leases, expires stale owners, and releases on archival", async () => {
    await db
      .insertInto("scheduled_tasks")
      .values({
        id: "task-lock",
        platform: "slack",
        context_type: "dm",
        delivery_target: "D-lock",
        prompt: "Lock this task",
        schedule_type: "cron",
        schedule_value: "0 9 * * *",
        created_by: "owner-lock",
      })
      .execute();

    const repo = createScheduledTaskConversationRepository(db);
    await expect(
      repo.acquireBuilderLock({
        taskId: "task-lock",
        conversationId: "owner-chat",
        transcriptUserId: "owner-lock",
        nowMs: 1_000,
        nowIso: "2026-08-07T00:00:01.000Z",
        expiresAt: 2_000,
      }),
    ).resolves.toMatchObject({ acquired: true, lock: { conversation_id: "owner-chat" } });

    await expect(
      repo.acquireBuilderLock({
        taskId: "task-lock",
        conversationId: "admin-chat",
        transcriptUserId: "admin-lock",
        nowMs: 1_500,
        nowIso: "2026-08-07T00:00:01.500Z",
        expiresAt: 2_500,
      }),
    ).resolves.toMatchObject({ acquired: false, lock: { transcript_user_id: "owner-lock" } });

    await expect(
      repo.acquireBuilderLock({
        taskId: "task-lock",
        conversationId: "admin-chat",
        transcriptUserId: "admin-lock",
        nowMs: 2_000,
        nowIso: "2026-08-07T00:00:02.000Z",
        expiresAt: 3_000,
      }),
    ).resolves.toMatchObject({ acquired: true, lock: { transcript_user_id: "admin-lock" } });

    await expect(repo.releaseBuilderLock("task-lock", "admin-chat", "admin-lock")).resolves.toBe(true);
    await expect(repo.getBuilderLock("task-lock")).resolves.toBeUndefined();
  });

  it("locks source-chat authoring without exposing another user's transcript", async () => {
    await db
      .insertInto("scheduled_tasks")
      .values({
        id: "task-source-lock",
        platform: "slack",
        context_type: "dm",
        delivery_target: "D-source-lock",
        prompt: "Lock source chat",
        schedule_type: "cron",
        schedule_value: "0 9 * * *",
        created_by: "owner-source",
      })
      .execute();

    const service = createAutomationTaskConversationService(db);
    await service.associate({
      taskId: "task-source-lock",
      conversationId: "owner-source-chat",
      transcriptUserId: "owner-source",
      kind: "web_chat",
    });
    await service.associate({
      taskId: "task-source-lock",
      conversationId: "admin-source-chat",
      transcriptUserId: "admin-source",
      kind: "web_chat",
    });

    await expect(
      service.acquireBuilderConversationLock("task-source-lock", "owner-source-chat", "owner-source"),
    ).resolves.toMatchObject({ kind: "active", lock: { owner: "self" } });
    await expect(
      service.acquireBuilderConversationLock("task-source-lock", "admin-source-chat", "admin-source"),
    ).resolves.toMatchObject({ kind: "locked", lock: { owner: "other" } });

    await service.archiveForTranscriptUser("task-source-lock", "owner-source-chat", "owner-source", true);
    await expect(
      service.acquireBuilderConversationLock("task-source-lock", "admin-source-chat", "admin-source"),
    ).resolves.toMatchObject({ kind: "active", lock: { owner: "self" } });
  });
});
