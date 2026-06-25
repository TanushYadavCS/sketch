import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { up as migrateLinearProjectEntitySeedingCleanup } from "../db/migrations/096-linear-project-entity-seeding-cleanup";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { resetDerivedEntityData } from "../entities/recreate";
import { createTestDb, createTestLogger } from "../test-utils";
import { createLinearConnector } from "./linear";
import { emitFactsForSyncedItem } from "./sync-facts";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { EntitySeed } from "./types";

const USER_ID = "linear-seeding-user";
const CONNECTOR_ID = "linear-seeding-connector";

const RECORDED_LINEAR_ISSUES_PAGE = {
  data: {
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "lin-issue-untagged-1",
          identifier: "PLAT-101",
          title: "Audit workspace isolation",
          description: null,
          url: "https://linear.example/issue/PLAT-101/audit-workspace-isolation",
          state: { name: "Todo", type: "unstarted" },
          priority: 3,
          priorityLabel: "Medium",
          assignee: null,
          labels: { nodes: [] },
          team: { id: "lin-team-1", name: "Platform", key: "PLAT" },
          project: null,
          estimate: null,
          dueDate: null,
          createdAt: "2026-06-08T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
          comments: { nodes: [] },
        },
        {
          id: "lin-issue-tagged-1",
          identifier: "PLAT-102",
          title: "Ship Atlas launch checklist",
          description: null,
          url: "https://linear.example/issue/PLAT-102/ship-atlas-launch-checklist",
          state: { name: "In Progress", type: "started" },
          priority: 2,
          priorityLabel: "High",
          assignee: null,
          labels: { nodes: [] },
          team: { id: "lin-team-1", name: "Platform", key: "PLAT" },
          project: { id: "lin-proj-1", name: "Atlas Launch" },
          estimate: null,
          dueDate: null,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
          comments: { nodes: [] },
        },
      ],
    },
  },
};

const RECORDED_LINEAR_TEAMS_PAGE = {
  data: {
    teams: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: "lin-team-1", name: "Platform", key: "PLAT", members: { nodes: [] } }],
    },
  },
};

const RECORDED_LINEAR_PROJECTS_PAGE = {
  data: {
    projects: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "lin-proj-1",
          name: "Atlas Launch",
          description: "Launch coordination",
          url: "https://linear.example/project/lin-proj-1",
          state: "started",
          lead: { name: "Nisha Rao", displayName: "Nisha Rao" },
          startDate: "2026-06-01",
          targetDate: "2026-07-15",
          teams: { nodes: [{ name: "Platform", key: "PLAT" }] },
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        },
      ],
    },
  },
};

function graphqlResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function seedOwnerAndConnector(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Linear Seeding User",
      email: "linear-seeding@example.com",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

async function recordSeedFact(db: Kysely<DB>, seed: EntitySeed, syncRunId: string): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: syncRunId,
    source: seed.source,
    factType: "structural_seed",
    relation: "seeded",
    subjectName: seed.name,
    subjectSource: seed.source,
    subjectSourceId: seed.sourceId,
    raw: seed,
  });
}

async function syncRecordedLinearPayload(db: Kysely<DB>, syncRunId: string): Promise<void> {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(graphqlResponse(RECORDED_LINEAR_ISSUES_PAGE))
    .mockResolvedValueOnce(graphqlResponse(RECORDED_LINEAR_TEAMS_PAGE))
    .mockResolvedValueOnce(graphqlResponse(RECORDED_LINEAR_PROJECTS_PAGE));

  const connector = createLinearConnector();
  expect(connector.promotableFileTypes).not.toContain("project");

  const factRepo = createIndexedFileFactRepository(db);
  const repo = createConnectorRepository(db);
  const existingHashes = await loadExistingContentHashes(db, "linear", CONNECTOR_ID);
  const factContext = { connectorConfigId: CONNECTOR_ID, createdByUserId: USER_ID, lastSeenSyncRunId: syncRunId };

  const items = [];
  for await (const item of connector.sync({
    connectorConfigId: CONNECTOR_ID,
    credentials: { type: "api_key", api_key: "linear-token" },
    scopeConfig: {},
    cursor: null,
    logger: createTestLogger(),
    onEntitySeed: async (seed) => recordSeedFact(db, seed, syncRunId),
  })) {
    items.push(item);
    const itemResult = await processSyncedItem({
      db,
      repo,
      connectorConfigId: CONNECTOR_ID,
      connectorType: "linear",
      item,
      existingHashes,
    });
    if (itemResult.kind === "skipped_empty") continue;
    await emitFactsForSyncedItem({
      factRepo,
      connector,
      connectorType: "linear",
      factContext,
      item,
      indexedFileId: itemResult.indexedFileId,
    });
  }

  expect(items).toHaveLength(4);
  expect(items.find((item) => item.providerFileId === "project-lin-proj-1")).toMatchObject({
    providerFileId: "project-lin-proj-1",
    fileType: "project",
    fileName: "Atlas Launch",
  });
}

