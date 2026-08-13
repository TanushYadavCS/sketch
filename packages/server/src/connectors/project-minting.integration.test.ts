/**
 * End-to-end tests for the project-minting pass (PR-P1 + PR-P2), through
 * `runProjectMintingPass` — the real pass, not stage functions.
 *
 * The two skipped tests are the halves that belong to PR-P3 (acceptance
 * writes) and PR-P4 (deterministic task parenting). Their assertions are
 * written out so those PRs inherit a spec rather than a blank file; they stay
 * skipped because nothing in P1/P2 may write an entity or touch the
 * extraction schema.
 */
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createCompanyRelationshipDeclarationRepository } from "../db/repositories/company-relationship-declarations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, getSharedPgDb } from "../test-utils";
import type { GeminiGenerator } from "./gemini-generate";
import { type ClusterVerdict, clusterClientFiles, runProjectMintingPass } from "./project-minting";

const logger = createTestLogger();

describe("project minting pass (e2e)", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("writes zero entities, leaves every fragment untouched, and stores exactly one pending verdict", async () => {
    const seeded = await seedOliverWymanCluster(db);
    const before = await snapshotEntities(db);
    const verdict: ClusterVerdict = {
      relationshipState: "customer",
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
    };
    let generatorCalls = 0;
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>() {
        generatorCalls++;
        return verdict as T;
      },
    };

    const pass = await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });

    expect(generatorCalls).toBe(1);
    expect(pass.results).toHaveLength(1);
    expect(pass.results[0].companyName).toBe("Oliver Wyman");
    expect(pass.results[0].verdictId).toBeDefined();
    expect(pass.results[0].dossier.markdown).toContain("github.com/canvasxai/ow-dashboard");
    expect(pass.results[0].dossier.markdown).toContain("github.com/canvasxai/ow-segmentation");
    for (const fragmentId of seeded.fragmentIds) {
      expect(pass.results[0].dossier.markdown).toContain(fragmentId);
    }

    const after = await snapshotEntities(db);
    expect(after).toEqual(before);

    const pending = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("status", "=", "pending")
      .where("superseded_at", "is", null)
      .execute();
    expect(pending).toHaveLength(1);
    expect(pending[0].company_entity_id).toBe(seeded.companyId);
    expect(JSON.parse(pending[0].verdict)).toEqual(verdict);
  });

  it("a mention is not a relationship: a file that only names a company never joins its cluster", async () => {
    const seeded = await seedOliverWymanCluster(db);
    const zomatoId = await seedCompany(db, "Zomato", null);
    const mentionOnlyFile = await seedFile(db, seeded.connectorId, {
      fileName: "Redseer delivery stream sync",
      source: "fireflies",
      date: "2026-08-01T09:00:00Z",
      content: "Discussed the Zomato brand benchmark inside the Redseer stream.",
    });
    await seedMention(db, zomatoId, mentionOnlyFile);
    await seedMention(db, zomatoId, seeded.fileIds[0]);

    const clusters = await clusterClientFiles(db);

    const zomato = clusters.find((cluster) => cluster.companyEntityId === zomatoId);
    expect(zomato).toBeUndefined();
    const oliverWyman = clusters.find((cluster) => cluster.companyEntityId === seeded.companyId);
    expect(oliverWyman?.files.map((file) => file.fileId)).not.toContain(mentionOnlyFile);
  });

  it("a vendor cluster mints nothing while an unwon project mints one at proposed", async () => {
    const connectorId = await seedConnector(db);
    const pozId = await seedCompany(db, "Pozitivpartners", "pozitivpartners.com");
    for (const [index, date] of ["2026-07-01", "2026-07-15", "2026-08-01"].entries()) {
      const fileId = await seedFile(db, connectorId, {
        fileName: `Payroll processing – ${date}`,
        source: "gmail",
        date: `${date}T09:00:00Z`,
        content: `Monthly payroll register attached, run ${index + 1}.`,
      });
      await seedAttendee(db, connectorId, fileId, "Priya Ops", "priya@pozitivpartners.com");
    }
    const praevoriumId = await seedCompany(db, "Praevorium", "praevorium.com");
    for (const [title, date] of [
      ["Praevorium proposal discussion", "2026-07-28"],
      ["Re: Praevorium proposal discussion", "2026-07-30"],
      ["Praevorium cost estimate", "2026-08-02"],
      ["Re: Praevorium cost estimate", "2026-08-04"],
    ] as const) {
      const fileId = await seedFile(db, connectorId, {
        fileName: title,
        source: "gmail",
        date: `${date}T10:00:00Z`,
        content: "Scope, phasing and commercials for the proposed deployment.",
      });
      await seedAttendee(db, connectorId, fileId, "Sam Founder", "sam@praevorium.com");
    }
    const vendorVerdict: ClusterVerdict = {
      relationshipState: "vendor",
      engagement: null,
      projects: [],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: ["Recurring payroll administration, not client work."],
    };
    const pursuitVerdict: ClusterVerdict = {
      relationshipState: "lead",
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
    };
    let generatorCalls = 0;
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>(prompt: string) {
        generatorCalls++;
        if (prompt.includes("Pozitivpartners")) return vendorVerdict as T;
        if (prompt.includes("Praevorium")) return pursuitVerdict as T;
        throw new Error("Unexpected dossier");
      },
    };
    const entitiesBefore = await snapshotEntities(db);

    const pass = await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });

    expect(generatorCalls).toBe(2);
    expect(pass.results).toHaveLength(2);
    const pending = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("status", "=", "pending")
      .where("superseded_at", "is", null)
      .execute();
    expect(pending).toHaveLength(2);
    const byCompany = new Map(pending.map((row) => [row.company_entity_id, JSON.parse(row.verdict) as ClusterVerdict]));
    const poz = byCompany.get(pozId);
    expect(poz?.relationshipState).toBe("vendor");
    expect(poz?.projects).toHaveLength(0);
    const praevorium = byCompany.get(praevoriumId);
    expect(praevorium?.projects).toHaveLength(1);
    expect(praevorium?.projects[0].status).toBe("proposed");
    expect(await snapshotEntities(db)).toEqual(entitiesBefore);
  });

  it("a lead cluster records its verdict as the pipeline row and would mint zero containers", async () => {
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
    const leadVerdict: ClusterVerdict = {
      relationshipState: "lead",
      engagement: null,
      projects: [],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: ["Demos and follow-ups only; no client-side work object."],
    };
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>() {
        return leadVerdict as T;
      },
    };
    const before = await snapshotEntities(db);

    const pass = await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });

    expect(await snapshotEntities(db)).toEqual(before);
    const result = pass.results.find((r) => r.companyEntityId === acmeId);
    expect(result?.verdict?.relationshipState).toBe("lead");
    expect(result?.verdict?.projects).toHaveLength(0);
    expect(result?.tripwireFlags).toEqual([]);
    const row = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("company_entity_id", "=", acmeId)
      .where("status", "=", "pending")
      .where("superseded_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(row.relationship_state).toBe("lead");
    expect(row.flags).toBeNull();
    expect((JSON.parse(row.verdict) as ClusterVerdict).projects).toHaveLength(0);
  });

  it("a declared-trial cluster carries the DECLARED line and yields exactly one deployment container", async () => {
    const connectorId = await seedConnector(db);
    const habuildId = await seedCompany(db, "Habuild", "habuild.in");
    for (const [title, date] of [
      ["Habuild onboarding sync", "2026-07-21"],
      ["Habuild onboarding sync", "2026-07-28"],
      ["Habuild access issue", "2026-08-02"],
    ] as const) {
      const fileId = await seedFile(db, connectorId, {
        fileName: title,
        source: "gmail",
        date: `${date}T09:30:00Z`,
        content: "Operating notes for the running deployment.",
      });
      await seedAttendee(db, connectorId, fileId, "Dev Ops", "dev@habuild.in");
    }
    await createCompanyRelationshipDeclarationRepository(db).declare({
      companyEntityId: habuildId,
      declaredState: "trial",
    });
    let capturedPrompt = "";
    const trialVerdict: ClusterVerdict = {
      relationshipState: "trial",
      engagement: null,
      projects: [
        {
          name: "Habuild deployment",
          status: "active",
          confidence: "high",
          evidenceTitleFamilies: ["Habuild onboarding sync"],
          evidenceRepos: [],
          evidencePeople: ["Dev Ops"],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: [],
    };
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>(prompt: string) {
        capturedPrompt = prompt;
        return trialVerdict as T;
      },
    };

    const pass = await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });

    expect(capturedPrompt).toContain("DECLARED (from tenant registry): managed tenant of ours, status = trial.");
    const result = pass.results.find((r) => r.companyEntityId === habuildId);
    expect(result?.dossier.declaredState).toBe("trial");
    expect(result?.verdict?.relationshipState).toBe("trial");
    expect(result?.verdict?.projects).toHaveLength(1);
    expect(result?.verdict?.projects[0].name).toBe("Habuild deployment");
    expect(result?.tripwireFlags).toEqual([]);
    const row = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("company_entity_id", "=", habuildId)
      .where("status", "=", "pending")
      .where("superseded_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(row.relationship_state).toBe("trial");
    expect((JSON.parse(row.verdict) as ClusterVerdict).projects).toHaveLength(1);
  });

  it.skip("accepting the verdict writes the engagement, projects, merges and attachments (PR-P3)", async () => {
    const seeded = await seedOliverWymanCluster(db);
    const verdict: ClusterVerdict = {
      relationshipState: "customer",
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
    };
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>() {
        return verdict as T;
      },
    };
    const pass = await runProjectMintingPass({ db, logger, generator, model: "test/reasoning-model" });
    const verdictId = pass.results[0].verdictId;
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger });
    const cookie = await loginAsAdmin(db, app);

    const response = await app.request(`/api/project-minting/verdicts/${verdictId}/acceptance`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const engagement = await db
      .selectFrom("entities")
      .selectAll()
      .where("name", "=", "Oliver Wyman")
      .where("subtype", "=", "engagement")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    const projects = await db
      .selectFrom("entities")
      .selectAll()
      .where("name", "in", ["OW Dashboard", "OW Segmentation"])
      .where("source_type", "=", "project")
      .where("deleted_at", "is", null)
      .where("merged_into_entity_id", "is", null)
      .execute();
    expect(projects).toHaveLength(2);
    const projectIds = projects.map((project) => project.id);
    const fragments = await db.selectFrom("entities").selectAll().where("id", "in", seeded.fragmentIds).execute();
    expect(fragments).toHaveLength(seeded.fragmentIds.length);
    for (const fragment of fragments) {
      expect(fragment.deleted_at).toBeNull();
      expect(projectIds).toContain(fragment.merged_into_entity_id);
    }
    const standupAttachment = await db
      .selectFrom("entity_mentions")
      .select("entity_id")
      .where("indexed_file_id", "=", seeded.standupFileId)
      .execute();
    const attachedIds = standupAttachment.map((row) => row.entity_id);
    expect(attachedIds).toContain(engagement.id);
    for (const projectId of projectIds) expect(attachedIds).not.toContain(projectId);
    const accepted = await db
      .selectFrom("project_minting_verdicts")
      .selectAll()
      .where("id", "=", verdictId ?? "")
      .executeTakeFirstOrThrow();
    expect(accepted.status).toBe("accepted");
  });

  it.skip("a minted task inherits its project without the model naming one (PR-P4)", async () => {
    const seeded = await seedOliverWymanCluster(db);
    const projectId = seeded.fragmentIds[0];
    let capturedPrompt = "";
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>(prompt: string) {
        capturedPrompt = prompt;
        return {
          tasks: [
            {
              title: "Refresh the dashboard filters",
              hasOwnerVerbObject: true,
              sourceExcerpt: "Maya will refresh the dashboard filters.",
            },
          ],
        } as T;
      },
    };
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres", TASK_MINTING_MODEL: "test/stub-model" }), {
      logger,
      taskMintingGenerator: generator,
    });
    const cookie = await loginAsAdmin(db, app);

    const response = await app.request(`/api/connectors/files/${seeded.fileIds[0]}/tasks`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const body = (await response.json()) as {
      candidates: Array<{ title: string; taskId?: string }>;
      context: Array<{ key: string }>;
    };

    expect(response.status).toBe(200);
    expect(capturedPrompt).not.toContain("Available projects");
    expect(body.context.map((block) => block.key)).not.toContain("projects");
    expect(body.candidates).toHaveLength(1);
    const taskId = body.candidates[0].taskId;
    expect(taskId).toBeDefined();
    const task = await db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", taskId ?? "")
      .executeTakeFirstOrThrow();
    expect(task.parent_entity_id).toBe(projectId);
  });
});

