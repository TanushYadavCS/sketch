import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompanyRelationshipDeclarationRepository } from "../db/repositories/company-relationship-declarations";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import { readClusterVerdict, runProjectMintingPass } from "./project-minting";
import {
  acceptanceBody,
  generatorFor,
  loginAsAdmin,
  seedAttendee,
  seedCompany,
  seedConnector,
  seedFile,
  seedMention,
  seedProjectFragment,
  seedTaskWithFileEvidence,
} from "./project-minting-fixtures";

/**
 * PR-3: the content recurrence scan and what it feeds — retro-claim at
 * accept (stored mentions undercount content 5-6x) and the scan-ranked
 * candidate section with its below-floor second chance.
 */
const logger = createTestLogger();

describe("project minting content scan", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestPgDb();
    app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger });
    cookie = await loginAsAdmin(db, app);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("retro-claims content-recurring files at accept: one stored mention, six content matches, all claimed with mentions and a left-censored window", async () => {
    const seeded = await seedLangraphCluster(db);
    const { verdictId } = await acceptLangraphVerdict(db, app, cookie, seeded);

    const response = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "active")),
    });
    const body = (await response.json()) as {
      acceptance: {
        entities: {
          name: string;
          id: string;
          fileIds: string[];
          retroClaim?: { filesClaimed: number; tasksReparented: number };
          activeSinceAtLeast?: string | null;
        }[];
      };
    };
    expect(response.status).toBe(200);
    const langraph = body.acceptance.entities.find((entity) => entity.name === "Langraph");
    expect(langraph).toBeDefined();
    expect(langraph?.retroClaim?.filesClaimed).toBe(6);
    expect(langraph?.fileIds.sort()).toEqual([seeded.mentionFileId, ...seeded.workingFileIds].sort());
    expect(langraph?.activeSinceAtLeast).toBe("2026-07-01");

    const mentions = await db
      .selectFrom("entity_mentions")
      .select("indexed_file_id")
      .where("entity_id", "=", langraph?.id ?? "")
      .execute();
    const mentionedFiles = new Set(mentions.map((row) => row.indexed_file_id));
    for (const fileId of seeded.workingFileIds) expect(mentionedFiles.has(fileId)).toBe(true);
  });

  it("re-parents an orphan task whose only evidence file was scan-claimed, recording the project as task evidence", async () => {
    const seeded = await seedLangraphCluster(db);
    const taskId = "task-langraph-orphan";
    await seedTaskWithFileEvidence(db, taskId, seeded.workingFileIds[0]);
    const { verdictId } = await acceptLangraphVerdict(db, app, cookie, seeded);

    const response = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "active")),
    });
    const body = (await response.json()) as {
      acceptance: { entities: { name: string; id: string; retroClaim?: { tasksReparented: number } }[] };
    };
    expect(response.status).toBe(200);
    const langraph = body.acceptance.entities.find((entity) => entity.name === "Langraph");
    expect(langraph?.retroClaim?.tasksReparented).toBe(1);

    const task = await db
      .selectFrom("tasks")
      .select("parent_entity_id")
      .where("id", "=", taskId)
      .executeTakeFirstOrThrow();
    expect(task.parent_entity_id).toBe(langraph?.id);
    const why = await db
      .selectFrom("task_evidence")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("kind", "=", "entity")
      .where("ref_id", "=", langraph?.id ?? "")
      .execute();
    expect(why).toHaveLength(1);
  });

  it("gives a below-floor singleton a second chance only when its name recurs in content: 3 scan days joins the candidate section, 1 day stays out", async () => {
    await seedScanCandidateCluster(db);
    const pass = await runProjectMintingPass({
      db,
      logger,
      generator: generatorFor(() =>
        readClusterVerdict(
          {
            counterpartyKind: "client",
            clientStage: "active",
            engagement: null,
            projects: [
              {
                name: "Scancorp Account",
                status: "active",
                confidence: "high",
                parentName: null,
                evidenceTitleFamilies: ["Scancorp Weekly"],
                evidenceRepos: [],
                evidencePeople: [],
                evidenceFragments: [],
              },
            ],
            existingEntities: [],
            trackerFit: "containers_hold_clusters",
            notes: [],
          },
          { strict: true },
        ),
      ),
      model: "test/reasoning-model",
    });
    expect(pass.results).toHaveLength(1);
    const verdictId = pass.results[0].verdictId;
    expect(verdictId).toBeDefined();

    const response = await app.request(`/api/project-minting/verdicts/${verdictId}`, {
      headers: { Cookie: cookie },
    });
    const body = (await response.json()) as { verdict: { dossier: string } };
    expect(response.status).toBe(200);
    const candidateSection = body.verdict.dossier.split("## Candidate workstreams")[1].split("## Event line")[0];
    expect(candidateSection).toContain("tokens [langraph]");
    expect(candidateSection).toContain("recurs in content on 3 distinct days");
    expect(candidateSection).not.toContain("junkword");
  });
});

