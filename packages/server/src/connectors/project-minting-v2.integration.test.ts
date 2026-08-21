import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompanyRelationshipDeclarationRepository } from "../db/repositories/company-relationship-declarations";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import { type ClusterVerdict, readClusterVerdict, runProjectMintingPass } from "./project-minting";
import {
  acceptanceBody,
  generatorFor,
  loadEntities,
  loginAsAdmin,
  seedAttendee,
  seedCompany,
  seedConnector,
  seedFile,
  seedMention,
  seedProjectFragment,
} from "./project-minting-fixtures";

/**
 * The one-noun (v2) verdict contract: recursive parentName forests, fragment
 * ids as a fourth anchor kind, strict parse at store time, and the candidacy
 * floor in the stored dossier. The engagement-era contract stays pinned in
 * project-minting-acceptance.integration.test.ts.
 */
const logger = createTestLogger();

describe("project minting v2 verdicts", () => {
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

  it("accepts a nested verdict: child part_of parent, top-level engagement_for company, fragment evidence lands files on the child, no engagement entity", async () => {
    const seeded = await seedNestedCluster(db);
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
            name: "Oliver Wyman Account",
            status: "active",
            confidence: "high",
            parentName: null,
            evidenceTitleFamilies: ["OW <> Canvas Standup"],
            evidenceRepos: [],
            evidencePeople: [],
            evidenceFragments: [],
          },
          {
            name: "OW Dashboard",
            status: "active",
            confidence: "high",
            parentName: "Oliver Wyman Account",
            evidenceTitleFamilies: [],
            evidenceRepos: [],
            evidencePeople: [],
            evidenceFragments: [seeded.fragmentId],
          },
        ],
        existingEntities: [
          {
            entityId: seeded.fragmentId,
            name: "Dashboard Fragment",
            disposition: "merge_into" as const,
            mergeInto: "OW Dashboard",
          },
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

    const dryResponse = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...acceptanceBody("client", "active"), dryRun: true }),
    });
    const dryBody = (await dryResponse.json()) as { acceptance: { dryRun?: boolean; entities: { name: string }[] } };
    expect(dryResponse.status).toBe(200);
    expect(dryBody.acceptance.dryRun).toBe(true);
    expect(dryBody.acceptance.entities.map((entity) => entity.name).sort()).toEqual([
      "OW Dashboard",
      "Oliver Wyman Account",
    ]);
    const afterDryRun = await db
      .selectFrom("project_minting_verdicts")
      .select("status")
      .where("id", "=", verdictId ?? "")
      .executeTakeFirstOrThrow();
    expect(afterDryRun.status).toBe("pending");
    expect(await countAcceptanceRelationships(db)).toBe(0);

    const response = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "active")),
    });
    const body = (await response.json()) as {
      acceptance: {
        entityIds: { engagementId: string | null; projectIds: string[] };
        entities: { id: string; name: string; kind: string; parentId: string | null; fileIds: string[] }[];
      };
    };
    expect(response.status).toBe(200);
    expect(body.acceptance.entityIds.engagementId).toBeNull();
    expect(body.acceptance.entityIds.projectIds).toHaveLength(2);
    expect(body.acceptance.entities.every((entity) => entity.kind === "project")).toBe(true);

    const account = body.acceptance.entities.find((entity) => entity.name === "Oliver Wyman Account");
    const dashboard = body.acceptance.entities.find((entity) => entity.name === "OW Dashboard");
    expect(account).toBeDefined();
    expect(dashboard).toBeDefined();
    expect(account?.parentId).toBeNull();
    expect(dashboard?.parentId).toBe(account?.id);
    expect(dashboard?.fileIds).toEqual([...seeded.dashboardFileIds].sort());
    expect(account?.fileIds).toEqual([...seeded.standupFileIds, seeded.residualFileId].sort());

    const engagementRows = await db.selectFrom("entities").select("id").where("subtype", "=", "engagement").execute();
    expect(engagementRows).toHaveLength(0);
    const relationships = await db
      .selectFrom("entity_relationships")
      .select(["source_entity_id", "target_entity_id", "relationship_type"])
      .where("source", "=", "project_minting_acceptance")
      .execute();
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: account?.id,
          target_entity_id: seeded.companyId,
          relationship_type: "engagement_for",
        }),
        expect.objectContaining({
          source_entity_id: dashboard?.id,
          target_entity_id: account?.id,
          relationship_type: "part_of",
        }),
      ]),
    );
    const [fragment] = await loadEntities(db, [seeded.fragmentId]);
    expect(fragment.deleted_at).not.toBeNull();
    expect(fragment.merged_into_entity_id).toBe(dashboard?.id);
  });

  it("rejects a verdict whose parent chain cycles at store time: pass records the error and no verdict row exists", async () => {
    await seedTriggeredCluster(db, "Cyclecorp", "cyclecorp.io", "Cyclecorp Sync");
    const pass = await runProjectMintingPass({
      db,
      logger,
      generator: generatorFor(
        () =>
          ({
            counterpartyKind: "client",
            clientStage: "active",
            engagement: null,
            projects: [
              { name: "Alpha", status: "active", confidence: "high", parentName: "Beta" },
              { name: "Beta", status: "active", confidence: "high", parentName: "Alpha" },
            ],
            existingEntities: [],
            trackerFit: "containers_hold_clusters",
            notes: [],
          }) as unknown as ClusterVerdict,
      ),
      model: "test/reasoning-model",
    });

    expect(pass.results).toHaveLength(1);
    expect(pass.results[0].verdictId).toBeUndefined();
    expect(pass.results[0].error).toMatch(/cycle/i);
    const rows = await db.selectFrom("project_minting_verdicts").select("id").execute();
    expect(rows).toHaveLength(0);
  });

  it("stores the candidacy floor in the dossier: a crossing fragment group is a candidate workstream, below-floor groups are not", async () => {
    const seeded = await seedFragmentGroupCluster(db);
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
                name: "Fragmentia Account",
                status: "active",
                confidence: "high",
                parentName: null,
                evidenceTitleFamilies: ["Fragmentia Weekly"],
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
    const body = (await response.json()) as { verdict: { dossier: string; schemaV2: boolean; promptVersion: string } };
    expect(response.status).toBe(200);
    expect(body.verdict.schemaV2).toBe(true);
    expect(body.verdict.dossier).toContain("## Candidate workstreams");
    const candidateSection = body.verdict.dossier.split("## Candidate workstreams")[1].split("## Event line")[0];
    expect(candidateSection).toContain("tokens [nutrition]");
    expect(candidateSection).toContain(`"Nutrition Tracker" [id: ${seeded.trackerFragmentId}]`);
    expect(candidateSection).toContain(`"Nutrition Coach" [id: ${seeded.coachFragmentId}]`);
    expect(candidateSection).not.toContain("Billing Portal");
    expect(candidateSection).not.toContain("Langraph Spike");
  });
});

