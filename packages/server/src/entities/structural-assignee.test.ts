import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository } from "../db/repositories/entities";
import { createTaskRepository } from "../db/repositories/tasks";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { sweepCoMentionContributesTo } from "./co-mention-sweep";
import { reconcileStructuralAssigneeContributesTo } from "./structural-assignee";

const USER_ID = "structural-assignee-user";
const CONNECTOR_ID = "structural-assignee-connector";

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Structural Assignee User",
      email: "structural-assignee@example.com",
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

async function seedFile(db: Kysely<DB>, id: string, archived = false): Promise<void> {
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
      is_archived: archived ? 1 : 0,
      synced_at: now,
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType: string): Promise<string> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: "external",
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function seedStructuralTask(
  db: Kysely<DB>,
  input: {
    sourceTaskId: string;
    fileId: string;
    assigneeEntityId: string | null;
    parentEntityId: string | null;
  },
): Promise<string> {
  const repo = createTaskRepository(db);
  const result = await repo.upsertTask({
    parentEntityId: input.parentEntityId,
    parentSourceRef: null,
    parentName: input.parentEntityId ? "Project" : null,
    source: "linear",
    externalRef: input.sourceTaskId,
    title: input.sourceTaskId,
    status: "open",
    statusRaw: "open",
    statusAuthority: "external",
    assigneeEntityId: input.assigneeEntityId,
    priority: null,
    dueAt: null,
    provenance: "structural",
    sourceTaskId: input.sourceTaskId,
  });
  await repo.upsertEvidence(result.taskId, "file", input.fileId);
  return result.taskId;
}

async function seedExtractedCoMentions(
  db: Kysely<DB>,
  personId: string,
  targetId: string,
  fileIds: string[],
): Promise<void> {
  const repo = createEntityRepository(db);
  for (const fileId of fileIds) {
    await repo.createMention({
      entityId: personId,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });
    await repo.createMention({
      entityId: targetId,
      indexedFileId: fileId,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });
  }
}

async function relationshipRows(db: Kysely<DB>) {
  return db.selectFrom("entity_relationships").selectAll().orderBy("source_entity_id").execute();
}

async function evidenceRows(db: Kysely<DB>) {
  return db.selectFrom("entity_relationship_evidence").selectAll().orderBy("note").execute();
}

