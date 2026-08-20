import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectMintingVerdictRepository } from "../db/repositories/project-minting-verdicts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { type ClusterVerdict, readClusterVerdict } from "./project-minting";
import { acceptProjectMintingVerdict, rejectProjectMintingVerdict } from "./project-minting-acceptance";
import { seedAttendee, seedCompany, seedConnector, seedFile } from "./project-minting-fixtures";
import { WEEKLY_MINT_PROMPT_VERSION, createWeeklyMintService } from "./weekly-mint";

describe("project minting junk retirement", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedCorpus(): Promise<{ companyId: string; fileIds: string[] }> {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Retireco", "retireco.example");
    const fileIds: string[] = [];
    for (const day of ["01", "02", "03"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: `Retireco sync ${day}`,
        source: "fireflies",
        date: `2026-08-${day}T09:00:00.000Z`,
        content: "Keep Work, Junk Work, and Sibling Work updates.",
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", "dana@retireco.example");
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

  async function storeVerdict(companyId: string, fileCount: number, verdict: ClusterVerdict): Promise<string> {
    const stored = await createProjectMintingVerdictRepository(db).storePending({
      companyEntityId: companyId,
      companyName: "Retireco",
      fileCount,
      dossier: "weekly test dossier",
      verdict: JSON.stringify(verdict),
      model: "test/reasoning-model",
      promptVersion: WEEKLY_MINT_PROMPT_VERSION,
      counterpartyKind: verdict.counterpartyKind,
      clientStage: verdict.clientStage,
    });
    return stored.id;
  }

  function weeklyVerdict(projects: ClusterVerdict["projects"]): ClusterVerdict {
    return readClusterVerdict(
      {
        counterpartyKind: "client",
        clientStage: "active",
        engagement: null,
        projects,
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      },
      { strict: true },
    );
  }

  function project(name: string, reviewId: string): ClusterVerdict["projects"][number] {
    return {
      name,
      status: "active",
      confidence: "medium",
      parentName: null,
      evidenceTitleFamilies: ["Retireco sync"],
      evidenceRepos: [],
      evidenceFragments: [],
      coveredReviewIds: [reviewId],
      evidencePeople: [],
    };
  }

  it("junking a project via accept retires covered rows while a sibling stays pooled", async () => {
    const corpus = await seedCorpus();
    const keepReviewId = await seedProjectReview("Keep Work", corpus.fileIds);
    const junkReviewId = await seedProjectReview("Junk Work", corpus.fileIds);
    const siblingReviewId = await seedProjectReview("Sibling Work", corpus.fileIds);
    await db
      .insertInto("weekly_mint_candidates")
      .values([
        { review_id: junkReviewId, company_key: corpus.companyId },
        { review_id: siblingReviewId, company_key: corpus.companyId },
      ])
      .execute();
    const verdictId = await storeVerdict(
      corpus.companyId,
      corpus.fileIds.length,
      weeklyVerdict([
        project("Keep Work", keepReviewId),
        project("Junk Work", junkReviewId),
        project("Sibling Work", siblingReviewId),
      ]),
    );

    await acceptProjectMintingVerdict(db, {
      verdictId,
      actorUserId: "reviewer",
      confirmedCounterpartyKind: "client",
      confirmedClientStage: "active",
      junkReviewIds: [junkReviewId],
      struckProjectNames: ["Sibling Work"],
      logger: createTestLogger(),
    });

    const reviewRows = await db
      .selectFrom("entity_review_queue")
      .select(["id", "status", "retired_reason"])
      .where("id", "in", [keepReviewId, junkReviewId, siblingReviewId])
      .execute();
    const byId = new Map(reviewRows.map((row) => [row.id, row]));
    expect(byId.get(keepReviewId)).toMatchObject({ status: "confirmed", retired_reason: null });
    expect(byId.get(junkReviewId)).toMatchObject({ status: "retired", retired_reason: "weekly_junk" });
    expect(byId.get(siblingReviewId)).toMatchObject({ status: "pending", retired_reason: null });

    const generator: GeminiGenerator = {
      async generate() {
        return "";
      },
      async generateJSON<T>() {
        return { groups: [{ groupKey: siblingReviewId, action: "skip" }] } as T;
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

    const candidates = await db
      .selectFrom("weekly_mint_candidates")
      .select(["review_id", "retired_at", "retired_reason"])
      .where("review_id", "in", [junkReviewId, siblingReviewId])
      .orderBy("review_id", "asc")
      .execute();
    const candidateById = new Map(candidates.map((row) => [row.review_id, row]));
    expect(candidateById.get(junkReviewId)?.retired_reason).toBe("weekly_junk");
    expect(candidateById.get(junkReviewId)?.retired_at).not.toBeNull();
    expect(candidateById.get(siblingReviewId)).toMatchObject({ retired_at: null, retired_reason: null });
  });

  it("accept-vs-reject race lands junk side effects only for the CAS winner", async () => {
    const corpus = await seedCorpus();
    const keepReviewId = await seedProjectReview("Keep Work", corpus.fileIds);
    const junkReviewId = await seedProjectReview("Junk Work", corpus.fileIds);
    await db
      .insertInto("weekly_mint_candidates")
      .values({ review_id: junkReviewId, company_key: corpus.companyId })
      .execute();
    const verdictId = await storeVerdict(
      corpus.companyId,
      corpus.fileIds.length,
      weeklyVerdict([project("Keep Work", keepReviewId), project("Junk Work", junkReviewId)]),
    );

    await Promise.allSettled([
      acceptProjectMintingVerdict(db, {
        verdictId,
        actorUserId: "acceptor",
        confirmedCounterpartyKind: "client",
        confirmedClientStage: "active",
        junkReviewIds: [junkReviewId],
        logger: createTestLogger(),
      }),
      rejectProjectMintingVerdict(db, { verdictId, actorUserId: "rejector" }),
    ]);

    const verdict = await db
      .selectFrom("project_minting_verdicts")
      .select("status")
      .where("id", "=", verdictId)
      .executeTakeFirstOrThrow();
    const junkReview = await db
      .selectFrom("entity_review_queue")
      .select(["status", "retired_reason"])
      .where("id", "=", junkReviewId)
      .executeTakeFirstOrThrow();
    const junkCandidate = await db
      .selectFrom("weekly_mint_candidates")
      .select(["retired_at", "retired_reason"])
      .where("review_id", "=", junkReviewId)
      .executeTakeFirstOrThrow();

    if (verdict.status === "accepted") {
      expect(junkReview).toMatchObject({ status: "retired", retired_reason: "weekly_junk" });
      expect(junkCandidate.retired_reason).toBe("weekly_junk");
      expect(junkCandidate.retired_at).not.toBeNull();
    } else {
      expect(verdict.status).toBe("rejected");
      expect(junkReview).toMatchObject({ status: "pending", retired_reason: null });
      expect(junkCandidate).toMatchObject({ retired_at: null, retired_reason: null });
    }
  });
});