async function snapshotEntities(db: Kysely<DB>) {
  return db
    .selectFrom("entities")
    .select(["id", "name", "source_type", "status", "updated_at", "deleted_at", "merged_into_entity_id"])
    .orderBy("id", "asc")
    .execute();
}

async function seedConnector(db: Kysely<DB>): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: "project-minting-test",
    })
    .execute();
  return id;
}

async function seedCompany(db: Kysely<DB>, name: string, domain: string | null): Promise<string> {
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
  if (domain) {
    await db
      .insertInto("entity_domains")
      .values({
        id: randomUUID(),
        entity_id: id,
        domain,
        kind: "corporate",
        is_primary: 1,
        confidence: 1,
        source: "manual",
      })
      .execute();
  }
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

async function seedAttendee(
  db: Kysely<DB>,
  connectorId: string,
  fileId: string,
  name: string,
  email: string,
): Promise<void> {
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

/**
 * The Oliver Wyman shape from the plan's first e2e test: one outside company,
 * two title families with distinct repos and leads, an account-level standup
 * family, and pre-existing fragment entities across those files.
 */
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
    await seedAttendee(db, connectorId, fileId, "Maya Lead", "maya@oliverwyman.com");
    await seedAttendee(db, connectorId, fileId, "Ravi Lead", "ravi@oliverwyman.com");
    fileIds.push(fileId);
    standupFileId = fileId;
  }
  const fragmentIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const fragmentId = await seedProjectFragment(db, `Fragment ${index + 1}`);
    await seedMention(db, fragmentId, fileIds[index]);
    fragmentIds.push(fragmentId);
  }
  return { connectorId, companyId, fileIds, fragmentIds, standupFileId };
}

async function loginAsAdmin(db: Kysely<DB>, app: ReturnType<typeof createApp>): Promise<string> {
  const password = "testpassword123";
  const settings = createSettingsRepository(db);
  await settings.ensure();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  await createUserRepository(db).create({
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
    passwordHash: await hashPassword(password),
    authRole: "admin",
  });
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}
