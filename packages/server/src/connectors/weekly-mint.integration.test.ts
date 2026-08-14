import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { readClusterVerdict } from "./project-minting";
import { seedAttendee, seedCompany, seedConnector, seedFile } from "./project-minting-fixtures";
import { WEEKLY_MINT_PROMPT_VERSION, WeeklyMintProcessCrash, createWeeklyMintService } from "./weekly-mint";

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
});
