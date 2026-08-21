import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { seedAttendee, seedCompany, seedConnector, seedFile } from "./project-minting-fixtures";
import { createWeeklyMintService } from "./weekly-mint";

describe("weekly mint dry-streak retirement", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedClientCorpus(input?: {
    companyName?: string;
    domain?: string;
    projectPhrase?: string;
  }): Promise<{ companyId: string; fileIds: string[] }> {
    const connectorId = await seedConnector(db);
    const companyName = input?.companyName ?? "Dryco";
    const domain = input?.domain ?? "dryco.example";
    const phrase = input?.projectPhrase ?? "Budget Dashboard";
    const companyId = await seedCompany(db, companyName, domain);
    const fileIds: string[] = [];
    for (const day of ["01", "02", "03"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: `${phrase} ${day}`,
        source: "fireflies",
        date: `2026-01-${day}T09:00:00.000Z`,
        content: `${phrase} kickoff, implementation, and delivery update.`,
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", `dana@${domain}`);
      fileIds.push(fileId);
    }
    return { companyId, fileIds };
  }

  async function seedProjectReview(name: string, fileIds: string[]): Promise<string> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await db
      .insertInto("entity_review_queue")
      .values({
        id,
        proposed_name: name,
        normalized_name: name.toLowerCase(),
        entity_type: "project",
        source: "llm_extraction",
        source_id: `llm_extraction:${id}`,
        proposed_email: null,
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: null,
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: fileIds.length,
        status: "pending",
        triggered_by_user_id: "system",
      })
      .execute();
    for (const fileId of fileIds) {
      await db
        .insertInto("entity_review_evidence")
        .values({ id: randomUUID(), review_id: id, indexed_file_id: fileId, source: "llm_extraction", note: null })
        .execute();
    }
    return id;
  }

  function generator(raw: unknown): GeminiGenerator {
    return {
      async generate() {
        return "";
      },
      async generateJSON<T>() {
        return raw as T;
      },
    };
  }

  it("retires a row skipped by the model in three consecutive runs and traces it", async () => {
    const corpus = await seedClientCorpus();
    const reviewId = await seedProjectReview("Budget Dashboard", corpus.fileIds);
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: generator({ groups: [{ groupKey: reviewId, action: "skip" }] }),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-01-12T00:00:00.000Z"));
    await service.runOnce(new Date("2026-01-19T00:00:00.000Z"));
    await service.runOnce(new Date("2026-01-26T00:00:00.000Z"));

    const review = await db
      .selectFrom("entity_review_queue")
      .select(["status", "retired_reason"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    const candidate = await db
      .selectFrom("weekly_mint_candidates")
      .select(["dry_streak", "retired_at", "retired_reason"])
      .where("review_id", "=", reviewId)
      .executeTakeFirstOrThrow();
    const trace = await db
      .selectFrom("weekly_mint_traces")
      .select(["kind", "payload"])
      .where("kind", "=", "retired_dry_streak")
      .executeTakeFirstOrThrow();
    expect(review).toEqual({ status: "retired", retired_reason: "dry_streak" });
    expect(candidate.dry_streak).toBe(3);
    expect(candidate.retired_at).not.toBeNull();
    expect(candidate.retired_reason).toBe("dry_streak");
    expect(JSON.parse(trace.payload)).toEqual({ groupNames: ["Budget Dashboard"], count: 1 });
  });

  it("resets dry streak when a crossing group is stored", async () => {
    const corpus = await seedClientCorpus({ projectPhrase: "Atlas Migration" });
    const reviewId = await seedProjectReview("Atlas Migration", corpus.fileIds);
    await db
      .insertInto("weekly_mint_candidates")
      .values({ review_id: reviewId, company_key: corpus.companyId, dry_streak: 2 })
      .execute();
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: generator({ groups: [{ groupKey: reviewId, action: "new", projectName: "Atlas Migration" }] }),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-01-12T00:00:00.000Z"));

    const candidate = await db
      .selectFrom("weekly_mint_candidates")
      .select(["dry_streak", "retired_at", "retired_reason"])
      .where("review_id", "=", reviewId)
      .executeTakeFirstOrThrow();
    const review = await db
      .selectFrom("entity_review_queue")
      .select(["status", "retired_reason"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(candidate).toEqual({ dry_streak: 0, retired_at: null, retired_reason: null });
    expect(review).toEqual({ status: "pending", retired_reason: null });
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(1);
  });

  it("does not retire a fresh row that joins a stale skipped group", async () => {
    const corpus = await seedClientCorpus({ projectPhrase: "Atlas Migration" });
    const staleReviewId = await seedProjectReview("Atlas Migration", corpus.fileIds);
    const freshReviewId = await seedProjectReview("Atlas Migration Dashboard", corpus.fileIds);
    await db
      .insertInto("weekly_mint_candidates")
      .values([
        { review_id: staleReviewId, company_key: corpus.companyId, dry_streak: 2 },
        { review_id: freshReviewId, company_key: corpus.companyId, dry_streak: 0 },
      ])
      .execute();
    const fusedGroupKey = [staleReviewId, freshReviewId].sort().join("|");
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: generator({ groups: [{ groupKey: fusedGroupKey, action: "skip" }] }),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-01-12T00:00:00.000Z"));

    const reviews = await db
      .selectFrom("entity_review_queue")
      .select(["id", "status", "retired_reason"])
      .where("id", "in", [staleReviewId, freshReviewId])
      .execute();
    const candidates = await db
      .selectFrom("weekly_mint_candidates")
      .select(["review_id", "dry_streak", "retired_at", "retired_reason"])
      .where("review_id", "in", [staleReviewId, freshReviewId])
      .execute();
    const reviewById = new Map(reviews.map((row) => [row.id, row]));
    const candidateById = new Map(candidates.map((row) => [row.review_id, row]));
    expect(reviewById.get(staleReviewId)).toMatchObject({ status: "retired", retired_reason: "dry_streak" });
    expect(candidateById.get(staleReviewId)?.dry_streak).toBe(3);
    expect(candidateById.get(staleReviewId)?.retired_reason).toBe("dry_streak");
    expect(candidateById.get(staleReviewId)?.retired_at).not.toBeNull();
    expect(reviewById.get(freshReviewId)).toMatchObject({ status: "pending", retired_reason: null });
    expect(candidateById.get(freshReviewId)).toMatchObject({
      dry_streak: 1,
      retired_at: null,
      retired_reason: null,
    });
  });
});
