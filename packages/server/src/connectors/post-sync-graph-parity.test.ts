import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runPostSyncGraphPipeline } from "./post-sync";

const MEETING_BODY = `# OW <> Canvas Standup
## Action Items
-
**Vedant Parikh**
Continue Aviation Edge scraper (05:00)

**Ohoud Zitan**
Provide updated purpose of travel data (06:16)
`;

const CLICKUP_SYNC_RUN_ID = "clickup-sync-1";

async function seedConnector(db: Kysely<DB>, connectorId: string, source: string): Promise<void> {
  const userId = `${connectorId}-user`;
  await db
    .insertInto("users")
    .values({ id: userId, name: userId, email: `${userId}@example.com` })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorId,
      connector_type: source,
      auth_type: "api_key",
      credentials: "{}",
      created_by: userId,
      scope_config: "{}",
    })
    .execute();
}

async function seedFile(
  db: Kysely<DB>,
  input: { id: string; connectorId: string; source: string; content: string; category: "meeting" | "structured" },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.id,
      connector_config_id: input.connectorId,
      provider_file_id: input.id,
      file_name: input.id,
      file_type: input.category,
      content_category: input.category,
      content: input.content,
      source: input.source,
      content_hash: `hash-${input.id}`,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedAttendee(db: Kysely<DB>, input: { fileId: string; name: string; email: string }): Promise<void> {
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.fileId,
    connectorConfigId: "connector-a",
    createdByUserId: "connector-a-user",
    contentHash: `hash-${input.fileId}`,
    source: "fireflies",
    factType: "attendee",
    relation: "attended",
    subjectName: input.name,
    subjectEmail: input.email,
    subjectSource: "fireflies",
    subjectSourceId: `${input.fileId}:${input.email}`,
    raw: { providerFileId: input.fileId, attendee: { name: input.name, email: input.email } },
  });
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  await seedConnector(db, "connector-a", "fireflies");
  await seedConnector(db, "connector-b", "clickup");
  await seedFile(db, {
    id: "file-a",
    connectorId: "connector-a",
    source: "fireflies",
    content: MEETING_BODY,
    category: "meeting",
  });

  const entityRepo = createEntityRepository(db);
  const domainsRepo = createEntityDomainsRepository(db);
  const oliverWyman = await entityRepo.upsertEntity({
    name: "Oliver Wyman",
    sourceType: "company",
    status: "confirmed",
  });
  const vedant = await entityRepo.upsertPersonEntity({
    name: "Vedant Parikh",
    email: "vedant@canvasx.ai",
    subtype: "internal",
    source: "team",
    sourceId: "vedant",
  });
  await domainsRepo.upsertDomain({
    entityId: oliverWyman.id,
    domain: "oliverwyman.com",
    kind: "corporate",
    source: "manual",
    confidence: 1,
    isPrimary: true,
  });
  await domainsRepo.upsertDomainObservation({
    domain: "canvasx.ai",
    proposedCompanyName: "Canvas",
    observedPersonEntityId: vedant.id,
    evidenceFileId: "file-a",
    firstObservedByUserId: "connector-a-user",
  });
  await seedAttendee(db, { fileId: "file-a", name: "Vedant Parikh", email: "vedant@canvasx.ai" });
  await seedAttendee(db, { fileId: "file-a", name: "Ohoud Zitan", email: "ohoud.zitan@oliverwyman.com" });
}

async function seedSecondConnectorFacts(db: Kysely<DB>): Promise<void> {
  await seedFile(db, {
    id: "file-b",
    connectorId: "connector-b",
    source: "clickup",
    content: "Apollo delivery project",
    category: "structured",
  });
  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: "file-b",
    connectorConfigId: "connector-b",
    createdByUserId: "connector-b-user",
    contentHash: "hash-file-b",
    source: "clickup",
    factType: "structural_seed",
    relation: "seeded",
    subjectName: "Apollo",
    subjectSource: "clickup",
    subjectSourceId: "project-apollo",
    raw: { name: "Apollo", sourceType: "project", source: "clickup", sourceId: "project-apollo" },
  });
  const facts = createIndexedFileFactRepository(db);
  await facts.upsertFact({
    indexedFileId: "file-b",
    connectorConfigId: "connector-b",
    createdByUserId: "connector-b-user",
    contentHash: "hash-file-b",
    lastSeenSyncRunId: CLICKUP_SYNC_RUN_ID,
    source: "clickup",
    factType: "structural_task",
    relation: "mentioned",
    subjectName: "Deliver Apollo beta",
    subjectSource: "clickup",
    subjectSourceId: "task-apollo-beta",
    raw: {
      indexedFileId: "file-b",
      task: {
        sourceTaskId: "task-apollo-beta",
        externalRef: "APOLLO-1",
        title: "Deliver Apollo beta",
        statusType: "custom",
        statusRaw: "In Progress",
        priority: "high",
        dueAt: "2026-07-31T00:00:00.000Z",
        project: { name: "Apollo", source: "clickup", sourceId: "project-apollo" },
        cycle: {
          source: "clickup",
          externalRef: "sprint-apollo-7",
          name: "Sprint 7",
          scopeRef: { source: "clickup", sourceId: "project-apollo" },
          startsAt: "2026-07-13T00:00:00.000Z",
          endsAt: "2026-07-26T23:59:59.000Z",
          sequence: 7,
          isSprint: true,
        },
      },
    },
  });
  await facts.upsertFact({
    indexedFileId: "file-b",
    connectorConfigId: "connector-b",
    createdByUserId: "connector-b-user",
    contentHash: "hash-file-b",
    lastSeenSyncRunId: CLICKUP_SYNC_RUN_ID,
    source: "clickup",
    factType: "structural_task",
    relation: "mentioned",
    subjectName: "Document Apollo rollout",
    subjectSource: "clickup",
    subjectSourceId: "task-apollo-docs",
    raw: {
      indexedFileId: "file-b",
      task: {
        sourceTaskId: "task-apollo-docs",
        externalRef: "APOLLO-2",
        title: "Document Apollo rollout",
        statusType: "open",
        statusRaw: "Open",
        project: { name: "Apollo", source: "clickup", sourceId: "project-apollo" },
      },
    },
  });
}

