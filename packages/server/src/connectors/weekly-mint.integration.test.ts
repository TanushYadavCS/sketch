import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { normalizeTitleFamily, readClusterVerdict } from "./project-minting";
import { seedAttendee, seedCompany, seedConnector, seedFile } from "./project-minting-fixtures";
import {
  WEEKLY_MINT_PROMPT_VERSION,
  WeeklyMintProcessCrash,
  createWeeklyMintService,
  partitionFiles,
} from "./weekly-mint";

function fakeGenerator(counter: { calls: number }): GeminiGenerator {
  return {
    async generate() {
      return "";
    },
    async generateJSON<T>() {
      counter.calls += 1;
      return { groups: [] } as T;
    },
  };
}

async function seedClientCorpus(
  db: Kysely<DB>,
  input: { companyName?: string; domain?: string; files: Array<{ id?: string; date: string; content: string }> },
): Promise<{ companyId: string; connectorId: string; fileIds: string[] }> {
  const connectorId = await seedConnector(db);
  const domain = input.domain ?? "acme.test";
  const companyId = await seedCompany(db, input.companyName ?? "Acme", domain);
  const fileIds: string[] = [];
  for (const [index, file] of input.files.entries()) {
    const fileId = await seedFile(db, connectorId, {
      fileName: file.id ?? `atlas-${index}.txt`,
      source: "fireflies",
      date: `${file.date}T10:00:00.000Z`,
      content: file.content,
    });
    await seedAttendee(db, connectorId, fileId, `Client ${index}`, `person${index}@${domain}`);
    fileIds.push(fileId);
  }
  return { companyId, connectorId, fileIds };
}

async function queueProjectReview(
  db: Kysely<DB>,
  input: {
    name: string;
    fileIds?: string[];
    source?: string | null;
    lastSeenAt?: string;
    candidateEntityId?: string | null;
  },
): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: input.name,
      normalized_name: input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
      entity_type: "project",
      source: input.source ?? "llm_extraction",
      source_id: `${input.source ?? "llm_extraction"}:${id}`,
      proposed_email: null,
      candidate_entity_id: input.candidateEntityId ?? null,
      candidate_score: null,
      candidate_reason: null,
      candidate_generated_at: now,
      first_seen_at: input.lastSeenAt ?? now,
      last_seen_at: input.lastSeenAt ?? now,
      occurrence_count: input.fileIds?.length ?? 1,
      status: "pending",
      triggered_by_user_id: "system",
    })
    .execute();
  for (const fileId of input.fileIds ?? []) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: id,
        indexed_file_id: fileId,
        source: input.source ?? "llm_extraction",
        note: null,
      })
      .execute();
  }
  return id;
}

async function seedStandingProduct(db: Kysely<DB>, name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "product",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: "declared",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      share_with_everyone: 1,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  return id;
}

async function seedGuardCompany(db: Kysely<DB>, name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "company",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: "inferred",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      share_with_everyone: 1,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  return id;
}

