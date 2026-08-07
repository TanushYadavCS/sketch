import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { touchActiveAutomationTaskConversationAssociations } from "./task-conversations";

describe("automation task conversation touch", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("conditionally touches active rows without creating or reviving associations", async () => {
    const repo = createScheduledTaskConversationRepository(db);
    const input = {
      taskId: "task-touch",
      conversationId: "conversation-touch",
      transcriptUserId: "user-touch",
    };

    await expect(touchActiveAutomationTaskConversationAssociations(db, input)).resolves.toBe(0);
    await expect(
      repo.listByTaskConversationForTranscriptUser(input.taskId, input.conversationId, input.transcriptUserId, {
        includeArchived: true,
      }),
    ).resolves.toHaveLength(0);

    await repo.upsert({ ...input, kind: "builder" });
    await repo.setArchivedForTaskConversation(input.taskId, input.conversationId, input.transcriptUserId, true);
    await repo.upsert({ ...input, kind: "web_chat" });
    await db
      .updateTable("scheduled_task_conversations")
      .set({ updated_at: "2000-01-01 00:00:00", last_active_at: "2000-01-01 00:00:00" })
      .where("task_id", "=", input.taskId)
      .where("conversation_id", "=", input.conversationId)
      .where("transcript_user_id", "=", input.transcriptUserId)
      .execute();

    await expect(touchActiveAutomationTaskConversationAssociations(db, input)).resolves.toBe(1);
    const rows = await repo.listByTaskConversationForTranscriptUser(
      input.taskId,
      input.conversationId,
      input.transcriptUserId,
      { includeArchived: true },
    );
    const archivedBuilder = rows.find((row) => row.kind === "builder");
    const activeSource = rows.find((row) => row.kind === "web_chat");
    expect(archivedBuilder).toMatchObject({
      archived_at: expect.any(String),
      updated_at: "2000-01-01 00:00:00",
      last_active_at: "2000-01-01 00:00:00",
    });
    expect(activeSource).toMatchObject({ archived_at: null });
    expect(activeSource?.updated_at).not.toBe("2000-01-01 00:00:00");
    expect(activeSource?.last_active_at).not.toBe("2000-01-01 00:00:00");
  });
});