async function semanticGraph(db: Kysely<DB>) {
  const entities = await db
    .selectFrom("entities")
    .select(["name", "source_type", "subtype", "status"])
    .where("deleted_at", "is", null)
    .orderBy("name")
    .execute();
  const domains = await db
    .selectFrom("entity_domains")
    .leftJoin("entities", "entities.id", "entity_domains.entity_id")
    .select(["entities.name as entity", "entity_domains.domain", "entity_domains.kind"])
    .where("entity_domains.entity_id", "is not", null)
    .orderBy("entity_domains.domain")
    .execute();
  const mentions = await db
    .selectFrom("entity_mentions")
    .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
    .select(["entities.name as entity", "entity_mentions.indexed_file_id as file", "entity_mentions.source"])
    .orderBy("entity_mentions.indexed_file_id")
    .orderBy("entities.name")
    .orderBy("entity_mentions.source")
    .execute();
  const relationships = await db
    .selectFrom("entity_relationships")
    .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
    .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
    .select([
      "source.name as source",
      "target.name as target",
      "entity_relationships.relationship_type as type",
      "entity_relationships.source as provenance",
    ])
    .where("entity_relationships.valid_to", "is", null)
    .orderBy("source.name")
    .orderBy("target.name")
    .orderBy("entity_relationships.relationship_type")
    .execute();
  const tasks = await db
    .selectFrom("tasks")
    .leftJoin("entities as parent", "parent.id", "tasks.parent_entity_id")
    .select([
      "parent.name as parent",
      "tasks.parent_source_ref",
      "tasks.parent_name",
      "tasks.source",
      "tasks.external_ref",
      "tasks.title",
      "tasks.normalized_title",
      "tasks.status",
      "tasks.status_raw",
      "tasks.status_authority",
      "tasks.priority",
      "tasks.due_at",
      "tasks.provenance",
      "tasks.source_task_id",
      "tasks.valid_to",
    ])
    .orderBy("tasks.source_task_id")
    .execute();
  const workCycles = await db
    .selectFrom("work_cycles")
    .leftJoin("entities as scope", "scope.id", "work_cycles.scope_entity_id")
    .select([
      "scope.name as scope",
      "work_cycles.connector_config_id",
      "work_cycles.source",
      "work_cycles.external_ref",
      "work_cycles.name",
      "work_cycles.sequence",
      "work_cycles.starts_at",
      "work_cycles.ends_at",
      "work_cycles.state",
      "work_cycles.last_seen_sync_run_id",
      "work_cycles.deleted_at",
    ])
    .orderBy("work_cycles.connector_config_id")
    .orderBy("work_cycles.source")
    .orderBy("work_cycles.external_ref")
    .execute();
  return { entities, domains, mentions, relationships, tasks, workCycles };
}

describe("scheduled post-sync graph parity", () => {
  const databases: Kysely<DB>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it("matches sequential connector pipelines when the coalesced pipeline covers domain promotion and floor retry", async () => {
    const sequential = await createTestDb();
    const coalesced = await createTestDb();
    databases.push(sequential, coalesced);
    await seedBase(sequential);
    await seedBase(coalesced);

    await runPostSyncGraphPipeline({
      db: sequential,
      syncLogger: createTestLogger(),
      affectedIndexedFileIds: ["file-a"],
      sources: ["fireflies"],
      workCycleReconciles: [],
    });
    await seedSecondConnectorFacts(sequential);
    await runPostSyncGraphPipeline({
      db: sequential,
      syncLogger: createTestLogger(),
      affectedIndexedFileIds: ["file-b"],
      sources: ["clickup"],
      workCycleReconciles: [{ connectorConfigId: "connector-b", syncRunId: CLICKUP_SYNC_RUN_ID }],
    });

    await seedSecondConnectorFacts(coalesced);
    await runPostSyncGraphPipeline({
      db: coalesced,
      syncLogger: createTestLogger(),
      affectedIndexedFileIds: ["file-a", "file-b"],
      sources: ["fireflies", "clickup"],
      workCycleReconciles: [{ connectorConfigId: "connector-b", syncRunId: CLICKUP_SYNC_RUN_ID }],
    });

    const coalescedDomains = await coalesced
      .selectFrom("entity_domains")
      .select("domain")
      .where("domain", "=", "canvasx.ai")
      .where("entity_id", "is not", null)
      .execute();
    const coalescedFloorFacts = await coalesced
      .selectFrom("indexed_file_facts")
      .select("id")
      .where("source", "=", "attendee_action_item")
      .where("deleted_at", "is", null)
      .execute();

    expect(coalescedDomains).toHaveLength(1);
    expect(coalescedFloorFacts).toHaveLength(2);
    const coalescedGraph = await semanticGraph(coalesced);
    expect(coalescedGraph.tasks).toHaveLength(2);
    expect(coalescedGraph.workCycles).toEqual([
      expect.objectContaining({
        connector_config_id: "connector-b",
        external_ref: "sprint-apollo-7",
        state: "active",
        last_seen_sync_run_id: CLICKUP_SYNC_RUN_ID,
      }),
    ]);
    expect(coalescedGraph).toEqual(await semanticGraph(sequential));
  });
});
