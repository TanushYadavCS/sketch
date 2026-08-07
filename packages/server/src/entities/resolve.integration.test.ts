import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { confirmReview } from "./resolve";

describe("entity resolve typed file access", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("writes typed file access rows on Postgres", async () => {
    db = await createTestPgDb();
    const entityRepo = createEntityRepository(db);
    const reviewRepo = createEntityReviewRepo(db);
    await db
      .insertInto("connector_configs")
      .values({
        id: "resolve-pg-config",
        connector_type: "fireflies",
        auth_type: "api_key",
        credentials: "{}",
        created_by: "resolve-user",
      })
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id: "resolve-pg-file",
        connector_config_id: "resolve-pg-config",
        provider_file_id: "resolve-pg-provider-file",
        file_name: "Transcript",
        file_type: "meeting_transcript",
        content_category: "document",
        source: "fireflies",
        synced_at: new Date().toISOString(),
      })
      .execute();

    const target = await entityRepo.upsertPersonEntity({
      name: "Resolve Target",
      email: "resolve@example.com",
      subtype: "external",
      source: "seed",
      sourceId: "resolve-target",
    });
    const queued = await reviewRepo.upsertSeedReviewRow({
      proposedName: "Resolve Target Alias",
      normalizedName: "resolve target alias",
      entityType: "person",
      seedSource: "fireflies",
      seedSourceId: "resolve-proposal",
      candidateEntityId: target.id,
      triggeredByUserId: "resolve-user",
    });
    await reviewRepo.upsertEvidence({ reviewId: queued.row.id, indexedFileId: "resolve-pg-file", source: "fireflies" });
    const row = await reviewRepo.getById(queued.row.id);
    if (!row?.candidate_generated_at) throw new Error("missing candidate timestamp");

    await confirmReview({ db, userId: "resolve-user" }, queued.row.id, {
      candidateGeneratedAt: row.candidate_generated_at,
    });

    await expect(db.selectFrom("file_access").select(["principal_type", "principal_value"]).execute()).resolves.toEqual(
      [{ principal_type: "email", principal_value: "resolve@example.com" }],
    );
  }, 30000);
});