describe("Linear project entity seeding", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedOwnerAndConnector(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("materializes one Linear project seed with a bare project source ref", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");

    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.entitiesCreated).toBe(1);
    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Atlas Launch");
    const projectRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "lin-proj-1")
      .executeTakeFirstOrThrow();
    expect(projectRef.entity_id).toBe(projects[0].id);
    const teamRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "lin-team-1")
      .executeTakeFirstOrThrow();
    const team = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", teamRef.entity_id)
      .executeTakeFirstOrThrow();
    expect(team.source_type).toBe("team");
  });

  it("links the seeded Linear project entity to its own project document", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const project = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "project")
      .executeTakeFirstOrThrow();
    const projectFile = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("source", "=", "linear")
      .where("provider_file_id", "=", "project-lin-proj-1")
      .executeTakeFirstOrThrow();
    const mention = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", project.id)
      .where("indexed_file_id", "=", projectFile.id)
      .where("source", "=", "linear_parent_entity")
      .executeTakeFirstOrThrow();
    expect(mention.context_snippet).toBe("Linear project: Atlas Launch");
  });

  it("anchors an untagged issue to its team only", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const teamRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "lin-team-1")
      .executeTakeFirstOrThrow();
    const issueFile = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("source", "=", "linear")
      .where("provider_file_id", "=", "lin-issue-untagged-1")
      .executeTakeFirstOrThrow();
    const teamMention = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", teamRef.entity_id)
      .where("indexed_file_id", "=", issueFile.id)
      .where("source", "=", "linear_parent_entity")
      .executeTakeFirstOrThrow();
    expect(teamMention.context_snippet).toBe("Linear issue in team: Platform");

    const projectMentions = await db
      .selectFrom("entity_mentions")
      .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
      .selectAll("entity_mentions")
      .where("entity_mentions.indexed_file_id", "=", issueFile.id)
      .where("entity_mentions.source", "=", "linear_parent_entity")
      .where("entities.source_type", "=", "project")
      .execute();
    expect(projectMentions).toHaveLength(0);
  });

  it("anchors a project-tagged issue to both team and project", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const teamRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "lin-team-1")
      .executeTakeFirstOrThrow();
    const projectRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "lin-proj-1")
      .executeTakeFirstOrThrow();
    const issueFile = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("source", "=", "linear")
      .where("provider_file_id", "=", "lin-issue-tagged-1")
      .executeTakeFirstOrThrow();
    const teamMention = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", teamRef.entity_id)
      .where("indexed_file_id", "=", issueFile.id)
      .where("source", "=", "linear_parent_entity")
      .executeTakeFirstOrThrow();
    const projectMention = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", projectRef.entity_id)
      .where("indexed_file_id", "=", issueFile.id)
      .where("source", "=", "linear_parent_entity")
      .executeTakeFirstOrThrow();
    expect(teamMention.context_snippet).toBe("Linear issue in team: Platform");
    expect(projectMention.context_snippet).toBe("Linear issue in project: Atlas Launch");
  });

  it("re-syncs the same Linear project without duplicate entities or entity churn", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());
    const firstProject = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "project")
      .executeTakeFirstOrThrow();

    await syncRecordedLinearPayload(db, "sync-run-2");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.entitiesLinked).toBe(1);
    const projects = await db.selectFrom("entities").selectAll().where("source_type", "=", "project").execute();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(firstProject.id);
    expect(projects[0].updated_at).toBe(firstProject.updated_at);
    const reviews = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(reviews).toHaveLength(0);
  });

  it("migrates legacy Linear project rows and tombstones promotion facts before reset replay", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: "legacy-linear-project-entity",
        name: "Legacy Atlas",
        source_type: "linear_project",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "legacy-linear-project-ref",
        entity_id: "legacy-linear-project-entity",
        source: "linear",
        source_id: "project-lin-legacy-1",
        source_url: "https://linear.example/project/lin-legacy-1",
        last_seen_at: now,
      })
      .execute();
    await createIndexedFileFactRepository(db).upsertFact({
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      factType: "structural_seed",
      relation: "seeded",
      subjectName: "Legacy Atlas",
      subjectSource: "linear",
      subjectSourceId: "project-lin-legacy-1",
      raw: {
        providerFileId: "project-lin-legacy-1",
        providerUrl: "https://linear.example/project/lin-legacy-1",
        fileType: "project",
        sourcePath: null,
      },
    });

    await migrateLinearProjectEntitySeedingCleanup(db as unknown as Kysely<unknown>);

    const migrated = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "legacy-linear-project-entity")
      .executeTakeFirstOrThrow();
    expect(migrated.source_type).toBe("project");
    const migratedRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("entity_id", "=", "legacy-linear-project-entity")
      .executeTakeFirstOrThrow();
    expect(migratedRef.source_id).toBe("lin-legacy-1");
    const tombstonedFact = await db
      .selectFrom("indexed_file_facts")
      .select(["deleted_at", "materialized_at"])
      .where("subject_source_id", "=", "project-lin-legacy-1")
      .executeTakeFirstOrThrow();
    expect(tombstonedFact.deleted_at).not.toBeNull();
    expect(tombstonedFact.materialized_at).not.toBeNull();

    await resetDerivedEntityData(db, createTestLogger());
    await materializeUnmaterializedFacts(db, createTestLogger());

    const resurrected = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "linear_project")
      .execute();
    expect(resurrected).toHaveLength(0);
  });
});
