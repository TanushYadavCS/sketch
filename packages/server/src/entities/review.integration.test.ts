import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { normalizeEntityMatchName } from "./name-keys";
import { reclassifyReview } from "./resolve";

const USER_ID = "a4-pg-user";

async function seedUser(db: Kysely<DB>) {
  await db.insertInto("users").values({ id: USER_ID, name: "A4 PG User", email: "a4-pg@example.com" }).execute();
}

async function seedConnectorAndFile(db: Kysely<DB>, fileId: string) {
  await db
    .insertInto("connector_configs")
    .values({
      id: "a4-pg-config",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: USER_ID,
      scope_config: JSON.stringify({}),
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: fileId,
      connector_config_id: "a4-pg-config",
      provider_file_id: `provider-${fileId}`,
      file_name: `${fileId}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedReviewRow(
  db: Kysely<DB>,
  opts: {
    proposedName: string;
    entityType: string;
    source?: string | null;
    sourceId?: string | null;
    seedSource?: string | null;
    seedSourceId?: string | null;
    fileId?: string;
    occurrenceCount?: number;
  },
): Promise<{ id: string; candidateGeneratedAt: string }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: opts.proposedName,
      normalized_name: normalizeEntityMatchName(opts.entityType, opts.proposedName),
      entity_type: opts.entityType,
      source: opts.source ?? null,
      source_id: opts.sourceId ?? null,
      seed_source: opts.seedSource ?? null,
      seed_source_id: opts.seedSourceId ?? null,
      candidate_entity_id: null,
      candidate_score: null,
      candidate_reason: "birth-gated",
      candidate_generated_at: now,
      first_seen_at: now,
      last_seen_at: now,
      occurrence_count: opts.occurrenceCount ?? 1,
      status: "pending",
      triggered_by_user_id: USER_ID,
    })
    .execute();
  if (opts.fileId) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: id,
        indexed_file_id: opts.fileId,
        source: "fireflies",
        note: null,
        seen_at: now,
      })
      .execute();
  }
  return { id, candidateGeneratedAt: now };
}

describe("entity-review A4 postgres", () => {
  let db: Kysely<DB>;

  afterEach(async () => {
    await db.destroy();
  });

  it("uses CASE/GROUP BY for summary and merges reclassify collisions without Postgres unique violations", async () => {
    db = await createTestPgDb();
    await seedUser(db);
    await seedConnectorAndFile(db, "a4-pg-file");
    await seedReviewRow(db, {
      proposedName: "A4 PG Tracker",
      entityType: "project",
      source: "linear",
      sourceId: "pg-tracker",
    });
    await seedReviewRow(db, { proposedName: "A4 PG Inferred", entityType: "project" });

    const summary = await createEntityReviewRepo(db).summarizePendingByTypeAndOrigin({
      ownerUserId: USER_ID,
      isAdmin: false,
    });
    expect(summary.groups).toEqual(
      expect.arrayContaining([
        { entityType: "project", origin: "tracker", count: 1 },
        { entityType: "project", origin: "inferred", count: 1 },
      ]),
    );

    const target = await seedReviewRow(db, {
      proposedName: "A4 PG Merge",
      entityType: "project",
      occurrenceCount: 4,
    });
    const source = await seedReviewRow(db, {
      proposedName: "A4 PG Merge",
      entityType: "product",
      source: "clickup",
      sourceId: "pg-merge",
      seedSource: "linear",
      seedSourceId: "pg-seed",
      fileId: "a4-pg-file",
      occurrenceCount: 6,
    });

    const result = await reclassifyReview({ db, userId: USER_ID }, source.id, {
      newEntityType: "project",
      candidateGeneratedAt: source.candidateGeneratedAt,
    });
    expect(result.result).toBe("RECLASSIFY");
    expect(result.row.id).toBe(target.id);
    const targetAfter = await db
      .selectFrom("entity_review_queue")
      .select(["source", "source_id", "seed_source", "seed_source_id", "occurrence_count"])
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    expect(targetAfter).toMatchObject({
      source: "clickup",
      source_id: "pg-merge",
      seed_source: "linear",
      seed_source_id: "pg-seed",
      occurrence_count: 10,
    });
    await expect(
      db.selectFrom("entity_review_queue").select("id").where("id", "=", source.id).executeTakeFirst(),
    ).resolves.toBeUndefined();
  });
});
