import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { relationDirectionAllowed } from "../entities/graph";
import { materializeUnmaterializedFacts } from "../entities/materialize";
import { createTestDb, createTestLogger } from "../test-utils";
import { createLinearConnector } from "./linear";
import { emitFactsForSyncedItem } from "./sync-facts";
import { loadExistingContentHashes, processSyncedItem } from "./sync-item";
import type { EntitySeed } from "./types";

const USER_ID = "linear-team-membership-user";
const CONNECTOR_ID = "linear-team-membership-connector";

const RECORDED_LINEAR_ISSUES_PAGE = {
  data: {
    issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    },
  },
};

const RECORDED_LINEAR_TEAMS_PAGE = {
  data: {
    teams: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "lin-team-1",
          name: "Platform",
          key: "PLAT",
          members: {
            nodes: [
              { id: "lin-user-1", name: "Nisha Rao", email: "nisha@example.com" },
              { id: "lin-user-2", name: "Sam Ortega", email: null },
            ],
          },
        },
      ],
    },
  },
};

const RECORDED_LINEAR_PROJECTS_PAGE = {
  data: {
    projects: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
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
      name: "Linear Team Membership User",
      email: "linear-team-membership@example.com",
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
  expect(connector.promotableFileTypes).not.toContain("team");

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

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    providerFileId: "team-lin-team-1",
    fileType: "team",
    fileName: "Platform",
  });
}

async function getTeamEntityId(db: Kysely<DB>): Promise<string> {
  const teamRef = await db
    .selectFrom("entity_source_refs")
    .selectAll()
    .where("source", "=", "linear")
    .where("source_id", "=", "lin-team-1")
    .executeTakeFirstOrThrow();
  return teamRef.entity_id;
}

async function getMemberOfRows(db: Kysely<DB>) {
  return db
    .selectFrom("entity_relationships")
    .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
    .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
    .select([
      "entity_relationships.id",
      "entity_relationships.source_entity_id",
      "entity_relationships.target_entity_id",
      "entity_relationships.relationship_type",
      "source.source_type as source_type",
      "source.name as source_name",
      "target.source_type as target_type",
      "target.name as target_name",
    ])
    .where("entity_relationships.relationship_type", "=", "member_of")
    .orderBy("source.name", "asc")
    .execute();
}

describe("Linear team membership", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedOwnerAndConnector(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("creates member_of edges from members to their team", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const teamEntityId = await getTeamEntityId(db);
    const relationships = await getMemberOfRows(db);

    expect(relationDirectionAllowed("member_of", "team", "person")).toBe(false);
    expect(relationDirectionAllowed("member_of", "person", "team")).toBe(true);
    expect(relationships).toHaveLength(2);
    expect(relationships.every((relationship) => relationship.source_type === "person")).toBe(true);
    expect(relationships.every((relationship) => relationship.target_entity_id === teamEntityId)).toBe(true);
    expect(relationships.every((relationship) => relationship.target_type === "team")).toBe(true);
    expect(relationships.map((relationship) => relationship.source_name)).toEqual(["Nisha Rao", "Sam Ortega"]);
  });

  it("is idempotent across re-sync", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());

    await syncRecordedLinearPayload(db, "sync-run-2");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const relationships = await getMemberOfRows(db);
    const evidence = await db
      .selectFrom("entity_relationship_evidence")
      .select(["relationship_id", "source_fact_id"])
      .where(
        "relationship_id",
        "in",
        relationships.map((relationship) => relationship.id),
      )
      .orderBy("relationship_id", "asc")
      .execute();

    expect(relationships).toHaveLength(2);
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((row) => `${row.relationship_id}:${row.source_fact_id}`)).size).toBe(2);
  });

  it("seeds a member with no email and still links them", async () => {
    await syncRecordedLinearPayload(db, "sync-run-1");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const teamEntityId = await getTeamEntityId(db);
    const memberRef = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("source", "=", "linear")
      .where("source_id", "=", "lin-user-2")
      .executeTakeFirstOrThrow();
    const member = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", memberRef.entity_id)
      .executeTakeFirstOrThrow();
    const relationship = await db
      .selectFrom("entity_relationships")
      .selectAll()
      .where("relationship_type", "=", "member_of")
      .where("source_entity_id", "=", member.id)
      .where("target_entity_id", "=", teamEntityId)
      .executeTakeFirstOrThrow();

    expect(member.name).toBe("Sam Ortega");
    expect(member.source_type).toBe("person");
    expect(relationship.source).toBe("linear");
  });
});
