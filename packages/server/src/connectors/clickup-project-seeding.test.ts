import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { up as migrateClickUpProjectEntitySeedingCleanup } from "../db/migrations/097-clickup-project-entity-seeding-cleanup";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { resetDerivedEntityData } from "../entities/recreate";
import { createTestDb, createTestLogger } from "../test-utils";
import { createClickUpConnector } from "./clickup";
import { emitFactsForSyncedItem } from "./sync-facts";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { EntitySeed } from "./types";

const USER_ID = "clickup-seeding-user";
const CONNECTOR_ID = "clickup-seeding-connector";

const RECORDED_CLICKUP = {
  team: {
    id: "cu-workspace-1",
    name: "Acme Workspace",
    members: [{ user: { id: 10, username: "Nisha Rao", email: "nisha@example.com" } }],
  },
  space: { id: "cu-space-1", name: "Delivery", private: false },
  folderWithLists: { id: "cu-folder-1", name: "Atlas Launch" },
  emptyFolder: { id: "cu-folder-empty", name: "No Active Work" },
  folderList: { id: "cu-list-folder-1", name: "Build Phase", task_count: 1 },
  folderlessList: { id: "cu-list-flat-1", name: "Customer Rollout", task_count: 1 },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function clickupTask(input: {
  id: string;
  name: string;
  list: { id: string; name: string };
  folder?: { id: string; name: string };
}) {
  return {
    id: input.id,
    name: input.name,
    description: "",
    status: { status: "open", type: "open" },
    priority: null,
    assignees: [],
    tags: [],
    date_created: "1780000000000",
    date_updated: "1780000001000",
    url: `https://app.clickup.com/t/${input.id}`,
    parent: null,
    list: input.list,
    folder: input.folder,
    space: { id: RECORDED_CLICKUP.space.id },
    custom_fields: [],
  };
}

function mockRecordedClickUpFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/api/v2/team") return jsonResponse({ teams: [RECORDED_CLICKUP.team] });
    if (path === `/api/v2/team/${RECORDED_CLICKUP.team.id}/space`) {
      return jsonResponse({ spaces: [RECORDED_CLICKUP.space] });
    }
    if (path === `/api/v2/space/${RECORDED_CLICKUP.space.id}/folder`) {
      return jsonResponse({ folders: [RECORDED_CLICKUP.folderWithLists, RECORDED_CLICKUP.emptyFolder] });
    }
    if (path === `/api/v2/folder/${RECORDED_CLICKUP.folderWithLists.id}/list`) {
      return jsonResponse({ lists: [RECORDED_CLICKUP.folderList] });
    }
    if (path === `/api/v2/folder/${RECORDED_CLICKUP.emptyFolder.id}/list`) {
      return jsonResponse({ lists: [] });
    }
    if (path === `/api/v2/space/${RECORDED_CLICKUP.space.id}/list`) {
      return jsonResponse({ lists: [RECORDED_CLICKUP.folderlessList] });
    }
    if (path === `/api/v2/list/${RECORDED_CLICKUP.folderList.id}/task`) {
      return jsonResponse({
        tasks: [
          clickupTask({
            id: "cu-task-folder-1",
            name: "Ship folder task",
            list: RECORDED_CLICKUP.folderList,
            folder: RECORDED_CLICKUP.folderWithLists,
          }),
        ],
      });
    }
    if (path === `/api/v2/list/${RECORDED_CLICKUP.folderlessList.id}/task`) {
      return jsonResponse({
        tasks: [
          clickupTask({
            id: "cu-task-flat-1",
            name: "Ship flat task",
            list: RECORDED_CLICKUP.folderlessList,
          }),
        ],
      });
    }
    if (path === `/api/v3/workspaces/${RECORDED_CLICKUP.team.id}/docs`) {
      return jsonResponse({ docs: [] });
    }

    return new Response(JSON.stringify({ error: `unexpected path ${path}` }), { status: 404 });
  });
}

