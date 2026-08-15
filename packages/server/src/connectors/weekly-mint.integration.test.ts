import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { readClusterVerdict } from "./project-minting";
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

async function seedProjectEntity(db: Kysely<DB>, name: string, aliases: string[]): Promise<string> {
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
        { date: "2026-01-05", content: "Atlas Migration kickoff and plan." },
        { date: "2026-01-06", content: "Atlas Migration implementation update." },
        { date: "2026-01-07", content: "Atlas Migration delivery review." },
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
    expect(
      readClusterVerdict(JSON.parse(verdicts[0]?.verdict ?? "{}"), { strict: true }).projects[0]?.evidenceFragments,
    ).toEqual([reviewId]);

    await service.runOnce(new Date("2026-01-19T00:00:00.000Z"));
    expect(counter.calls).toBe(1);
    expect(await db.selectFrom("project_minting_verdicts").selectAll().execute()).toHaveLength(1);
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
    expect(project?.evidenceFragments).toEqual([reviewId]);
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
    const oneStopId = await seedProjectEntity(db, "One Stop", []);
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

  it("aliases only the exact-matching candidate and still mints its group-mate", async () => {
    const corpus = await seedClientCorpus(db, {
      files: [
        { date: "2026-05-04", content: "Atlas phase two planning." },
        { date: "2026-05-05", content: "Atlas phase two iteration." },
        { date: "2026-05-06", content: "Atlas phase two wrap." },
        { date: "2026-05-04", content: "Atlas rollout sync." },
      ],
    });
    const atlasId = await seedProjectEntity(db, "Atlas", ["Atlas Rollout"]);
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
});
