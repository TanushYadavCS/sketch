import { describe, expect, it } from "vitest";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createTestDb, createTestPgDb } from "../test-utils";

/**
 * T9 — the migration behaves on both dialects.
 *
 * Column presence proves little on its own: `status` is plain text, so what is
 * worth asserting is the semantics. A deferred row must still accrue occurrences
 * when the same name is proposed again, which is exactly what breaks if
 * `deferred` is added to TERMINAL_STATUSES.
 */
describe.each([
  ["sqlite", createTestDb],
  ["postgres", createTestPgDb],
])("pass_reason migration on %s", (_dialect, makeDb) => {
  it("adds a nullable pass_reason column and keeps deferred non-terminal", async () => {
    const db = await makeDb();
    const repo = createEntityReviewRepo(db);

    const first = await repo.upsertQueueRow({
      proposedName: "Dialect Person",
      normalizedName: "dialect person",
      entityType: "person",
      source: null,
      sourceId: null,
      proposedEmail: null,
      candidateEntityId: null,
      candidateEntityIds: [],
      candidateScore: null,
      candidateReason: null,
      triggeredByUserId: "user-1",
      sourceScoped: false,
    });
    expect(first.row.pass_reason).toBeNull();

    await db
      .updateTable("entity_review_queue")
      .set({ status: "deferred", pass_reason: "name_already_resolved" })
      .where("id", "=", first.row.id)
      .execute();

    const second = await repo.upsertQueueRow({
      proposedName: "Dialect Person",
      normalizedName: "dialect person",
      entityType: "person",
      source: null,
      sourceId: null,
      proposedEmail: null,
      candidateEntityId: null,
      candidateEntityIds: [],
      candidateScore: null,
      candidateReason: null,
      triggeredByUserId: "user-1",
      sourceScoped: false,
    });

    expect(second.skipEvidence).toBe(false);
    expect(second.row.occurrence_count).toBe(2);
    expect(new Date(second.row.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.row.last_seen_at).getTime(),
    );
  });
});