async function countAcceptanceRelationships(db: Kysely<DB>): Promise<number> {
  const rows = await db
    .selectFrom("entity_relationships")
    .select("id")
    .where("source", "=", "project_minting_acceptance")
    .execute();
  return rows.length;
}

async function seedNestedCluster(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const companyId = await seedCompany(db, "Oliver Wyman", "oliverwyman.com");
  const dashboardFileIds: string[] = [];
  for (const date of ["2026-07-01", "2026-07-08", "2026-07-15"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "OW Dashboard Sync",
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Dashboard build continues with Maya leading.",
    });
    await seedAttendee(db, connectorId, fileId, "Maya Lead", "maya@oliverwyman.com");
    dashboardFileIds.push(fileId);
  }
  const standupFileIds: string[] = [];
  for (const date of ["2026-07-03", "2026-07-10"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "OW <> Canvas Standup",
      source: "google_calendar",
      date: `${date}T08:00:00Z`,
      content: "Account-level standup covering all workstreams.",
    });
    await seedAttendee(db, connectorId, fileId, "Asha Account", "asha@oliverwyman.com");
    standupFileIds.push(fileId);
  }
  const residualFileId = await seedFile(db, connectorId, {
    fileName: "Misc planning thread",
    source: "fireflies",
    date: "2026-07-20T12:00:00Z",
    content: "Loose planning notes not tied to any workstream.",
  });
  await seedAttendee(db, connectorId, residualFileId, "Asha Account", "asha@oliverwyman.com");
  const fragmentId = await seedProjectFragment(db, "Dashboard Fragment");
  for (const fileId of dashboardFileIds) await seedMention(db, fragmentId, fileId);
  return { companyId, dashboardFileIds, standupFileIds, residualFileId, fragmentId };
}

async function seedTriggeredCluster(db: Kysely<DB>, name: string, domain: string, title: string): Promise<string> {
  const connectorId = await seedConnector(db);
  const companyId = await seedCompany(db, name, domain);
  for (const date of ["2026-07-01", "2026-07-08", "2026-07-15"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: title,
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Recurring sync.",
    });
    await seedAttendee(db, connectorId, fileId, "Casey Lead", `casey@${domain}`);
  }
  return companyId;
}

/**
 * Four owned fragments in one cluster: "Nutrition Tracker" + "Nutrition
 * Coach" share the distinctive token and cross the candidacy floor (2
 * fragments); "Billing Portal" and "Langraph Spike" each sit alone on one
 * file and stay below it. Four names keep "nutrition" under the corpus
 * stoplist threshold (must appear in more than half the names to be
 * stopped).
 */
async function seedFragmentGroupCluster(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const companyId = await seedCompany(db, "Fragmentia", "fragmentia.io");
  for (const date of ["2026-07-01", "2026-07-08"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "Fragmentia Weekly",
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Weekly sync.",
    });
    await seedAttendee(db, connectorId, fileId, "Sam Founder", "sam@fragmentia.io");
  }
  const fragmentFiles: string[] = [];
  for (const [index, fileName] of [
    "Tracker deep dive",
    "Coach walkthrough",
    "Invoices review",
    "Spike readout",
  ].entries()) {
    const fileId = await seedFile(db, connectorId, {
      fileName,
      source: "fireflies",
      date: `2026-07-2${index}T10:00:00Z`,
      content: "Working session.",
    });
    await seedAttendee(db, connectorId, fileId, "Sam Founder", "sam@fragmentia.io");
    fragmentFiles.push(fileId);
  }
  const trackerFragmentId = await seedProjectFragment(db, "Nutrition Tracker");
  const coachFragmentId = await seedProjectFragment(db, "Nutrition Coach");
  const billingFragmentId = await seedProjectFragment(db, "Billing Portal");
  const langraphFragmentId = await seedProjectFragment(db, "Langraph Spike");
  await seedMention(db, trackerFragmentId, fragmentFiles[0]);
  await seedMention(db, coachFragmentId, fragmentFiles[1]);
  await seedMention(db, billingFragmentId, fragmentFiles[2]);
  await seedMention(db, langraphFragmentId, fragmentFiles[3]);
  return { companyId, trackerFragmentId, coachFragmentId, billingFragmentId, langraphFragmentId };
}
