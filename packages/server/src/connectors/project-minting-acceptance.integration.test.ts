import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompanyRelationshipDeclarationRepository } from "../db/repositories/company-relationship-declarations";
import { createProjectMintingVerdictRepository } from "../db/repositories/project-minting-verdicts";
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
  seedTaskWithFileEvidence,
} from "./project-minting-fixtures";
import { WEEKLY_MINT_PROMPT_VERSION } from "./weekly-mint";

/**
 * These suites pin the engagement-era verdict contract: rows stored before
 * the one-noun schema must keep accepting exactly as they always did. The v2
 * contract has its own suite (project-minting-v2.integration.test.ts).
 */
const LEGACY_PROMPT_VERSION = "project-minting-verdict-v2";

const logger = createTestLogger();

describe("project minting verdict acceptance", () => {
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

  it("writes nothing until accept, then writes engagement, projects, merges, attachments and task parents", async () => {
    const seeded = await seedOliverWymanCluster(db);
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: seeded.companyId,
      counterpartyKind: "client",
      clientStage: "active",
    });
    const verdict = readClusterVerdict({
      counterpartyKind: "client",
      clientStage: "active",
      engagement: { name: "Oliver Wyman" },
      projects: [
        {
          name: "OW Dashboard",
          status: "active",
          confidence: "high",
          evidenceTitleFamilies: ["OW Dashboard Sync"],
          evidenceRepos: ["github.com/canvasxai/ow-dashboard"],
          evidencePeople: ["Maya Lead"],
        },
        {
          name: "OW Segmentation",
          status: "active",
          confidence: "high",
          evidenceTitleFamilies: ["OW Segmentation Standup"],
          evidenceRepos: ["github.com/canvasxai/ow-segmentation"],
          evidencePeople: ["Ravi Lead"],
        },
      ],
      existingEntities: seeded.fragmentIds.map((entityId, index) => ({
        entityId,
        name: `Fragment ${index + 1}`,
        disposition: "merge_into" as const,
        mergeInto: index === 0 ? "OW Dashboard" : "OW Segmentation",
      })),
      trackerFit: "containers_hold_clusters",
      notes: [],
    });
    const beforeFragments = await loadEntities(db, seeded.fragmentIds);
    const generator = generatorFor(() => verdict);

    const pass = await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });

    expect(pass.results).toHaveLength(1);
    expect(pass.results[0].verdictId).toBeDefined();
    expect(await countProjectMintingSourceRefs(db)).toBe(0);
    expect(await loadEntities(db, seeded.fragmentIds)).toEqual(beforeFragments);
    const pending = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("status", "=", "pending")
      .where("superseded_at", "is", null)
      .execute();
    expect(pending).toHaveLength(1);
    expect(
      readClusterVerdict(JSON.parse(pending[0].verdict))
        .projects.map((p) => p.name)
        .sort(),
    ).toEqual(["OW Dashboard", "OW Segmentation"]);

    const response = await app.request(`/api/project-minting/verdicts/${pass.results[0].verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "active")),
    });
    const body = (await response.json()) as {
      acceptance: { entityIds: { engagementId: string; projectIds: string[] }; mergeIds: string[] };
    };

    expect(response.status).toBe(200);
    expect(body.acceptance.entityIds.projectIds).toHaveLength(2);
    expect(body.acceptance.mergeIds).toHaveLength(3);
    const engagement = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", body.acceptance.entityIds.engagementId)
      .executeTakeFirstOrThrow();
    expect(engagement).toMatchObject({ name: "Oliver Wyman", source_type: "project", subtype: "engagement" });
    const projects = await db
      .selectFrom("entities")
      .select(["id", "name", "project_lifecycle_status"])
      .where("id", "in", body.acceptance.entityIds.projectIds)
      .orderBy("name", "asc")
      .execute();
    expect(projects).toEqual([
      expect.objectContaining({ name: "OW Dashboard", project_lifecycle_status: "active" }),
      expect.objectContaining({ name: "OW Segmentation", project_lifecycle_status: "active" }),
    ]);
    const relationships = await db
      .selectFrom("entity_relationships")
      .select(["source_entity_id", "target_entity_id", "relationship_type"])
      .where("source", "=", "project_minting_acceptance")
      .execute();
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: engagement.id,
          target_entity_id: seeded.companyId,
          relationship_type: "engagement_for",
        }),
        ...projects.map((project) =>
          expect.objectContaining({
            source_entity_id: project.id,
            target_entity_id: engagement.id,
            relationship_type: "part_of",
          }),
        ),
      ]),
    );
    const fragments = await loadEntities(db, seeded.fragmentIds);
    for (const fragment of fragments) {
      expect(fragment.deleted_at).not.toBeNull();
      expect(body.acceptance.entityIds.projectIds).toContain(fragment.merged_into_entity_id);
    }
    const ledgers = await db
      .selectFrom("entity_merges")
      .select(["id", "moves"])
      .where("group_id", "=", `project-minting:${pass.results[0].verdictId}`)
      .execute();
    expect(ledgers).toHaveLength(3);
    expect(ledgers.some((row) => row.moves.includes("entity_mentions"))).toBe(true);
    const standupMentions = await db
      .selectFrom("entity_mentions")
      .select("entity_id")
      .where("indexed_file_id", "=", seeded.standupFileId)
      .execute();
    expect(standupMentions.map((row) => row.entity_id)).toContain(engagement.id);
    const taskRows = await db
      .selectFrom("tasks")
      .select(["id", "parent_entity_id"])
      .where("id", "in", [seeded.dashboardTaskId, seeded.standupTaskId])
      .orderBy("id", "asc")
      .execute();
    expect(taskRows).toEqual([
      { id: seeded.dashboardTaskId, parent_entity_id: projects.find((p) => p.name === "OW Dashboard")?.id },
      { id: seeded.standupTaskId, parent_entity_id: engagement.id },
    ]);
    const accepted = await db
      .selectFrom("project_minting_verdicts")
      .select(["status", "accepted_result"])
      .where("id", "=", pass.results[0].verdictId ?? "")
      .executeTakeFirstOrThrow();
    expect(accepted.status).toBe("accepted");
    expect(accepted.accepted_result).toContain("live_recompute");
  });

  it("accepts a vendor as no-write while a lead with a work object mints one proposed project", async () => {
    const seeded = await seedVendorAndPraevorium(db);
    /**
     * The vendor verdict deliberately *proposes* an engagement and a project. An
     * empty `projects` array would assert the fixture back at itself — the state
     * gate is never reached, and dropping `"vendor"` from the suppression list
     * leaves every assertion in this test green. Verified by mutation.
     */
    const vendorVerdict = readClusterVerdict({
      counterpartyKind: "vendor",
      clientStage: null,
      engagement: { name: "Pozitivpartners" },
      projects: [
        {
          name: "Pozitivpartners payroll run",
          status: "active",
          confidence: "high",
          evidenceTitleFamilies: ["Pozitivpartners payroll"],
          evidenceRepos: [],
          evidencePeople: ["Sam Founder"],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: ["Recurring payroll administration."],
    });
    const praevoriumVerdict = readClusterVerdict({
      counterpartyKind: "client",
      clientStage: "prospect",
      engagement: { name: "Praevorium" },
      projects: [
        {
          name: "Praevorium deployment",
          status: "proposed",
          confidence: "medium",
          evidenceTitleFamilies: ["Praevorium proposal discussion", "Praevorium cost estimate"],
          evidenceRepos: [],
          evidencePeople: ["Sam Founder"],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: [],
    });
    const generator = generatorFor((prompt) =>
      prompt.includes("Pozitivpartners") ? vendorVerdict : praevoriumVerdict,
    );

    await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const vendorResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.vendorId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("vendor")),
      },
    );
    expect(vendorResponse.status).toBe(200);
    expect(await countProjectMintingSourceRefs(db)).toBe(0);
    const declaration = await createCompanyRelationshipDeclarationRepository(db).list();
    expect(declaration).toEqual([
      expect.objectContaining({
        subject_entity_id: seeded.vendorId,
        counterparty_kind: "vendor",
        client_stage: null,
      }),
    ]);
    const vendorRow = await db
      .selectFrom("project_minting_verdicts")
      .select("status")
      .where("id", "=", byCompany.get(seeded.vendorId)?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(vendorRow.status).toBe("accepted");

    const pursuitResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.praevoriumId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "prospect")),
      },
    );
    expect(pursuitResponse.status).toBe(200);
    const projects = await db
      .selectFrom("entities")
      .select(["name", "subtype", "project_lifecycle_status"])
      .where("source_type", "=", "project")
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .execute();
    expect(projects).toEqual([
      expect.objectContaining({
        name: "Praevorium deployment",
        subtype: null,
        project_lifecycle_status: "proposed",
      }),
    ]);
  });

  it("accepts a lead with no projects as a decided no-write verdict in the same run as a positive control", async () => {
    const seeded = await seedLeadNoProjectAndPraevorium(db);
    const acmeVerdict = readClusterVerdict({
      counterpartyKind: "client",
      clientStage: "prospect",
      engagement: null,
      projects: [],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: ["Demos only."],
    });
    const praevoriumVerdict = readClusterVerdict({
      counterpartyKind: "client",
      clientStage: "prospect",
      engagement: null,
      projects: [
        {
          name: "Praevorium deployment",
          status: "proposed",
          confidence: "medium",
          evidenceTitleFamilies: ["Praevorium proposal discussion"],
          evidenceRepos: [],
          evidencePeople: ["Sam Founder"],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: [],
    });
    const generator = generatorFor((prompt) => (prompt.includes("Acmecorp") ? acmeVerdict : praevoriumVerdict));

    await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const acmeResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.acmeId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "prospect")),
      },
    );
    expect(acmeResponse.status).toBe(200);
    expect(await countProjectMintingSourceRefs(db)).toBe(0);
    const acmeRow = await db
      .selectFrom("project_minting_verdicts")
      .select("status")
      .where("id", "=", byCompany.get(seeded.acmeId)?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(acmeRow.status).toBe("accepted");

    const controlResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.praevoriumId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "prospect")),
      },
    );
    expect(controlResponse.status).toBe(200);
    expect(await countProjectMintingSourceRefs(db)).toBe(1);
  });

  it("obeys confirmed axes instead of the nomination for vendor, active, and dormant accepts", async () => {
    const connectorId = await seedConnector(db);
    const vendorId = await seedClientCluster(db, connectorId, "Correctvendor", "correctvendor.example");
    const activeId = await seedClientCluster(db, connectorId, "Correctactive", "correctactive.example");
    const dormantId = await seedClientCluster(db, connectorId, "Correctdormant", "correctdormant.example");
    const nominatedActiveVerdict = readClusterVerdict({
      counterpartyKind: "client",
      clientStage: "active",
      engagement: { name: "Corrected account" },
      projects: [
        {
          name: "Corrected deployment",
          status: "active",
          confidence: "high",
          evidenceTitleFamilies: ["Correction deployment sync"],
          evidenceRepos: [],
          evidencePeople: ["Casey Lead"],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: [],
    });
    const generator = generatorFor(() => nominatedActiveVerdict);

    await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const vendorResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(vendorId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("vendor")),
      },
    );
    const vendorBody = (await vendorResponse.json()) as {
      acceptance: { entityIds: { engagementId: string | null; projectIds: string[] }; droppedByGate: unknown };
    };
    expect(vendorResponse.status).toBe(200);
    expect(vendorBody.acceptance.entityIds).toEqual({ engagementId: null, projectIds: [] });
    expect(vendorBody.acceptance.droppedByGate).toEqual({
      engagement: "Corrected account",
      projects: ["Corrected deployment"],
      unmergedFragments: [],
    });
    expect(await countProjectMintingSourceRefs(db)).toBe(0);
    await expectDeclaration(db, vendorId, "vendor", null);

    const activeResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(activeId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "active")),
      },
    );
    const activeBody = (await activeResponse.json()) as {
      acceptance: { entityIds: { engagementId: string | null; projectIds: string[] } };
    };
    expect(activeResponse.status).toBe(200);
    expect(activeBody.acceptance.entityIds.engagementId).not.toBeNull();
    expect(activeBody.acceptance.entityIds.projectIds).toHaveLength(1);
    expect(await countProjectMintingSourceRefs(db)).toBe(2);

    const dormantResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(dormantId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "dormant")),
      },
    );
    const dormantBody = (await dormantResponse.json()) as {
      acceptance: { entityIds: { engagementId: string | null; projectIds: string[] }; droppedByGate: unknown };
    };
    expect(dormantResponse.status).toBe(200);
    expect(dormantBody.acceptance.entityIds).toEqual({ engagementId: null, projectIds: [] });
    expect(dormantBody.acceptance.droppedByGate).toEqual({
      engagement: "Corrected account",
      projects: ["Corrected deployment"],
      unmergedFragments: [],
    });
    expect(await countProjectMintingSourceRefs(db)).toBe(2);
    await expectDeclaration(db, dormantId, "client", "dormant");
  });

  it("accepts a stage-change nomination when the registry matches the generation snapshot", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedClientCluster(db, connectorId, "Dormantresume", "dormantresume.example");
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "dormant",
    });
    const generator = generatorFor(() =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "active",
        engagement: { name: "Dormantresume account" },
        projects: [
          {
            name: "Dormantresume deployment",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Correction deployment sync"],
            evidenceRepos: [],
            evidencePeople: ["Casey Lead"],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    const pass = await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    const row = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("id", "=", pass.results[0].verdictId ?? "")
      .executeTakeFirstOrThrow();
    expect(row.declared_counterparty_kind).toBe("client");
    expect(row.declared_client_stage).toBe("dormant");

    const response = await app.request(`/api/project-minting/verdicts/${pass.results[0].verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "active")),
    });

    expect(response.status).toBe(200);
    await expectDeclaration(db, companyId, "client", "active");
  });

  it("refuses a verdict when the registry stage changed after generation", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedClientCluster(db, connectorId, "Stalestage", "stalestage.example");
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "active",
    });
    const generator = generatorFor(() =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "active",
        engagement: { name: "Stalestage account" },
        projects: [
          {
            name: "Stalestage deployment",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Correction deployment sync"],
            evidenceRepos: [],
            evidencePeople: ["Casey Lead"],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    const pass = await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "dormant",
    });
    const response = await app.request(`/api/project-minting/verdicts/${pass.results[0].verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "active")),
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("STALE_VERDICT");
    expect(await countProjectMintingSourceRefs(db)).toBe(0);
  });

  it("enforces stage container shape by dropping below-ceiling containers and refusing missing required shape", async () => {
    const connectorId = await seedConnector(db);
    const prospectId = await seedClientCluster(db, connectorId, "Shapeprospect", "shapeprospect.example");
    const pilotId = await seedClientCluster(db, connectorId, "Shapepilot", "shapepilot.example");
    const activeId = await seedClientCluster(db, connectorId, "Shapeactive", "shapeactive.example");
    const fragmentId = await seedProjectFragment(db, "Shape account fragment");
    const generator = generatorFor((prompt) =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "active",
        engagement: prompt.includes("Shapeactive") ? null : { name: "Shape account" },
        projects: [
          {
            name: "Shape deployment",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Correction deployment sync"],
            evidenceRepos: [],
            evidencePeople: ["Casey Lead"],
          },
        ],
        existingEntities: [
          {
            entityId: fragmentId,
            name: "Shape account fragment",
            disposition: "merge_into",
            mergeInto: "Shape account",
          },
        ],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const prospectResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(prospectId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "prospect")),
      },
    );
    const prospectBody = (await prospectResponse.json()) as {
      acceptance: { entityIds: { engagementId: string | null; projectIds: string[] }; droppedByGate: unknown };
    };
    expect(prospectResponse.status).toBe(200);
    expect(prospectBody.acceptance.entityIds.engagementId).toBeNull();
    expect(prospectBody.acceptance.entityIds.projectIds).toHaveLength(1);
    expect(prospectBody.acceptance.droppedByGate).toEqual({
      engagement: "Shape account",
      projects: [],
      unmergedFragments: [{ entityId: fragmentId, intoName: "Shape account" }],
    });
    expect(await countEngagementEntities(db)).toBe(0);

    const pilotResponse = await app.request(`/api/project-minting/verdicts/${byCompany.get(pilotId)?.id}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "pilot")),
    });
    const pilotBody = (await pilotResponse.json()) as {
      acceptance: { entityIds: { engagementId: string | null; projectIds: string[] }; droppedByGate: unknown };
    };
    expect(pilotResponse.status).toBe(200);
    expect(pilotBody.acceptance.entityIds.engagementId).toBeNull();
    expect(pilotBody.acceptance.entityIds.projectIds).toHaveLength(1);
    expect(pilotBody.acceptance.droppedByGate).toEqual({
      engagement: "Shape account",
      projects: [],
      unmergedFragments: [{ entityId: fragmentId, intoName: "Shape account" }],
    });
    expect(await countEngagementEntities(db)).toBe(0);

    const activeResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(activeId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(acceptanceBody("client", "active")),
      },
    );
    const activeBody = (await activeResponse.json()) as { error: { code: string; message: string } };
    expect(activeResponse.status).toBe(400);
    expect(activeBody.error.code).toBe("INVALID_ACCEPTANCE_SHAPE");
    expect(activeBody.error.message).toContain("engagement");
  });

  /**
   * The two rules that make `pilot` something other than `prospect`: it must
   * keep a container, and unanchored account files land on it. Without these
   * both pilot branches can be deleted with every other test still green.
   */
  it("separates pilot from prospect: pilot refuses an empty container and absorbs unanchored files", async () => {
    const connectorId = await seedConnector(db);
    const titles = ["Alpha rollout", "Beta migration", "Quarterly account review"];
    const pilotId = await seedMailCluster(db, connectorId, {
      name: "Residualpilot",
      domain: "residualpilot.example",
      titles,
    });
    const prospectId = await seedMailCluster(db, connectorId, {
      name: "Residualprospect",
      domain: "residualprospect.example",
      titles,
    });
    const generator = generatorFor(() =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "pilot",
        engagement: null,
        projects: [
          {
            name: "Alpha rollout",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Alpha rollout"],
            evidenceRepos: [],
            evidencePeople: [],
          },
          {
            name: "Beta migration",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Beta migration"],
            evidenceRepos: [],
            evidencePeople: [],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    await runProjectMintingPass({
      db,
      logger,
      generator,
      model: "test/reasoning-model",
      promptVersion: LEGACY_PROMPT_VERSION,
    });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const emptyPilot = await app.request(`/api/project-minting/verdicts/${byCompany.get(pilotId)?.id}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...acceptanceBody("client", "pilot"),
        struckProjectNames: ["Alpha rollout", "Beta migration"],
      }),
    });
    const emptyPilotBody = (await emptyPilot.json()) as { error: { code: string } };
    expect(emptyPilot.status).toBe(400);
    expect(emptyPilotBody.error.code).toBe("INVALID_ACCEPTANCE_SHAPE");

    const emptyProspect = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(prospectId)?.id}/acceptance`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...acceptanceBody("client", "prospect"),
          struckProjectNames: ["Alpha rollout", "Beta migration"],
        }),
      },
    );
    expect(emptyProspect.status).toBe(200);

    const pilotAccept = await app.request(`/api/project-minting/verdicts/${byCompany.get(pilotId)?.id}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "pilot")),
    });
    const pilotBody = (await pilotAccept.json()) as {
      acceptance: { entities: { name: string; fileIds: string[] }[] };
    };
    expect(pilotAccept.status).toBe(200);
    const pilotFilesByName = new Map(pilotBody.acceptance.entities.map((entity) => [entity.name, entity.fileIds]));
    expect(pilotFilesByName.get("Alpha rollout")).toHaveLength(4);
    expect(pilotFilesByName.get("Beta migration")).toHaveLength(2);
  });

  /**
   * The dossier prints a person as `Name <email>`, so that is the only string
   * the model can echo back. Accept-time resolution used to key on the bare
   * `subject_name`, which made every person anchor miss and refused the whole
   * verdict — the failure seen on the real Getepik cluster, where 11 of 12
   * anchor errors were person anchors.
   */
  it("resolves a person anchor written the way the dossier printed it", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Anchorname", "anchorname.example");
    for (const day of ["01", "02", "03", "04"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "Platform rebuild sync",
        source: "fireflies",
        date: `2026-08-${day}T09:00:00Z`,
        content: "Platform rebuild progress.",
      });
      await seedAttendee(db, connectorId, fileId, "Gotama", "gotama@anchorname.example");
    }
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "pilot",
    });

    const verdictId = await storeVerdictFor(db, logger, () =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "pilot",
        engagement: null,
        projects: [
          {
            name: "Platform rebuild",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: [],
            evidenceRepos: [],
            evidencePeople: ["Gotama <gotama@anchorname.example>"],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "pilot")),
    });
    const body = (await res.json()) as { acceptance: { entities: { name: string; fileIds: string[] }[] } };
    expect(res.status).toBe(200);
    expect(body.acceptance.entities.find((entity) => entity.name === "Platform rebuild")?.fileIds).toHaveLength(4);
  });

  /**
   * The dossier gathers people from PERSON_PARTICIPANT_FACT_TYPES — attendee
   * and correspondent. Accept-time resolution used a different, hand-written
   * list that omitted `correspondent`, so anyone known only from email was
   * absent from the anchor map entirely, in whatever form the model wrote them.
   */
  it("resolves a person anchor for someone known only from email correspondence", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Anchormail", "anchormail.example");
    for (const day of ["01", "02", "03", "04"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "Invoice thread",
        source: "gmail",
        date: `2026-08-${day}T09:00:00Z`,
        content: "Billing thread.",
      });
      await seedAttendee(db, connectorId, fileId, "Harsh T", "harsh.t@anchormail.example", "correspondent");
    }
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "pilot",
    });

    const verdictId = await storeVerdictFor(db, logger, () =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "pilot",
        engagement: null,
        projects: [
          {
            name: "Billing cleanup",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: [],
            evidenceRepos: [],
            evidencePeople: ["Harsh T <harsh.t@anchormail.example>"],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "pilot")),
    });
    const body = (await res.json()) as { acceptance: { entities: { name: string; fileIds: string[] }[] } };
    expect(res.status).toBe(200);
    expect(body.acceptance.entities.find((entity) => entity.name === "Billing cleanup")?.fileIds).toHaveLength(4);
  });
  /**
   * The Getepik failure: one paraphrased title family among eight good ones
   * refused the whole verdict, and the only way out was reject and re-run.
   * A miss is now a warning — the anchors that resolved still mint.
   */
  it("mints on the anchors that resolved and reports the ones that did not", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Anchorpartial", "anchorpartial.example");
    for (const day of ["01", "02", "03", "04"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "Platform rebuild sync",
        source: "fireflies",
        date: `2026-08-${day}T09:00:00Z`,
        content: "Platform rebuild progress.",
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", "dana@anchorpartial.example");
    }
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "pilot",
    });

    const verdictId = await storeVerdictFor(db, logger, () =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "pilot",
        engagement: null,
        projects: [
          {
            name: "Platform rebuild",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Platform rebuild sync", "Platform rebuild"],
            evidenceRepos: [],
            evidencePeople: [],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "pilot")),
    });
    const body = (await res.json()) as {
      acceptance: { entities: { name: string; fileIds: string[] }[]; unresolvedAnchors: string[] };
    };
    expect(res.status).toBe(200);
    expect(body.acceptance.entities.find((entity) => entity.name === "Platform rebuild")?.fileIds).toHaveLength(4);
    expect(body.acceptance.unresolvedAnchors).toEqual([
      'title family "Platform rebuild" on project "Platform rebuild"',
    ]);
  });

  it("uses covered review evidence instead of expanding a shared title family", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Reviewclaims", "reviewclaims.example");
    const fileIds: string[] = [];
    for (const day of ["01", "02", "03", "04", "05"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "OW <> Canvas Standup",
        source: "fireflies",
        date: `2026-08-${day}T09:00:00Z`,
        content: "Shared standup with dashboard and search terms updates.",
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", "dana@reviewclaims.example");
      fileIds.push(fileId);
    }
    const dashboardReviewId = await seedProjectReview(db, "Dashboard Shell", fileIds.slice(0, 2));
    const searchReviewId = await seedProjectReview(db, "Search Terms Display", fileIds.slice(2, 4));
    const verdictId = await storeWeeklyVerdict(db, {
      companyEntityId: companyId,
      companyName: "Reviewclaims",
      fileCount: fileIds.length,
      verdict: readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "active",
        engagement: null,
        projects: [
          {
            name: "Dashboard Shell",
            status: "active",
            confidence: "medium",
            parentName: null,
            evidenceTitleFamilies: ["OW <> Canvas Standup"],
            evidenceRepos: [],
            evidenceFragments: [],
            coveredReviewIds: [dashboardReviewId],
            evidencePeople: [],
          },
          {
            name: "Search Terms Display",
            status: "active",
            confidence: "medium",
            parentName: "Dashboard Shell",
            evidenceTitleFamilies: ["OW <> Canvas Standup"],
            evidenceRepos: [],
            evidenceFragments: [],
            coveredReviewIds: [searchReviewId],
            evidencePeople: [],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    });

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...acceptanceBody("client", "active"), dryRun: true }),
    });
    const body = (await res.json()) as {
      acceptance: {
        entities: { name: string; fileIds: string[] }[];
        unresolvedAnchors: string[];
        residualTarget: string;
      };
    };
    const filesByName = new Map(body.acceptance.entities.map((entity) => [entity.name, entity.fileIds.sort()]));
    expect(res.status).toBe(200);
    expect(filesByName.get("Dashboard Shell")).toEqual(fileIds.slice(0, 2).sort());
    expect(filesByName.get("Search Terms Display")).toEqual(fileIds.slice(2, 4).sort());
    expect(body.acceptance.unresolvedAnchors).toEqual([]);
    expect(body.acceptance.residualTarget).toBe("Dashboard Shell");
  });

  it("falls back to title-family anchors when covered review rows are gone", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Reviewfallback", "reviewfallback.example");
    const fileIds: string[] = [];
    for (const day of ["01", "02", "03"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "Fallback Standup",
        source: "fireflies",
        date: `2026-09-${day}T09:00:00Z`,
        content: "Fallback workstream update.",
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", "dana@reviewfallback.example");
      fileIds.push(fileId);
    }
    const verdictId = await storeWeeklyVerdict(db, {
      companyEntityId: companyId,
      companyName: "Reviewfallback",
      fileCount: fileIds.length,
      verdict: readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "active",
        engagement: null,
        projects: [
          {
            name: "Fallback Workstream",
            status: "active",
            confidence: "medium",
            parentName: null,
            evidenceTitleFamilies: ["Fallback Standup"],
            evidenceRepos: [],
            evidenceFragments: [],
            coveredReviewIds: ["deleted-review-row"],
            evidencePeople: [],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    });

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...acceptanceBody("client", "active"), dryRun: true }),
    });
    const body = (await res.json()) as {
      acceptance: { entities: { name: string; fileIds: string[] }[]; unresolvedAnchors: string[] };
    };

    expect(res.status).toBe(200);
    expect(body.acceptance.entities.find((entity) => entity.name === "Fallback Workstream")?.fileIds.sort()).toEqual(
      fileIds.sort(),
    );
    expect(body.acceptance.unresolvedAnchors).toEqual([]);
  });

  /**
   * Loop closing: rows a minted project covered must leave the pool at
   * accept — resolved into the minted entity with the proposed name kept as
   * an alias — while a struck project's rows stay pooled because nothing was
   * minted for them.
   */
  it("resolves covered queue rows into the minted entity and leaves struck projects' rows pooled", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Loopclose", "loopclose.example");
    const fileIds: string[] = [];
    for (const day of ["01", "02", "03", "04"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "Loop Standup",
        source: "fireflies",
        date: `2026-08-${day}T09:00:00Z`,
        content: "Loop shell and strike shell updates.",
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", "dana@loopclose.example");
      fileIds.push(fileId);
    }
    const keptReviewA = await seedProjectReview(db, "Keep Shell Legacy", fileIds.slice(0, 2));
    const keptReviewB = await seedProjectReview(db, "Keep Shell", fileIds.slice(2, 4));
    const struckReview = await seedProjectReview(db, "Strike Shell", fileIds.slice(0, 2));
    const verdictId = await storeWeeklyVerdict(db, {
      companyEntityId: companyId,
      companyName: "Loopclose",
      fileCount: fileIds.length,
      verdict: readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "active",
        engagement: null,
        projects: [
          {
            name: "Keep Shell",
            status: "active",
            confidence: "medium",
            parentName: null,
            evidenceTitleFamilies: ["Loop Standup"],
            evidenceRepos: [],
            evidenceFragments: [],
            coveredReviewIds: [keptReviewA, keptReviewB],
            evidencePeople: [],
          },
          {
            name: "Strike Shell",
            status: "active",
            confidence: "low",
            parentName: null,
            evidenceTitleFamilies: ["Loop Standup"],
            evidenceRepos: [],
            evidenceFragments: [],
            coveredReviewIds: [struckReview],
            evidencePeople: [],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    });

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...acceptanceBody("client", "active"), struckProjectNames: ["Strike Shell"] }),
    });
    const body = (await res.json()) as {
      acceptance: { entities: { id: string; name: string }[]; coveredReviewsResolved?: number };
    };
    expect(res.status).toBe(200);
    expect(body.acceptance.coveredReviewsResolved).toBe(2);
    const keepEntityId = body.acceptance.entities.find((entity) => entity.name === "Keep Shell")?.id;
    if (!keepEntityId) throw new Error("Keep Shell entity missing from accept result");

    const rows = await db
      .selectFrom("entity_review_queue")
      .select(["id", "status", "resolved_entity_id"])
      .where("id", "in", [keptReviewA, keptReviewB, struckReview])
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(keptReviewA)).toMatchObject({ status: "confirmed", resolved_entity_id: keepEntityId });
    expect(byId.get(keptReviewB)).toMatchObject({ status: "confirmed", resolved_entity_id: keepEntityId });
    expect(byId.get(struckReview)).toMatchObject({ status: "pending", resolved_entity_id: null });

    const keepEntity = await db
      .selectFrom("entities")
      .select(["aliases"])
      .where("id", "=", keepEntityId)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(keepEntity.aliases ?? "[]")).toContain("Keep Shell Legacy");
  });

  /**
   * The one case still worth refusing. Nothing ties the project to the corpus,
   * so minting it would create an entity on no evidence at all.
   */
  it("still refuses a project whose every anchor missed", async () => {
    const connectorId = await seedConnector(db);
    const companyId = await seedCompany(db, "Anchorgroundless", "anchorgroundless.example");
    for (const day of ["01", "02", "03", "04"]) {
      const fileId = await seedFile(db, connectorId, {
        fileName: "Platform rebuild sync",
        source: "fireflies",
        date: `2026-08-${day}T09:00:00Z`,
        content: "Platform rebuild progress.",
      });
      await seedAttendee(db, connectorId, fileId, "Dana Lead", "dana@anchorgroundless.example");
    }
    await createCompanyRelationshipDeclarationRepository(db).declare({
      subjectEntityId: companyId,
      counterpartyKind: "client",
      clientStage: "pilot",
    });

    const verdictId = await storeVerdictFor(db, logger, () =>
      readClusterVerdict({
        counterpartyKind: "client",
        clientStage: "pilot",
        engagement: null,
        projects: [
          {
            name: "Invented workstream",
            status: "active",
            confidence: "high",
            evidenceTitleFamilies: ["Nothing like this exists"],
            evidenceRepos: [],
            evidencePeople: ["Nobody <nobody@elsewhere.example>"],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      }),
    );

    const res = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(acceptanceBody("client", "pilot")),
    });
    const body = (await res.json()) as { error: { code: string; details: { projects: string[] } } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("ANCHOR_NOT_FOUND");
    expect(body.error.details.projects).toEqual(["Invented workstream"]);
    const written = await db.selectFrom("entities").select("id").where("name", "=", "Invented workstream").execute();
    expect(written).toHaveLength(0);
  });
});

/** Runs the pass with a canned verdict and returns the id of the single row it stored. */
async function storeVerdictFor(
  db: Kysely<DB>,
  passLogger: typeof logger,
  resolve: () => ClusterVerdict,
): Promise<string> {
  await runProjectMintingPass({
    db,
    logger: passLogger,
    generator: generatorFor(resolve),
    model: "test/reasoning-model",
    promptVersion: LEGACY_PROMPT_VERSION,
  });
  const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
  if (rows.length !== 1) throw new Error(`expected exactly one pending verdict, got ${rows.length}`);
  return rows[0].id;
}

async function storeWeeklyVerdict(
  db: Kysely<DB>,
  input: { companyEntityId: string; companyName: string; fileCount: number; verdict: ClusterVerdict },
): Promise<string> {
  const stored = await createProjectMintingVerdictRepository(db).storePending({
    companyEntityId: input.companyEntityId,
    companyName: input.companyName,
    fileCount: input.fileCount,
    dossier: "weekly test dossier",
    verdict: JSON.stringify(input.verdict),
    model: "test/reasoning-model",
    promptVersion: WEEKLY_MINT_PROMPT_VERSION,
    counterpartyKind: input.verdict.counterpartyKind,
    clientStage: input.verdict.clientStage,
  });
  return stored.id;
}

async function seedProjectReview(db: Kysely<DB>, name: string, fileIds: string[]): Promise<string> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: name,
      normalized_name: name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
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

async function countProjectMintingSourceRefs(db: Kysely<DB>) {
  const row = await db
    .selectFrom("entity_source_refs")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("source", "=", "project-minting")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function countEngagementEntities(db: Kysely<DB>) {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("source_type", "=", "project")
    .where("subtype", "=", "engagement")
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function expectDeclaration(
  db: Kysely<DB>,
  subjectEntityId: string,
  counterpartyKind: string,
  clientStage: string | null,
) {
  const row = await db
    .selectFrom("company_relationship_declarations")
    .select(["counterparty_kind", "client_stage"])
    .where("subject_entity_id", "=", subjectEntityId)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({ counterparty_kind: counterpartyKind, client_stage: clientStage });
}

async function seedClientCluster(db: Kysely<DB>, connectorId: string, name: string, domain: string): Promise<string> {
  const companyId = await seedCompany(db, name, domain);
  for (const date of ["2026-07-01", "2026-07-08", "2026-07-15"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "Correction deployment sync",
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Deployment work with Casey Lead.",
    });
    await seedAttendee(db, connectorId, fileId, "Casey Lead", `casey@${domain}`);
  }
  return companyId;
}

async function seedOliverWymanCluster(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const companyId = await seedCompany(db, "Oliver Wyman", "oliverwyman.com");
  const fileIds: string[] = [];
  for (const date of ["2026-07-01", "2026-07-08", "2026-07-15"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "OW Dashboard Sync",
      source: "fireflies",
      date: `${date}T09:00:00Z`,
      content: "Dashboard work continues in github.com/canvasxai/ow-dashboard with Maya leading.",
    });
    await seedAttendee(db, connectorId, fileId, "Maya Lead", "maya@oliverwyman.com");
    fileIds.push(fileId);
  }
  for (const date of ["2026-07-02", "2026-07-09", "2026-07-16"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "OW Segmentation Standup",
      source: "fireflies",
      date: `${date}T10:00:00Z`,
      content: "Segmentation models land in github.com/canvasxai/ow-segmentation with Ravi leading.",
    });
    await seedAttendee(db, connectorId, fileId, "Ravi Lead", "ravi@oliverwyman.com");
    fileIds.push(fileId);
  }
  let standupFileId = "";
  for (const date of ["2026-07-03", "2026-07-10"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "OW <> Canvas Standup",
      source: "google_calendar",
      date: `${date}T08:00:00Z`,
      content: "Account-level standup covering all workstreams.",
    });
    await seedAttendee(db, connectorId, fileId, "Asha Account", "asha@oliverwyman.com");
    await seedAttendee(db, connectorId, fileId, "Nina Account", "nina@oliverwyman.com");
    fileIds.push(fileId);
    standupFileId = fileId;
  }
  const fragmentIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const fragmentId = await seedProjectFragment(db, `Fragment ${index + 1}`);
    await seedMention(db, fragmentId, fileIds[index]);
    fragmentIds.push(fragmentId);
  }
  const dashboardTaskId = "task-dashboard";
  const standupTaskId = "task-standup";
  await seedTaskWithFileEvidence(db, dashboardTaskId, fileIds[0]);
  await seedTaskWithFileEvidence(db, standupTaskId, standupFileId);
  return { companyId, fileIds, fragmentIds, standupFileId, dashboardTaskId, standupTaskId };
}

async function seedVendorAndPraevorium(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const vendorId = await seedCompany(db, "Pozitivpartners", "pozitivpartners.com");
  for (const date of ["2026-07-01", "2026-07-15", "2026-08-01"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: `Payroll processing ${date}`,
      source: "gmail",
      date: `${date}T09:00:00Z`,
      content: "Monthly payroll register attached.",
    });
    await seedAttendee(db, connectorId, fileId, "Priya Ops", "priya@pozitivpartners.com");
  }
  const praevoriumId = await seedPraevorium(db, connectorId, [
    "Praevorium proposal discussion",
    "Praevorium cost estimate",
  ]);
  return { vendorId, praevoriumId };
}

async function seedLeadNoProjectAndPraevorium(db: Kysely<DB>) {
  const connectorId = await seedConnector(db);
  const acmeId = await seedCompany(db, "Acmecorp", "acmecorp.io");
  for (const date of ["2026-07-20", "2026-07-27", "2026-08-03"]) {
    const fileId = await seedFile(db, connectorId, {
      fileName: "Acmecorp Demo Call",
      source: "fireflies",
      date: `${date}T11:00:00Z`,
      content: "Product walkthrough and follow-up questions.",
    });
    await seedAttendee(db, connectorId, fileId, "Lena Buyer", "lena@acmecorp.io");
  }
  const praevoriumId = await seedPraevorium(db, connectorId, ["Praevorium proposal discussion"]);
  return { acmeId, praevoriumId };
}

async function seedPraevorium(db: Kysely<DB>, connectorId: string, titles: string[]): Promise<string> {
  return seedMailCluster(db, connectorId, { name: "Praevorium", domain: "praevorium.com", titles });
}

/**
 * One mail-only cluster, two files per title so each title forms a family. The
 * caller chooses the titles so a verdict can anchor some families and leave
 * others for the residual target.
 */
async function seedMailCluster(
  db: Kysely<DB>,
  connectorId: string,
  opts: { name: string; domain: string; titles: string[] },
): Promise<string> {
  const companyId = await seedCompany(db, opts.name, opts.domain);
  let index = 0;
  for (const title of opts.titles.flatMap((title) => [title, `Re: ${title}`])) {
    const fileId = await seedFile(db, connectorId, {
      fileName: title,
      source: "gmail",
      date: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
      content: "Scope, phasing and commercials for the proposed deployment.",
    });
    await seedAttendee(db, connectorId, fileId, "Sam Founder", `sam@${opts.domain}`);
    index++;
  }
  return companyId;
}
