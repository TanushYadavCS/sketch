import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeName } from "../../connectors/name-normalize";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityReviewRepo } from "./entity-review";

const USER_ID = "user-1";

describe("entity review seed rows", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createEntityReviewRepo>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createEntityReviewRepo(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("dedupes seed rows by stable handle across renames and disambiguates name collisions", async () => {
    const first = await repo.upsertSeedReviewRow({
      proposedName: "Sketch",
      normalizedName: normalizeName("Sketch"),
      entityType: "project",
      seedSource: "linear",
      seedSourceId: "P1",
      candidateEntityId: null,
      triggeredByUserId: USER_ID,
    });

    const renamed = await repo.upsertSeedReviewRow({
      proposedName: "Ruler",
      normalizedName: normalizeName("Ruler"),
      entityType: "project",
      seedSource: "linear",
      seedSourceId: "P1",
      candidateEntityId: null,
      triggeredByUserId: USER_ID,
    });

    expect(renamed.row.id).toBe(first.row.id);
    expect(renamed.row.proposed_name).toBe("Ruler");
    expect(renamed.row.occurrence_count).toBe(first.row.occurrence_count + 1);

    const colliding = await repo.upsertSeedReviewRow({
      proposedName: "Sketch",
      normalizedName: normalizeName("Sketch"),
      entityType: "project",
      seedSource: "linear",
      seedSourceId: "P2",
      candidateEntityId: null,
      triggeredByUserId: USER_ID,
    });

    expect(colliding.row.id).not.toBe(first.row.id);
    expect(colliding.row.normalized_name).toBe("sketch:linear:P2");

    const rows = await db.selectFrom("entity_review_queue").selectAll().orderBy("id", "asc").execute();
    expect(rows).toHaveLength(2);
  });

  it("treats a rejected seed row as a sticky memo", async () => {
    const first = await repo.upsertSeedReviewRow({
      proposedName: "Sketch",
      normalizedName: normalizeName("Sketch"),
      entityType: "project",
      seedSource: "linear",
      seedSourceId: "P1",
      candidateEntityId: null,
      triggeredByUserId: USER_ID,
    });

    await db.updateTable("entity_review_queue").set({ status: "rejected" }).where("id", "=", first.row.id).execute();

    const second = await repo.upsertSeedReviewRow({
      proposedName: "Ruler",
      normalizedName: normalizeName("Ruler"),
      entityType: "project",
      seedSource: "linear",
      seedSourceId: "P1",
      candidateEntityId: null,
      triggeredByUserId: USER_ID,
    });

    expect(second.row.id).toBe(first.row.id);
    expect(second.row.status).toBe("rejected");
    expect(second.skipEvidence).toBe(true);

    const rows = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(rows).toHaveLength(1);
  });
});
