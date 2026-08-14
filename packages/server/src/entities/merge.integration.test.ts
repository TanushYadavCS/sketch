import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { mergeEntities, unmergeEntities } from "./merge";

const USER_ID = "merge-integrity-user";

async function seedEntity(db: Kysely<DB>, id: string, name: string): Promise<void> {
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
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedTask(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("tasks")
    .values({
      id: "task-parented-fragment",
      parent_entity_id: "loser",
      parent_source_ref: null,
      parent_name: null,
      source: "project-minting-acceptance",
      external_ref: null,
      title: "Parented fragment task",
      normalized_title: "parented fragment task",
      status: "open",
      status_authority: "source",
      assignee_entity_id: "loser",
      priority: null,
      due_at: null,
      provenance: "source",
      source_task_id: "task-parented-fragment",
      status_changed_at: null,
      completed_at: null,
      valid_from: null,
      valid_to: null,
    })
    .execute();
}

describe("entity merge task integrity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await sql`INSERT INTO users (id, name) VALUES (${USER_ID}, 'Merge Integrity User')`.execute(db);
    await seedEntity(db, "survivor", "Canonical Project");
    await seedEntity(db, "loser", "Fragment Project");
    await seedTask(db);
    await db
      .insertInto("task_evidence")
      .values({ task_id: "task-parented-fragment", kind: "entity", ref_id: "loser" })
      .execute();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("repoints task parent, task assignee, and task entity evidence, then restores them on unmerge", async () => {
    const result = await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });

    await expect(
      db
        .selectFrom("tasks")
        .select(["parent_entity_id", "assignee_entity_id"])
        .where("id", "=", "task-parented-fragment")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ parent_entity_id: "survivor", assignee_entity_id: "survivor" });
    await expect(
      db
        .selectFrom("task_evidence")
        .selectAll()
        .where("task_id", "=", "task-parented-fragment")
        .where("kind", "=", "entity")
        .execute(),
    ).resolves.toEqual([{ task_id: "task-parented-fragment", kind: "entity", ref_id: "survivor" }]);

    await unmergeEntities(db, { mergeId: result.mergeId, userId: USER_ID });

    await expect(
      db
        .selectFrom("tasks")
        .select(["parent_entity_id", "assignee_entity_id"])
        .where("id", "=", "task-parented-fragment")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ parent_entity_id: "loser", assignee_entity_id: "loser" });
    await expect(
      db
        .selectFrom("task_evidence")
        .selectAll()
        .where("task_id", "=", "task-parented-fragment")
        .where("kind", "=", "entity")
        .execute(),
    ).resolves.toEqual([{ task_id: "task-parented-fragment", kind: "entity", ref_id: "loser" }]);
  });
});