async function seedProjectEntity(
  db: Kysely<DB>,
  name: string,
  aliases: string[],
  engagementForCompanyId?: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: aliases.length > 0 ? JSON.stringify(aliases) : null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      share_with_everyone: 1,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  if (engagementForCompanyId) {
    await db
      .insertInto("entity_relationships")
      .values({
        id: randomUUID(),
        source_entity_id: id,
        target_entity_id: engagementForCompanyId,
        relationship_type: "engagement_for",
        confidence: "CONFIRMED",
        confidence_score: 1,
        source: "test",
        valid_from: "",
        valid_to: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  return id;
}

describe("weekly mint pass", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("stores one verdict for a three-day crossing group and dedupes the same pool next week", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        {
          id: "Client Atlas Migration - 2026-01-05",
          date: "2026-01-05",
          content: "Atlas Migration kickoff and plan.",
        },
        {
          id: "Client Atlas Migration - 2026-01-06",
          date: "2026-01-06",
          content: "Atlas Migration implementation update.",
        },
        {
          id: "Client Atlas Migration - 2026-01-07",
          date: "2026-01-07",
          content: "Atlas Migration delivery review.",
        },
      ],
    });
    const reviewId = await queueProjectReview(db, { name: "Atlas Migration", fileIds: corpus.fileIds });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-01-12T00:00:00.000Z"));
    expect(counter.calls).toBe(1);
    const verdicts = await db.selectFrom("project_minting_verdicts").selectAll().execute();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.prompt_version).toBe(WEEKLY_MINT_PROMPT_VERSION);
    const project = readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true }).projects[0];
    expect(project?.evidenceTitleFamilies.map((family) => normalizeTitleFamily(family).key)).toEqual([
      "client atlas migration",
    ]);
    expect(project?.evidenceTitleFamilies).not.toContain("Atlas Migration");
    expect(project?.evidenceFragments).toEqual([]);
    expect(project?.coveredReviewIds).toEqual([reviewId]);

    await service.runOnce(new Date("2026-01-19T00:00:00.000Z"));
    expect(counter.calls).toBe(1);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(1);
  });

  it("leaves a skipped crossing group pending without storing an empty verdict", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-01-05", content: "Budget Dashboard kickoff and plan." },
        { date: "2026-01-06", content: "Budget Dashboard implementation update." },
        { date: "2026-01-07", content: "Budget Dashboard delivery review." },
      ],
    });
    const reviewId = await queueProjectReview(db, { name: "Budget Dashboard", fileIds: corpus.fileIds });
    const generator: GeminiGenerator = {
      async generate() {
        return "";
      },
      async generateJSON<T>() {
        return {
          groups: [
            {
              groupKey: reviewId,
              action: "skip",
            },
          ],
        } as T;
      },
    };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator,
      model: "test/reasoning-model",
    });

    const result = await service.runOnce(new Date("2026-01-12T00:00:00.000Z"));

    expect(result.skippedGroups).toBe(1);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(0);
    const review = await db
      .selectFrom("entity_review_queue")
      .select(["status", "resolved_by", "candidate_entity_id", "candidate_reason"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(review).toEqual({
      status: "pending",
      resolved_by: null,
      candidate_entity_id: null,
      candidate_reason: null,
    });
  });

  it("increments dry streak below the recurrence floor and leaves stale non-weekly reviews untouched", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-02-02", content: "Atlas Migration kickoff." },
        { date: "2026-02-02", content: "Atlas Migration follow-up on the same day." },
      ],
    });
    const reviewId = await queueProjectReview(db, { name: "Atlas Migration", fileIds: corpus.fileIds });
    const staleUserReviewId = await queueProjectReview(db, {
      name: "Stale User Link",
      source: "user_entity_link",
      lastSeenAt: "2025-11-01T00:00:00.000Z",
    });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-02-09T00:00:00.000Z"));

    expect(counter.calls).toBe(0);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(0);
    const candidate = await db
      .selectFrom("weekly_mint_candidates")
      .selectAll()
      .where("review_id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(candidate.dry_streak).toBe(1);
    expect(candidate.scan_days).toBe(1);
    const stale = await db
      .selectFrom("entity_review_queue")
      .select(["status", "resolved_by"])
      .where("id", "=", staleUserReviewId)
      .executeTakeFirstOrThrow();
    expect(stale).toEqual({ status: "pending", resolved_by: null });
  });

  it("skips vendor-declared containers without stranding claimed or stale weekly candidates", async () => {
    const corpus = await seedClientCorpus(db, {
      companyName: "Vendorco",
      domain: "vendorco.test",
      files: [
        { date: "2026-04-06", content: "Atlas Migration kickoff and plan." },
        { date: "2026-04-07", content: "Atlas Migration implementation update." },
        { date: "2026-01-01", content: "Legacy Cleanup archive review." },
      ],
    });
    await db
      .insertInto("company_relationship_declarations")
      .values({
        subject_entity_id: corpus.companyId,
        counterparty_kind: "vendor",
        client_stage: null,
        note: null,
      })
      .execute();
    const freshReviewId = await queueProjectReview(db, {
      name: "Atlas Migration",
      fileIds: corpus.fileIds.slice(0, 2),
    });
    const staleReviewId = await queueProjectReview(db, {
      name: "Legacy Cleanup",
      fileIds: [corpus.fileIds[2]],
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-04-13T00:00:00.000Z"));

    expect(counter.calls).toBe(0);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(0);
    const candidates = await db
      .selectFrom("weekly_mint_candidates")
      .select(["review_id", "company_key"])
      .orderBy("review_id", "asc")
      .execute();
    expect(candidates).toEqual(
      [freshReviewId, staleReviewId].sort().map((reviewId) => ({
        review_id: reviewId,
        company_key: corpus.companyId,
      })),
    );
    const rows = await db
      .selectFrom("entity_review_queue")
      .select(["id", "status", "resolved_by"])
      .where("id", "in", [freshReviewId, staleReviewId])
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual(
      [
        { id: freshReviewId, status: "pending", resolved_by: null },
        { id: staleReviewId, status: "dismissed", resolved_by: "weekly-mint-ageout" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("steals an abandoned lease after a crash past the company cursor without a second verdict call", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-03-03", content: "Atlas Migration kickoff and plan." },
        { date: "2026-03-04", content: "Atlas Migration implementation update." },
        { date: "2026-03-05", content: "Atlas Migration delivery review." },
      ],
    });
    await queueProjectReview(db, { name: "Atlas Migration", fileIds: corpus.fileIds });
    const counter = { calls: 0 };
    let crashed = false;
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
      afterCompanyBatch() {
        if (crashed) return;
        crashed = true;
        throw new WeeklyMintProcessCrash();
      },
    });

    await expect(service.runOnce(new Date("2026-03-09T00:00:00.000Z"))).rejects.toThrow(WeeklyMintProcessCrash);
    expect(counter.calls).toBe(1);
    const abandoned = await db.selectFrom("weekly_mint_runs").selectAll().executeTakeFirstOrThrow();
    expect(abandoned.status).toBe("running");
    expect(abandoned.company_cursor).toBe(corpus.companyId);

    await db
      .updateTable("weekly_mint_runs")
      .set({ heartbeat_at: "2026-03-01T00:00:00.000Z" })
      .where("id", "=", abandoned.id)
      .execute();
    const resumed = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });
    const result = await resumed.runOnce(new Date("2026-03-09T00:00:00.000Z"));

    expect(result.status).toBe("completed");
    expect(counter.calls).toBe(1);
    const completed = await db.selectFrom("weekly_mint_runs").selectAll().executeTakeFirstOrThrow();
    expect(completed).toMatchObject({ status: "completed", verdicts_requested: 1, verdicts_stored: 1 });
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(1);
  });

  it("stores an internal recurring topic under a matching standing product when a repo is referenced twice", async () => {
    const connectorId = await seedConnector(db);
    const productId = await seedStandingProduct(db, "Sketch");
    const fileIds = [];
    for (const [index, date] of ["2026-04-06", "2026-04-07", "2026-04-08"].entries()) {
      fileIds.push(
        await seedFile(db, connectorId, {
          fileName: `sketch-memory-${index}.txt`,
          source: "fireflies",
          date: `${date}T10:00:00.000Z`,
          content:
            index < 2
              ? "Sketch Memory work continues in github.com/canvasxai/sketch-memory."
              : "Sketch Memory rollout notes.",
        }),
      );
    }
    const reviewId = await queueProjectReview(db, { name: "Sketch Memory", fileIds });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-04-13T00:00:00.000Z"));

    expect(counter.calls).toBe(1);
    const verdicts = await db.selectFrom("project_minting_verdicts").selectAll().execute();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.company_entity_id).toBeNull();
    const project = readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true }).projects[0];
    expect(project).toMatchObject({ name: "Sketch Memory", parentEntityId: productId });
    expect(project?.evidenceFragments).toEqual([]);
    expect(project?.coveredReviewIds).toEqual([reviewId]);
  });

  it("keeps an internal recurring topic pooled when it has no structural co-signal", async () => {
    const connectorId = await seedConnector(db);
    const fileIds = [];
    for (const [index, date] of ["2026-05-04", "2026-05-05", "2026-05-06"].entries()) {
      fileIds.push(
        await seedFile(db, connectorId, {
          fileName: `sketch-memory-${index}.txt`,
          source: "fireflies",
          date: `${date}T10:00:00.000Z`,
          content: "Sketch Memory notes without a structural artifact.",
        }),
      );
    }
    await queueProjectReview(db, { name: "Sketch Memory", fileIds });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-05-11T00:00:00.000Z"));

    expect(counter.calls).toBe(0);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(0);
  });

  it("skips an internal recurring topic named after a confirmed company and pools it toward age-out", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedGuardCompany(db, "Goosebumps");
    const fileIds = [];
    for (const [index, date] of ["2026-04-06", "2026-04-07", "2026-04-08"].entries()) {
      fileIds.push(
        await seedFile(db, connectorId, {
          fileName: `goosebumps-${index}.txt`,
          source: "fireflies",
          date: `${date}T10:00:00.000Z`,
          content:
            index < 2
              ? "Goosebumps rollout continues in github.com/canvasxai/goosebumps-deploy."
              : "Goosebumps rollout notes.",
        }),
      );
    }
    const reviewId = await queueProjectReview(db, { name: "Goosebumps", fileIds });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-04-13T00:00:00.000Z"));

    expect(counter.calls).toBe(0);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(0);
    expect(companyId).toBeTruthy();
    const candidate = await db
      .selectFrom("weekly_mint_candidates")
      .select(["dry_streak"])
      .where("review_id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(candidate.dry_streak).toBe(1);
    const review = await db
      .selectFrom("entity_review_queue")
      .select(["status"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(review.status).toBe("pending");
  });

  it("skips a company match even when the candidate collapses the company name spacing", async () => {
    const connectorId = await seedConnector(db);
    await seedGuardCompany(db, "Craft Idea");
    const fileIds = [];
    for (const [index, date] of ["2026-04-06", "2026-04-07", "2026-04-08"].entries()) {
      fileIds.push(
        await seedFile(db, connectorId, {
          fileName: `craftidea-${index}.txt`,
          source: "fireflies",
          date: `${date}T10:00:00.000Z`,
          content:
            index < 2
              ? "craftidea launch work tracked in github.com/canvasxai/craftidea-site."
              : "craftidea launch notes.",
        }),
      );
    }
    await queueProjectReview(db, { name: "craftidea", fileIds });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-04-13T00:00:00.000Z"));

    expect(counter.calls).toBe(0);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(0);
  });

  it("routes an internal topic under a declared standing product even when a company shares the name", async () => {
    const connectorId = await seedConnector(db);
    const productId = await seedStandingProduct(db, "Beetu");
    await seedGuardCompany(db, "Beetu");
    const fileIds = [];
    for (const [index, date] of ["2026-04-06", "2026-04-07", "2026-04-08"].entries()) {
      fileIds.push(
        await seedFile(db, connectorId, {
          fileName: `beetu-${index}.txt`,
          source: "fireflies",
          date: `${date}T10:00:00.000Z`,
          content:
            index < 2 ? "Beetu app work continues in github.com/canvasxai/beetu-app." : "Beetu app rollout notes.",
        }),
      );
    }
    const reviewId = await queueProjectReview(db, { name: "Beetu", fileIds });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-04-13T00:00:00.000Z"));

    expect(counter.calls).toBe(1);
    const verdicts = await db.selectFrom("project_minting_verdicts").selectAll().execute();
    expect(verdicts).toHaveLength(1);
    const project = readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true }).projects[0];
    expect(project).toMatchObject({ parentEntityId: productId });
    expect(project?.coveredReviewIds).toEqual([reviewId]);
  });

  it("partitions a prospect-domain sales call into the prospect external cluster instead of the internal pot", async () => {
    const connectorId = await seedConnector(db);
    await seedStandingProduct(db, "Sketch");
    const prospectId = await seedCompany(db, "Prospectco", "prospectco.test");
    await db
      .insertInto("company_relationship_declarations")
      .values({
        subject_entity_id: prospectId,
        counterparty_kind: "client",
        client_stage: "prospect",
        note: null,
      })
      .execute();
    const fileId = await seedFile(db, connectorId, {
      fileName: "sketch-prospect-demo.txt",
      source: "fireflies",
      date: "2026-06-02T10:00:00.000Z",
      content: "Sales call about Sketch rollout and onboarding.",
    });
    await seedAttendee(db, connectorId, fileId, "Prospect Buyer", "buyer@prospectco.test");

    const partition = await partitionFiles(db);

    expect(partition.external.get(prospectId)?.has(fileId)).toBe(true);
    expect(partition.internal.has(fileId)).toBe(false);
  });

  it("keeps distinct candidates separate when they share only generic or company tokens", async () => {
    const corpus = await seedClientCorpus(db, {
      companyName: "Oliver Wyman",
      domain: "oliverwyman.test",
      files: [
        { date: "2026-04-06", content: "War dashboard scope review." },
        { date: "2026-04-07", content: "War dashboard iteration." },
        { date: "2026-04-08", content: "War dashboard delivery." },
        { date: "2026-04-06", content: "Budget dashboard planning." },
        { date: "2026-04-07", content: "Budget dashboard data model." },
        { date: "2026-04-08", content: "Budget dashboard rollout." },
      ],
    });
    await queueProjectReview(db, { name: "War Dashboard", fileIds: corpus.fileIds.slice(0, 3) });
    await queueProjectReview(db, { name: "Budget Dashboard", fileIds: corpus.fileIds.slice(3) });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-04-13T00:00:00.000Z"));

    const verdicts = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("prompt_version", "=", WEEKLY_MINT_PROMPT_VERSION)
      .execute();
    expect(verdicts).toHaveLength(1);
    const verdict = readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true });
    expect(verdict.projects.map((project) => project.name).sort()).toEqual(["Budget Dashboard", "War Dashboard"]);
  });

  it("treats a child named after its parent as an alias instead of failing the run", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-06-01", content: "One Stop questionnaire kickoff." },
        { date: "2026-06-02", content: "One Stop questionnaire buildout." },
        { date: "2026-06-03", content: "One Stop questionnaire review." },
      ],
    });
    const oneStopId = await seedProjectEntity(db, "One Stop", [], corpus.companyId);
    const reviewId = await queueProjectReview(db, { name: "One Stop Questionnaire", fileIds: corpus.fileIds });
    const selfParentGenerator: GeminiGenerator = {
      async generate() {
        return "";
      },
      async generateJSON<T>() {
        const rows = await db.selectFrom("weekly_mint_candidates").select("review_id").execute();
        return {
          groups: [
            {
              groupKey: rows
                .map((row) => row.review_id)
                .sort()
                .join("|"),
              action: "child_of",
              projectName: "One Stop",
              targetEntityId: oneStopId,
            },
          ],
        } as T;
      },
    };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: selfParentGenerator,
      model: "test/reasoning-model",
    });

    const result = await service.runOnce(new Date("2026-06-08T00:00:00.000Z"));

    expect(result.status).toBe("completed");
    const aliasRow = await db
      .selectFrom("entity_review_queue")
      .select(["candidate_entity_id", "candidate_reason"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(aliasRow).toMatchObject({ candidate_entity_id: oneStopId, candidate_reason: "weekly-mint-alias" });
    expect(
      await db
        .selectFrom("project_minting_verdicts")
        .selectAll()
        .where("prompt_version", "=", WEEKLY_MINT_PROMPT_VERSION)
        .execute(),
    ).toHaveLength(0);
  });

  it("prompts with content-derived nesting context and stores a child under an existing project", async () => {
    const corpus = await seedClientCorpus(db, {
      companyName: "Oliver Wyman",
      domain: "oliverwyman.test",
      files: [
        { date: "2026-07-01", content: "Traveller Dashboard roadmap." },
        {
          date: "2026-07-02",
          content: "Traveller Dashboard metrics and Search Terms Display for the traveller segmentation build.",
        },
        { date: "2026-07-03", content: "Traveller Dashboard delivery review." },
        { date: "2026-07-04", content: "Search Terms Display query work." },
        { date: "2026-07-05", content: "Search Terms Display review." },
      ],
    });
    const parentReviewId = await queueProjectReview(db, {
      name: "Traveller Dashboard",
      fileIds: corpus.fileIds.slice(0, 3),
    });
    const segmentationId = await seedProjectEntity(db, "Segmentation", ["traveller segmentation"], corpus.companyId);
    const childReviewId = await queueProjectReview(db, {
      name: "Search Terms Display",
      fileIds: [corpus.fileIds[1], ...corpus.fileIds.slice(3)],
    });
    const prompts: string[] = [];
    const generator: GeminiGenerator = {
      async generate() {
        return "";
      },
      async generateJSON<T>(prompt: string) {
        prompts.push(prompt);
        return {
          groups: [
            {
              groupKey: parentReviewId,
              action: "new",
              projectName: "Traveller Dashboard",
              targetEntityId: null,
            },
            {
              groupKey: childReviewId,
              action: "child_of",
              projectName: "Search Terms Display",
              targetEntityId: segmentationId,
            },
          ],
        } as T;
      },
    };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator,
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-07-13T00:00:00.000Z"));

    expect(prompts[0]).toContain(`sharedEvidenceWith: Search Terms Display [${childReviewId}] (1 files)`);
    expect(prompts[0]).toContain("coMentionedProjects: Segmentation (1 files)");
    expect(prompts[0]).toContain(
      '"Traveller Dashboard metrics and Search Terms Display for the traveller segmentation build."',
    );
    const verdicts = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("prompt_version", "=", WEEKLY_MINT_PROMPT_VERSION)
      .execute();
    expect(verdicts).toHaveLength(1);
    const verdict = readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true });
    expect(verdict.projects.find((project) => project.name === "Search Terms Display")?.parentName).toBe(
      "Segmentation",
    );
  });

  it("renders shared inventory files as previews and flags groups with only shared evidence", async () => {
    const corpus = await seedClientCorpus(db, {
      companyName: "Oliver Wyman",
      domain: "oliverwyman.test",
      files: [
        {
          date: "2026-08-03",
          content:
            "deployment inventory lists Alpha Build, Beta Launch, Gamma Ops, Delta Plan, and Echo Only with repo URLs.",
        },
        { date: "2026-08-04", content: "Alpha Build implementation detail." },
        { date: "2026-08-04", content: "Beta Launch implementation detail." },
        { date: "2026-08-04", content: "Gamma Ops implementation detail." },
        { date: "2026-08-04", content: "Delta Plan implementation detail." },
        { date: "2026-08-04", content: "Echo Only owner sync." },
        {
          date: "2026-08-05",
          content: "Alpha Build, Beta Launch, Gamma Ops, Delta Plan, and Echo Only follow-up sync.",
        },
      ],
    });
    const sharedFileId = corpus.fileIds[0];
    const alphaId = await queueProjectReview(db, {
      name: "Alpha Build",
      fileIds: [sharedFileId, corpus.fileIds[1]],
    });
    const betaId = await queueProjectReview(db, {
      name: "Beta Launch",
      fileIds: [sharedFileId, corpus.fileIds[2]],
    });
    const gammaId = await queueProjectReview(db, {
      name: "Gamma Ops",
      fileIds: [sharedFileId, corpus.fileIds[3]],
    });
    const deltaId = await queueProjectReview(db, {
      name: "Delta Plan",
      fileIds: [sharedFileId, corpus.fileIds[4]],
    });
    const echoId = await queueProjectReview(db, { name: "Echo Only", fileIds: [sharedFileId] });
    const prompts: string[] = [];
    const generator: GeminiGenerator = {
      async generate() {
        return "";
      },
      async generateJSON<T>(prompt: string) {
        prompts.push(prompt);
        return {
          groups: [alphaId, betaId, gammaId, deltaId, echoId].map((groupKey) => ({
            groupKey,
            action: "skip",
          })),
        } as T;
      },
    };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator,
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-08-10T00:00:00.000Z"));

    expect(prompts[0]).toContain('snippets: "Alpha Build implementation detail."');
    expect(prompts[0]).toContain('preview: "deployment inventory lists');
    expect(prompts[0]).not.toMatch(/snippets: "[^"]*deployment inventory lists/);
    expect(prompts[0]?.match(/\n {2}onlySharedEvidence: true/g)).toHaveLength(1);
    expect(prompts[0]).toContain(`- groupKey: ${echoId}`);
  });

  it("aliases only the exact-matching candidate and still mints its group-mate", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-05-04", content: "Atlas phase two planning." },
        { date: "2026-05-05", content: "Atlas phase two iteration." },
        { date: "2026-05-06", content: "Atlas phase two wrap." },
        { date: "2026-05-04", content: "Atlas rollout sync." },
      ],
    });
    const atlasId = await seedProjectEntity(db, "Atlas", ["Atlas Rollout"], corpus.companyId);
    const aliasReviewId = await queueProjectReview(db, { name: "Atlas Rollout", fileIds: [corpus.fileIds[3]] });
    const phaseReviewId = await queueProjectReview(db, {
      name: "Atlas Phase Two",
      fileIds: corpus.fileIds.slice(0, 3),
    });
    const counter = { calls: 0 };
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator(counter),
      model: "test/reasoning-model",
    });

    await service.runOnce(new Date("2026-05-11T00:00:00.000Z"));

    const aliasRow = await db
      .selectFrom("entity_review_queue")
      .select(["candidate_entity_id", "candidate_reason", "status"])
      .where("id", "=", aliasReviewId)
      .executeTakeFirstOrThrow();
    expect(aliasRow).toMatchObject({
      candidate_entity_id: atlasId,
      candidate_reason: "weekly-mint-alias",
      status: "pending",
    });
    const phaseRow = await db
      .selectFrom("entity_review_queue")
      .select(["candidate_reason"])
      .where("id", "=", phaseReviewId)
      .executeTakeFirstOrThrow();
    expect(phaseRow.candidate_reason).toBeNull();
    const verdicts = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("prompt_version", "=", WEEKLY_MINT_PROMPT_VERSION)
      .execute();
    expect(verdicts).toHaveLength(1);
    const verdict = readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true });
    expect(verdict.projects.map((project) => project.name)).toEqual(["Atlas Phase Two"]);
  });

  /**
   * The observability contract in one pass: a judged container leaves an event
   * sequence plus a 3-step trace tied to the stored verdict, a vendor container
   * leaves only claimed → vendor_skip, and a same-week rerun starts from a
   * clean feed instead of mixing two attempts under one run id.
   */
  it("records run events and judgment traces, and a manual rerun clears the previous attempt's rows", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-01-05", content: "Atlas Migration kickoff and plan." },
        { date: "2026-01-06", content: "Atlas Migration implementation update." },
        { date: "2026-01-07", content: "Atlas Migration delivery review." },
      ],
    });
    await queueProjectReview(db, { name: "Atlas Migration", fileIds: corpus.fileIds });
    const vendorCompanyId = await seedCompany(db, "Vendorco", "vendorco.test");
    const vendorFileIds: string[] = [];
    for (const [index, date] of ["2026-01-05", "2026-01-06"].entries()) {
      const fileId = await seedFile(db, corpus.connectorId, {
        fileName: `vendor-sync-${index}.txt`,
        source: "fireflies",
        date: `${date}T10:00:00.000Z`,
        content: "Vendor Portal rollout notes.",
      });
      await seedAttendee(db, corpus.connectorId, fileId, `Vendor ${index}`, `person${index}@vendorco.test`);
      vendorFileIds.push(fileId);
    }
    await db
      .insertInto("company_relationship_declarations")
      .values({ subject_entity_id: vendorCompanyId, counterparty_kind: "vendor", client_stage: null, note: null })
      .execute();
    await queueProjectReview(db, { name: "Vendor Portal", fileIds: vendorFileIds });
    let tick = 0;
    const service = createWeeklyMintService({
      db,
      mode: "live",
      logger: createTestLogger(),
      generator: fakeGenerator({ calls: 0 }),
      model: "test/reasoning-model",
      now: () => new Date(Date.parse("2026-01-12T01:00:00.000Z") + tick++ * 1000),
    });

    await service.runOnce(new Date("2026-01-12T00:00:00.000Z"));

    const run = await db.selectFrom("weekly_mint_runs").selectAll().executeTakeFirstOrThrow();
    const firstEvents = await db
      .selectFrom("weekly_mint_run_events")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
    const kindsFor = (events: typeof firstEvents, name: string) =>
      events.filter((event) => event.company_name === name).map((event) => event.kind);
    expect(firstEvents.every((event) => event.run_id === run.id)).toBe(true);
    expect(kindsFor(firstEvents, "Acme")).toEqual(["claimed", "judged", "verdict_stored"]);
    expect(kindsFor(firstEvents, "Vendorco")).toEqual(["claimed", "vendor_skip"]);
    const verdictRow = await db.selectFrom("project_minting_verdicts").selectAll().executeTakeFirstOrThrow();
    const storedEvent = firstEvents.find((event) => event.kind === "verdict_stored");
    expect(JSON.parse(storedEvent?.detail ?? "{}")).toMatchObject({ verdictId: verdictRow.id, projects: 1 });
    const firstTraces = await db.selectFrom("weekly_mint_traces").selectAll().orderBy("seq", "asc").execute();
    expect(firstTraces.map((trace) => [trace.container_key, trace.seq, trace.kind])).toEqual([
      [corpus.companyId, 1, "prompt"],
      [corpus.companyId, 2, "response"],
      [corpus.companyId, 3, "disposition"],
    ]);
    expect(JSON.parse(firstTraces[0]?.payload ?? "{}").prompt).toContain("Atlas Migration");
    expect(JSON.parse(firstTraces[2]?.payload ?? "{}")).toMatchObject({ verdictId: verdictRow.id });

    const outcome = service.tryRunManual(new Date("2026-01-12T02:00:00.000Z"));
    if (!outcome.started) throw new Error("manual rerun did not start");
    await outcome.completion;

    const rerunEvents = await db
      .selectFrom("weekly_mint_run_events")
      .selectAll()
      .orderBy("created_at", "asc")
      .execute();
    const firstEventIds = new Set(firstEvents.map((event) => event.id));
    expect(rerunEvents.some((event) => firstEventIds.has(event.id))).toBe(false);
    expect(kindsFor(rerunEvents, "Acme")).toEqual(["pending_dossier_skip"]);
    expect(kindsFor(rerunEvents, "Vendorco")).toEqual(["claimed", "vendor_skip"]);
    expect(await db.selectFrom("weekly_mint_traces").selectAll().execute()).toHaveLength(0);
  });
});
