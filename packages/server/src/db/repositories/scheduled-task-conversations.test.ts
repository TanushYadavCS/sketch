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
    const service = createAutomationTaskConversationService(db);
    const first = await service.getOrCreateBuilderConversation("task-reuse", "owner-reuse");
    const reused = await service.getOrCreateBuilderConversation("task-reuse", "owner-reuse");

    expect(first.created).toBe(true);
    expect(reused.created).toBe(false);
    expect(reused.association.conversation_id).toBe(first.association.conversation_id);

    await service.archiveForTranscriptUser("task-reuse", first.association.conversation_id, "owner-reuse", true);
    const replacement = await service.getOrCreateBuilderConversation("task-reuse", "owner-reuse");

    expect(replacement.created).toBe(true);
    expect(replacement.association.conversation_id).not.toBe(first.association.conversation_id);
    await expect(
      service.listForTranscriptUser("task-reuse", "owner-reuse", { includeArchived: true }),
    ).resolves.toHaveLength(2);
  });
});