async function seedOwnerAndConnector(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "ClickUp Seeding User",
      email: "clickup-seeding@example.com",
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
      connector_type: "clickup",
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

async function syncRecordedClickUpPayload(db: Kysely<DB>, syncRunId: string): Promise<void> {
  mockRecordedClickUpFetch();
  const connector = createClickUpConnector();
  const factRepo = createIndexedFileFactRepository(db);
  const repo = createConnectorRepository(db);
  const existingHashes = await loadExistingContentHashes(db, "clickup", CONNECTOR_ID);
  const factContext = {
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    lastSeenSyncRunId: syncRunId,
  };
  const items = [];

  for await (const item of connector.sync({
    connectorConfigId: CONNECTOR_ID,
    credentials: { type: "api_key", api_key: "clickup-token" },
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
      connectorType: "clickup",
      item,
      existingHashes,
    });
    if (itemResult.kind === "skipped_empty") continue;
    await emitFactsForSyncedItem({
      factRepo,
      connector,
      connectorType: "clickup",
      factContext,
      item,
      indexedFileId: itemResult.indexedFileId,
      experimentalFlag: true,
    });
  }

  expect(items.map((item) => item.providerFileId).sort()).toEqual(["cu-task-flat-1", "cu-task-folder-1"]);
}

describe("ClickUp project entity seeding", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedOwnerAndConnector(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("seeds folder-with-lists and folderless-list projects and links folderless tasks to the list project", async () => {
    await syncRecordedClickUpPayload(db, "sync-run-1");

    const summary = await materializeUnmaterializedFacts(db, createTestLogger(), { experimentalFlag: true });

    expect(summary.entitiesCreated).toBe(2);
    const projects = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select(["entities.id", "entities.name", "entities.aliases", "entity_source_refs.source_id"])
      .where("entities.source_type", "=", "project")
      .where("entity_source_refs.source", "=", "clickup")
      .orderBy("entity_source_refs.source_id")
      .execute();
    expect(projects).toEqual([
      {
        id: expect.any(String),
        name: "Delivery Atlas Launch",
        aliases: '["Atlas Launch"]',
        source_id: "cu-folder-1",
      },
      {
        id: expect.any(String),
        name: "Delivery Customer Rollout",
        aliases: '["Customer Rollout"]',
        source_id: "cu-list-flat-1",
      },
    ]);
    const legacyFolders = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "clickup_folder")
      .execute();
    expect(legacyFolders).toHaveLength(0);
    const flatTask = await db
      .selectFrom("indexed_files")
      .select("id")
      .where("provider_file_id", "=", "cu-task-flat-1")
      .executeTakeFirstOrThrow();
    const flatProject = projects.find((project) => project.source_id === "cu-list-flat-1");
    expect(flatProject).toBeDefined();
    const flatProjectMention = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("indexed_file_id", "=", flatTask.id)
      .where("entity_id", "=", flatProject?.id ?? "")
      .where("source", "=", "clickup_parent_entity")
      .executeTakeFirstOrThrow();
    expect(flatProjectMention.context_snippet).toBe("In list: Customer Rollout");
    const flatTaskRow = await db
      .selectFrom("tasks")
      .select(["parent_name"])
      .where("source_task_id", "=", "cu-task-flat-1")
      .executeTakeFirstOrThrow();
    expect(flatTaskRow.parent_name).toBe("Delivery Customer Rollout");
  });

  it("re-syncs the same ClickUp tree without duplicate project entities or entity churn", async () => {
    await syncRecordedClickUpPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());
    const firstProjects = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select([
        "entities.id",
        "entities.name",
        "entities.aliases",
        "entities.updated_at",
        "entity_source_refs.source_id",
      ])
      .where("entities.source_type", "=", "project")
      .where("entity_source_refs.source", "=", "clickup")
      .orderBy("entity_source_refs.source_id")
      .execute();

    await syncRecordedClickUpPayload(db, "sync-run-2");
    const summary = await materializeUnmaterializedFacts(db, createTestLogger());

    expect(summary.entitiesLinked).toBeGreaterThanOrEqual(2);
    const secondProjects = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select([
        "entities.id",
        "entities.name",
        "entities.aliases",
        "entities.updated_at",
        "entity_source_refs.source_id",
      ])
      .where("entities.source_type", "=", "project")
      .where("entity_source_refs.source", "=", "clickup")
      .orderBy("entity_source_refs.source_id")
      .execute();
    expect(secondProjects).toEqual(firstProjects);
    const reviews = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      proposed_name: "Delivery",
      entity_type: "project",
      seed_source: "clickup",
      seed_source_id: "cu-space-1",
    });
  });

  it("migrates legacy ClickUp folder rows and tombstones only folder facts before reset replay", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: "legacy-clickup-folder-entity",
          name: "Legacy Atlas Folder",
          source_type: "clickup_folder",
          subtype: null,
          aliases: null,
          metadata: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "legacy-clickup-space-entity",
          name: "Delivery",
          source_type: "clickup_space",
          subtype: null,
          aliases: null,
          metadata: null,
          source_ref_id: null,
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values([
        {
          id: "legacy-clickup-folder-ref",
          entity_id: "legacy-clickup-folder-entity",
          source: "clickup",
          source_id: "cu-folder-legacy",
          source_url: null,
          last_seen_at: now,
        },
        {
          id: "legacy-clickup-space-ref",
          entity_id: "legacy-clickup-space-entity",
          source: "clickup",
          source_id: "cu-space-legacy",
          source_url: null,
          last_seen_at: now,
        },
      ])
      .execute();
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "clickup",
      factType: "structural_seed",
      relation: "seeded",
      subjectName: "Legacy Atlas Folder",
      subjectSource: "clickup",
      subjectSourceId: "cu-folder-legacy",
      raw: {
        name: "Legacy Atlas Folder",
        sourceType: "clickup_folder",
        source: "clickup",
        sourceId: "cu-folder-legacy",
      },
    });
    await factRepo.upsertFact({
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "clickup",
      factType: "structural_seed",
      relation: "seeded",
      subjectName: "Delivery",
      subjectSource: "clickup",
      subjectSourceId: "cu-space-legacy",
      raw: {
        name: "Delivery",
        sourceType: "clickup_space",
        source: "clickup",
        sourceId: "cu-space-legacy",
      },
    });

    await migrateClickUpProjectEntitySeedingCleanup(db as unknown as Kysely<unknown>);

    const migrated = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "legacy-clickup-folder-entity")
      .executeTakeFirstOrThrow();
    expect(migrated.source_type).toBe("project");
    const folderFact = await db
      .selectFrom("indexed_file_facts")
      .select(["deleted_at", "materialized_at"])
      .where("subject_source_id", "=", "cu-folder-legacy")
      .executeTakeFirstOrThrow();
    expect(folderFact.deleted_at).not.toBeNull();
    expect(folderFact.materialized_at).not.toBeNull();
    const spaceFact = await db
      .selectFrom("indexed_file_facts")
      .select(["deleted_at", "materialized_at"])
      .where("subject_source_id", "=", "cu-space-legacy")
      .executeTakeFirstOrThrow();
    expect(spaceFact.deleted_at).toBeNull();

    await resetDerivedEntityData(db, createTestLogger());
    await materializeUnmaterializedFacts(db, createTestLogger());

    const resurrectedFolders = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "clickup_folder")
      .execute();
    expect(resurrectedFolders).toHaveLength(0);
    const persistedSpaces = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "clickup_space")
      .execute();
    expect(persistedSpaces).toHaveLength(0);
    const persistedProjects = await db
      .selectFrom("entities")
      .selectAll()
      .where("source_type", "=", "project")
      .where("name", "=", "Delivery")
      .execute();
    expect(persistedProjects).toHaveLength(0);
    const queuedProjects = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("proposed_name", "=", "Delivery")
      .where("seed_source_id", "=", "cu-space-legacy")
      .execute();
    expect(queuedProjects).toHaveLength(1);
  });
});
