import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createAgentMessagesRepository } from "./agent-messages";

describe("agent messages repository", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createAgentMessagesRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createAgentMessagesRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("appends and loads messages ordered by seq", async () => {
    await repo.appendBatch([
      { sessionId: "sess-1", seq: 2, role: "assistant", content: { content: [{ type: "text", text: "hi" }] } },
      { sessionId: "sess-1", seq: 1, role: "user", content: { content: [{ type: "text", text: "hello" }] } },
    ]);

    const rows = await repo.loadBySession("sess-1");

    expect(rows.map((row) => ({ seq: row.seq, role: row.role, content: row.content }))).toEqual([
      { seq: 1, role: "user", content: { content: [{ type: "text", text: "hello" }] } },
      { seq: 2, role: "assistant", content: { content: [{ type: "text", text: "hi" }] } },
    ]);
  });

  it("keeps append batches transactional when a seq conflicts", async () => {
    await repo.appendBatch([{ sessionId: "sess-1", seq: 1, role: "user", content: { text: "existing" } }]);

    await expect(
      repo.appendBatch([
        { sessionId: "sess-2", seq: 1, role: "user", content: { text: "new" } },
        { sessionId: "sess-1", seq: 1, role: "assistant", content: { text: "duplicate" } },
      ]),
    ).rejects.toThrow();

    await expect(repo.loadBySession("sess-2")).resolves.toEqual([]);
  });
});
