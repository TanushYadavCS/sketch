import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createScheduledTaskConversationRepository } from "./scheduled-task-conversations";

describe("scheduled task conversation repository on Postgres", () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("uses the portable composite key and preserves archived associations", async () => {
    const repo = createScheduledTaskConversationRepository(db);
    const input = {
      taskId: "pg-task-a",
      conversationId: "pg-shared-chat",
      transcriptUserId: "pg-owner",
      kind: "builder" as const,
    };

    await repo.upsert(input);
    await repo.upsert(input);
    await repo.upsert({ ...input, kind: "web_chat" });
    await expect(
      repo.setArchivedForTaskConversation(input.taskId, input.conversationId, input.transcriptUserId, true),
    ).resolves.toBe(true);

    await expect(repo.listByTaskAndTranscriptUser(input.taskId, input.transcriptUserId)).resolves.toEqual([]);
    await expect(
      repo.listByTaskAndTranscriptUser(input.taskId, input.transcriptUserId, { includeArchived: true }),
    ).resolves.toHaveLength(2);
  });
});
