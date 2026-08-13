import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createCompanyRelationshipDeclarationRepository } from "../db/repositories/company-relationship-declarations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { type ClusterVerdict, readClusterVerdict, runProjectMintingPass } from "./project-minting";

const logger = createTestLogger();
const PASSWORD = "testpassword123";

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

    const pass = await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });

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
      body: JSON.stringify({}),
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

    await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const vendorResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.vendorId)?.id}/acceptance`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}) },
    );
    expect(vendorResponse.status).toBe(200);
    expect(await countProjectMintingSourceRefs(db)).toBe(0);
    const vendorRow = await db
      .selectFrom("project_minting_verdicts")
      .select("status")
      .where("id", "=", byCompany.get(seeded.vendorId)?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(vendorRow.status).toBe("accepted");

    const pursuitResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.praevoriumId)?.id}/acceptance`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}) },
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

    await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });
    const rows = await db.selectFrom("project_minting_verdicts").selectAll().where("status", "=", "pending").execute();
    const byCompany = new Map(rows.map((row) => [row.company_entity_id, row]));

    const acmeResponse = await app.request(
      `/api/project-minting/verdicts/${byCompany.get(seeded.acmeId)?.id}/acceptance`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}) },
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
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}) },
    );
    expect(controlResponse.status).toBe(200);
    expect(await countProjectMintingSourceRefs(db)).toBe(1);
  });
});

function generatorFor(resolve: (prompt: string) => ClusterVerdict): GeminiGenerator {
  return {
    async generate() {
      return "{}";
    },
    async generateJSON<T>(prompt: string) {
      return resolve(prompt) as T;
    },
  };
}

async function loginAsAdmin(db: Kysely<DB>, app: ReturnType<typeof createApp>): Promise<string> {
  const settings = createSettingsRepository(db);
  await settings.ensure();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  await createUserRepository(db).create({
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

async function countProjectMintingSourceRefs(db: Kysely<DB>) {
  const row = await db
    .selectFrom("entity_source_refs")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("source", "=", "project-minting")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function loadEntities(db: Kysely<DB>, ids: string[]) {
  return db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "status", "deleted_at", "merged_into_entity_id"])
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .execute();
}

async function seedConnector(db: Kysely<DB>): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connector_configs")
    .values({ id, connector_type: "fireflies", auth_type: "api_key", credentials: "{}", created_by: "test" })
    .execute();
  return id;
}

async function seedCompany(db: Kysely<DB>, name: string, domain: string): Promise<string> {
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
  await db
    .insertInto("entity_domains")
    .values({
      id: randomUUID(),
      entity_id: id,
      domain,
      kind: "corporate",
      is_primary: 1,
      confidence: 1,
      source: "test",
    })
    .execute();
  return id;
}

async function seedFile(
  db: Kysely<DB>,
  connectorId: string,
  opts: { fileName: string; source: string; date: string; content: string },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorId,
      provider_file_id: id,
      provider_url: null,
      file_name: opts.fileName,
      file_type: "transcript",
      content_category: "document",
      content: opts.content,
      summary: null,
      source: opts.source,
      source_path: null,
      content_hash: id,
      source_created_at: opts.date,
      source_updated_at: null,
      synced_at: opts.date,
      context_note: null,
      access_scope_id: null,
    })
    .execute();
  return id;
}

async function seedAttendee(db: Kysely<DB>, connectorId: string, fileId: string, name: string, email: string) {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: randomUUID(),
      indexed_file_id: fileId,
      connector_config_id: connectorId,
      created_by_user_id: null,
      source: "test",
      fact_type: "attendee",
      relation: "attended",
      subject_name: name,
      subject_email: email,
      subject_source: null,
      subject_source_id: null,
      context_snippet: null,
      raw: null,
      fact_key: `${fileId}:attendee:${email}`,
      last_seen_sync_run_id: null,
      deleted_at: null,
      content_hash: null,
      materialization_input_hash: null,
      normalized_subject_name: null,
      normalized_mention_name: null,
      raw_mention_type: null,
      mention_type: null,
      feature_corroboration_key: null,
      normalization_projected_at: null,
      materialized_at: null,
    })
    .execute();
}

async function seedProjectFragment(db: Kysely<DB>, name: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: null,
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

async function seedMention(db: Kysely<DB>, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

async function seedTaskWithFileEvidence(db: Kysely<DB>, id: string, fileId: string) {
  await db
    .insertInto("tasks")
    .values({
      id,
      parent_entity_id: null,
      parent_source_ref: null,
      parent_name: null,
      source: "test",
      external_ref: null,
      title: id,
      normalized_title: id,
      status: "open",
      status_raw: null,
      status_authority: "local",
      assignee_entity_id: null,
      assignee_name: null,
      proposed_assignee_name: null,
      priority: null,
      due_at: null,
      provenance: "llm",
      source_task_id: id,
      created_by_user_id: null,
      status_changed_at: null,
      completed_at: null,
      valid_from: null,
      valid_to: null,
    })
    .execute();
  await db.insertInto("task_evidence").values({ task_id: id, kind: "file", ref_id: fileId }).execute();
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
  const praevoriumId = await seedCompany(db, "Praevorium", "praevorium.com");
  let index = 0;
  for (const title of titles.flatMap((title) => [title, `Re: ${title}`])) {
    const fileId = await seedFile(db, connectorId, {
      fileName: title,
      source: "gmail",
      date: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
      content: "Scope, phasing and commercials for the proposed deployment.",
    });
    await seedAttendee(db, connectorId, fileId, "Sam Founder", "sam@praevorium.com");
    index++;
  }
  return praevoriumId;
}
