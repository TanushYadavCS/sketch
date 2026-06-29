import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { type BuildMaterializeDepsOptions, buildMaterializeDeps, configureMaterializeDefaults } from "./materialize";
import type { ProposeEntityType } from "./propose";
import { recreateEntityGraph } from "./recreate";

const USER_ID = "recreate-structural-user";
const CONNECTOR_ID = "recreate-structural-connector";
const PERSON_SOURCE_ID = "user-priya";
const PROJECT_SOURCE_ID = "proj-atlas";
const TASK_SOURCE_ID = "task-atlas-1";

type MaterializeDefaultsSnapshot = Pick<
  BuildMaterializeDepsOptions,
  | "llmPromotionThreshold"
  | "llmTaskCorroborationThreshold"
  | "featureAutoMintThreshold"
  | "birthGateTypes"
  | "birthGateLiveTypes"
  | "structuralAutoBirthTypes"
  | "birthGateDryRun"
  | "experimentalFlag"
>;

async function snapshotMaterializeDefaults(db: Kysely<DB>): Promise<MaterializeDefaultsSnapshot> {
  const deps = await buildMaterializeDeps(db);
  return {
    llmPromotionThreshold: deps.llmPromotionThreshold,
    llmTaskCorroborationThreshold: deps.llmTaskCorroborationThreshold,
    featureAutoMintThreshold: deps.featureAutoMintThreshold,
    birthGateTypes: new Set(deps.birthGateTypes),
    birthGateLiveTypes: new Set(deps.birthGateLiveTypes),
    structuralAutoBirthTypes: new Set(deps.structuralAutoBirthTypes),
    birthGateDryRun: deps.birthGateDryRun,
    experimentalFlag: deps.experimentalFlag,
  };
}

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Recreate Structural User",
      email: "recreate-structural@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "linear",
      auth_type: "api_key",
      credentials: "{}",
      created_by: USER_ID,
      scope_config: "{}",
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.txt`,
      file_type: "issue",
      content_category: "structured",
      content: id,
      source: "linear",
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: now,
    })
    .execute();
}

async function seedStructuralFacts(db: Kysely<DB>): Promise<void> {
  await seedFile(db, "task-file");
  const factRepo = createIndexedFileFactRepository(db);

  await factRepo.upsertFact({
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source: "linear",
    factType: "structural_seed",
    relation: "seeded",
    subjectName: "Atlas Launch",
    subjectSource: "linear",
    subjectSourceId: PROJECT_SOURCE_ID,
    raw: { sourceType: "project", sourceUrl: "https://linear.app/project/atlas" },
  });

  await factRepo.upsertFact({
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source: "linear",
    factType: "person_seed",
    relation: "seeded",
    subjectName: "Priya Shah",
    subjectEmail: "priya@example.com",
    subjectSource: "linear",
    subjectSourceId: PERSON_SOURCE_ID,
    raw: { subtype: "internal" },
  });

  await factRepo.upsertFact({
    indexedFileId: "task-file",
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: USER_ID,
    source: "linear",
    factType: "structural_task",
    relation: "mentioned",
    subjectName: "Build account spine",
    subjectSource: "linear",
    subjectSourceId: TASK_SOURCE_ID,
    raw: {
      indexedFileId: "task-file",
      task: {
        sourceTaskId: TASK_SOURCE_ID,
        externalRef: "SKETCH-1",
        title: "Build account spine",
        statusType: "started",
        statusRaw: "In Progress",
        project: { name: "Atlas Launch", source: "linear", sourceId: PROJECT_SOURCE_ID },
        assignee: {
          name: "Priya Shah",
          email: "priya@example.com",
          source: "linear",
          sourceId: PERSON_SOURCE_ID,
        },
      },
    },
  });
}

async function seedCoMentionFacts(db: Kysely<DB>, fileIds: string[]): Promise<void> {
  const factRepo = createIndexedFileFactRepository(db);
  for (const fileId of fileIds) {
    await seedFile(db, fileId);
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      factType: "assignee",
      relation: "assigned",
      subjectName: "Priya Shah",
      subjectEmail: "priya@example.com",
      subjectSource: "linear",
      subjectSourceId: PERSON_SOURCE_ID,
      raw: {
        providerFileId: fileId,
        sourceRefKey: `linear:${PERSON_SOURCE_ID}`,
        assignee: { name: "Priya Shah", email: "priya@example.com", source: "linear", sourceId: PERSON_SOURCE_ID },
      },
    });
    await factRepo.upsertFact({
      indexedFileId: fileId,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      source: "linear",
      factType: "parent_entity",
      relation: "mentioned",
      subjectName: "Atlas Launch",
      subjectSource: "linear",
      subjectSourceId: PROJECT_SOURCE_ID,
      raw: {
        providerFileId: fileId,
        parent: { source: "linear", sourceId: PROJECT_SOURCE_ID },
      },
    });
  }
}

async function runRecreate(db: Kysely<DB>, experimentalFlag: boolean): Promise<void> {
  configureMaterializeDefaults({
    structuralAutoBirthTypes: new Set<ProposeEntityType>(["project"]),
    experimentalFlag: true,
  });
  await recreateEntityGraph({
    db,
    logger: createTestLogger(),
    triggeredByUserId: USER_ID,
    experimentalFlag,
    skipEnrichment: true,
    coMentionContributesToThreshold: 2,
  });
}

async function contributesToRows(db: Kysely<DB>) {
  return db
    .selectFrom("entity_relationships")
    .select(["source", "relationship_type", "confidence"])
    .where("relationship_type", "=", "contributes_to")
    .orderBy("source", "asc")
    .execute();
}

describe("recreateEntityGraph structural assignee rebuild", () => {
  let db: Kysely<DB>;
  let previousMaterializeDefaults: MaterializeDefaultsSnapshot | undefined;

  beforeEach(async () => {
    db = await createTestDb();
    previousMaterializeDefaults = await snapshotMaterializeDefaults(db);
    await seedBase(db);
  });

  afterEach(async () => {
    if (previousMaterializeDefaults) configureMaterializeDefaults(previousMaterializeDefaults);
    await db.destroy();
  });

  it("mints a structural_assignee contributes_to edge during reconstruct", async () => {
    await seedStructuralFacts(db);

    await runRecreate(db, true);

    const relationships = await contributesToRows(db);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      source: "structural_assignee",
      relationship_type: "contributes_to",
      confidence: "INFERRED",
    });
  });

  it("does not mint structural_assignee edges when experimentalFlag is false", async () => {
    await seedStructuralFacts(db);

    await runRecreate(db, false);

    const relationships = await contributesToRows(db);
    expect(relationships.filter((row) => row.source === "structural_assignee")).toHaveLength(0);
  });

  it("keeps structural_assignee precedence over recreate co-mention sweep", async () => {
    await seedStructuralFacts(db);
    await seedCoMentionFacts(db, ["co-mention-1", "co-mention-2"]);

    await runRecreate(db, true);

    const relationships = await contributesToRows(db);
    expect(relationships.map((row) => row.source)).toEqual(["structural_assignee"]);
  });
});