describe("reconcileStructuralAssigneeContributesTo", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates one structural edge with task-note evidence and is idempotent", async () => {
    const personId = await seedEntity(db, "person-happy", "Priya", "person");
    const projectId = await seedEntity(db, "project-happy", "Atlas", "project");
    await seedFile(db, "happy-file");
    const taskId = await seedStructuralTask(db, {
      sourceTaskId: "happy-task",
      fileId: "happy-file",
      assigneeEntityId: personId,
      parentEntityId: projectId,
    });

    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "files", indexedFileIds: ["happy-file"] },
    });
    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "files", indexedFileIds: ["happy-file"] },
    });

    const relationships = await relationshipRows(db);
    const evidence = await evidenceRows(db);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      source_entity_id: personId,
      target_entity_id: projectId,
      relationship_type: "contributes_to",
      confidence: "INFERRED",
      confidence_score: 0.9,
      source: "structural_assignee",
      valid_from: "",
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      relationship_id: relationships[0].id,
      indexed_file_id: "happy-file",
      chunk_index: -1,
      note: `structural_assignee:task:${taskId}`,
      source_fact_id: null,
    });
  });

  it("prunes the old assignee edge on reassignment and keeps the new edge", async () => {
    const personA = await seedEntity(db, "person-reassign-a", "A", "person");
    const personB = await seedEntity(db, "person-reassign-b", "B", "person");
    const projectId = await seedEntity(db, "project-reassign", "Reassign", "project");
    await seedFile(db, "reassign-file");
    await seedStructuralTask(db, {
      sourceTaskId: "reassign-task",
      fileId: "reassign-file",
      assigneeEntityId: personA,
      parentEntityId: projectId,
    });
    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "files", indexedFileIds: ["reassign-file"] },
    });

    await seedStructuralTask(db, {
      sourceTaskId: "reassign-task",
      fileId: "reassign-file",
      assigneeEntityId: personB,
      parentEntityId: projectId,
    });
    const summary = await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "files", indexedFileIds: ["reassign-file"] },
    });

    const relationships = await relationshipRows(db);
    expect(summary.removedEvidence).toBe(1);
    expect(summary.removedRelationships).toBe(1);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      source_entity_id: personB,
      target_entity_id: projectId,
      source: "structural_assignee",
    });
  });

  it("does not create an edge for a task without a parent project", async () => {
    const personId = await seedEntity(db, "person-orphan", "No Parent", "person");
    await seedFile(db, "orphan-file");
    await seedStructuralTask(db, {
      sourceTaskId: "orphan-task",
      fileId: "orphan-file",
      assigneeEntityId: personId,
      parentEntityId: null,
    });

    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "files", indexedFileIds: ["orphan-file"] },
    });

    expect(await relationshipRows(db)).toHaveLength(0);
    expect(await evidenceRows(db)).toHaveLength(0);
  });

  it("creates an edge from task scope when the supporting file was not touched", async () => {
    const personId = await seedEntity(db, "person-task-scope", "Task Scope", "person");
    const projectId = await seedEntity(db, "project-task-scope", "Old Project", "project");
    await seedFile(db, "old-file");
    const taskId = await seedStructuralTask(db, {
      sourceTaskId: "old-task",
      fileId: "old-file",
      assigneeEntityId: personId,
      parentEntityId: projectId,
    });

    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "tasks", taskIds: [taskId] },
    });

    const relationships = await relationshipRows(db);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({ source_entity_id: personId, target_entity_id: projectId });
    expect((await evidenceRows(db))[0].note).toBe(`structural_assignee:task:${taskId}`);
  });

  it("removes the structural edge when the task expires before reconciliation", async () => {
    const personId = await seedEntity(db, "person-expired", "Expired", "person");
    const projectId = await seedEntity(db, "project-expired", "Expired Project", "project");
    await seedFile(db, "expired-file");
    const taskId = await seedStructuralTask(db, {
      sourceTaskId: "expired-task",
      fileId: "expired-file",
      assigneeEntityId: personId,
      parentEntityId: projectId,
    });
    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "tasks", taskIds: [taskId] },
    });

    await db.updateTable("tasks").set({ valid_to: new Date().toISOString() }).where("id", "=", taskId).execute();
    const summary = await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "tasks", taskIds: [taskId] },
    });

    expect(summary.removedEvidence).toBe(1);
    expect(summary.removedRelationships).toBe(1);
    expect(await relationshipRows(db)).toHaveLength(0);
    expect(await evidenceRows(db)).toHaveLength(0);
  });

  it("removes co-mention evidence when structural takes over the same pair", async () => {
    const personId = await seedEntity(db, "person-takeover", "Takeover", "person");
    const projectId = await seedEntity(db, "project-takeover", "Takeover Project", "project");
    await seedFile(db, "takeover-1");
    await seedFile(db, "takeover-2");
    await seedFile(db, "takeover-3");
    await seedExtractedCoMentions(db, personId, projectId, ["takeover-1", "takeover-2", "takeover-3"]);
    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 3 });
    expect((await evidenceRows(db)).map((row) => row.note)).toEqual([
      `co_mention:${personId}:${projectId}`,
      `co_mention:${personId}:${projectId}`,
      `co_mention:${personId}:${projectId}`,
    ]);
    const taskId = await seedStructuralTask(db, {
      sourceTaskId: "takeover-task",
      fileId: "takeover-1",
      assigneeEntityId: personId,
      parentEntityId: projectId,
    });

    const summary = await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "tasks", taskIds: [taskId] },
    });

    const relationships = await relationshipRows(db);
    const evidence = await evidenceRows(db);
    expect(summary.removedCoMentionEvidence).toBe(3);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({ source: "structural_assignee", confidence: "INFERRED" });
    expect(evidence).toHaveLength(1);
    expect(evidence[0].note).toBe(`structural_assignee:task:${taskId}`);
  });

  it("keeps co-mention from adding evidence once a structural edge exists", async () => {
    const personId = await seedEntity(db, "person-defer", "Defer", "person");
    const projectId = await seedEntity(db, "project-defer", "Defer Project", "project");
    await seedFile(db, "defer-task-file");
    await seedFile(db, "defer-mention-1");
    await seedFile(db, "defer-mention-2");
    const taskId = await seedStructuralTask(db, {
      sourceTaskId: "defer-task",
      fileId: "defer-task-file",
      assigneeEntityId: personId,
      parentEntityId: projectId,
    });
    await reconcileStructuralAssigneeContributesTo(db, createTestLogger(), {
      scope: { kind: "tasks", taskIds: [taskId] },
    });
    await seedExtractedCoMentions(db, personId, projectId, ["defer-mention-1", "defer-mention-2"]);

    await sweepCoMentionContributesTo(db, createTestLogger(), { threshold: 2 });

    const relationships = await relationshipRows(db);
    const evidence = await evidenceRows(db);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({ source: "structural_assignee" });
    expect(evidence.map((row) => row.note)).toEqual([`structural_assignee:task:${taskId}`]);
  });
});