/**
 * One cluster where content reality dwarfs the stored graph: the Langraph
 * fragment holds a single mention, while six more working sessions discuss
 * langraph in content only, one per day from 2026-07-01.
 */
async function seedLangraphCluster(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const companyId = await seedCompany(db, "Habuild", "habuild.com");
  for (const date of ["2026-07-10", "2026-07-17"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "Habuild Weekly",
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Weekly sync.",
    });
    await seedAttendee(db, connectorId, fileId, "Beetu Lead", "beetu@habuild.com");
  }
  const workingFileIds: string[] = [];
  for (let index = 0; index < 6; index++) {
    const fileId = await seedFile(db, connectorId, {
      fileName: `Working session ${index + 1}`,
      source: "fireflies",
      date: `2026-07-0${index + 1}T10:00:00Z`,
      content: "Progress on the langraph pipeline continued.",
    });
    await seedAttendee(db, connectorId, fileId, "Beetu Lead", "beetu@habuild.com");
    workingFileIds.push(fileId);
  }
  const mentionFileId = await seedFile(db, connectorId, {
    fileName: "Langraph kickoff",
    source: "fireflies",
    date: "2026-07-08T10:00:00Z",
    content: "Langraph pipeline kickoff.",
  });
  await seedAttendee(db, connectorId, mentionFileId, "Beetu Lead", "beetu@habuild.com");
  const fragmentId = await seedProjectFragment(db, "Langraph");
  await seedMention(db, fragmentId, mentionFileId);
  return { companyId, workingFileIds, mentionFileId, fragmentId };
}

async function acceptLangraphVerdict(
  db: Kysely<DB>,
  app: ReturnType<typeof createApp>,
  _cookie: string,
  seeded: Awaited<ReturnType<typeof seedLangraphCluster>>,
) {
  await createCompanyRelationshipDeclarationRepository(db).declare({
    subjectEntityId: seeded.companyId,
    counterpartyKind: "client",
    clientStage: "active",
  });
  const verdict = readClusterVerdict(
    {
      counterpartyKind: "client",
      clientStage: "active",
      engagement: null,
      projects: [
        {
          name: "Habuild Account",
          status: "active",
          confidence: "high",
          parentName: null,
          evidenceTitleFamilies: ["Habuild Weekly"],
          evidenceRepos: [],
          evidencePeople: [],
          evidenceFragments: [],
        },
        {
          name: "Langraph",
          status: "active",
          confidence: "high",
          parentName: "Habuild Account",
          evidenceTitleFamilies: [],
          evidenceRepos: [],
          evidencePeople: [],
          evidenceFragments: [seeded.fragmentId],
        },
      ],
      existingEntities: [
        { entityId: seeded.fragmentId, name: "Langraph", disposition: "merge_into" as const, mergeInto: "Langraph" },
      ],
      trackerFit: "containers_hold_clusters",
      notes: [],
    },
    { strict: true },
  );
  const pass = await runProjectMintingPass({
    db,
    logger,
    generator: generatorFor(() => verdict),
    model: "test/reasoning-model",
  });
  expect(pass.results).toHaveLength(1);
  const verdictId = pass.results[0].verdictId;
  expect(verdictId).toBeDefined();
  return { verdictId };
}

/**
 * Two below-structural-floor singleton fragments, distinguished only by
 * content: "Langraph" recurs on 3 distinct days, "Junkword" on 1. Neutral
 * file names keep singleton-title support at zero so the scan alone decides.
 */
async function seedScanCandidateCluster(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const companyId = await seedCompany(db, "Scancorp", "scancorp.io");
  for (const date of ["2026-07-01", "2026-07-08"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "Scancorp Weekly",
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Weekly sync.",
    });
    await seedAttendee(db, connectorId, fileId, "Sam Founder", "sam@scancorp.io");
  }
  const langraphFiles: string[] = [];
  for (const [index, date] of ["2026-07-02", "2026-07-09", "2026-07-16"].entries()) {
    const fileId = await seedFile(db, connectorId, {
      fileName: `Working session ${index + 1}`,
      source: "fireflies",
      date: `${date}T10:00:00Z`,
      content: "The langraph pipeline moved forward.",
    });
    await seedAttendee(db, connectorId, fileId, "Sam Founder", "sam@scancorp.io");
    langraphFiles.push(fileId);
  }
  const junkFileId = await seedFile(db, connectorId, {
    fileName: "One-off note",
    source: "fireflies",
    date: "2026-07-03T10:00:00Z",
    content: "A junkword appeared once.",
  });
  await seedAttendee(db, connectorId, junkFileId, "Sam Founder", "sam@scancorp.io");
  const langraphFragmentId = await seedProjectFragment(db, "Langraph");
  const junkFragmentId = await seedProjectFragment(db, "Junkword");
  await seedMention(db, langraphFragmentId, langraphFiles[0]);
  await seedMention(db, junkFragmentId, junkFileId);
  return { companyId, langraphFragmentId, junkFragmentId, langraphFiles, junkFileId };
}
