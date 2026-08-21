import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import type { CleanupVerdict } from "./cleanup-adjudication";
import { type CleanupApplyManifest, applyProjectCleanup } from "./cleanup-apply";

const USER_ID = "cleanup-apply-user";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await sql`INSERT INTO users (id, name) VALUES (${USER_ID}, 'Cleanup Apply User')`.execute(db);
  await db
    .insertInto("connector_configs")
    .values({
      id: "cleanup-apply-config",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "cleanup-apply-config",
      provider_file_id: `provider-${id}`,
      file_name: `${id}.md`,
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, aliases: string[] = []): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: aliases.length > 0 ? JSON.stringify(aliases) : null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedMention(db: Kysely<DB>, id: string, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id,
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "high",
      source: "cleanup-test",
      relation: "mentions",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

async function seedRelationship(
  db: Kysely<DB>,
  id: string,
  source: string,
  target: string,
  type = "related_to",
): Promise<void> {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: source,
      target_entity_id: target,
      relationship_type: type,
      confidence: "high",
      confidence_score: 1,
      source: "cleanup-test",
    })
    .execute();
}

function verdict(
  input: Partial<CleanupVerdict> & Pick<CleanupVerdict, "entityId" | "name" | "action">,
): CleanupVerdict {
  return {
    entityId: input.entityId,
    name: input.name,
    action: input.action,
    targetEntityId: input.targetEntityId ?? null,
    targetName: input.targetName ?? null,
    reason: input.reason ?? "test",
    evidence: input.evidence ?? [],
    mechanical: input.mechanical ?? false,
    approved: input.approved ?? true,
    validation: input.validation ?? "ok",
    validationReason: input.validationReason ?? null,
  };
}

async function restoreManifestSubset(db: Kysely<DB>, manifest: CleanupApplyManifest): Promise<void> {
  for (const entry of [...manifest.mutations].reverse()) {
    if (entry.table === "entity_merges" && entry.before === null) {
      await db
        .deleteFrom("entity_merges")
        .where("id", "=", entry.primaryKey.id as string)
        .execute();
    }
    if (entry.table === "entity_mentions" && entry.before) {
      await db
        .updateTable("entity_mentions")
        .set({ entity_id: entry.before.entity_id as string })
        .where("id", "=", entry.primaryKey.id as string)
        .execute();
    }
    if (entry.table === "entities" && entry.before) {
      await db
        .updateTable("entities")
        .set({
          aliases: entry.before.aliases as string | null,
          deleted_at: entry.before.deleted_at as string | null,
          merged_into_entity_id: entry.before.merged_into_entity_id as string | null,
          updated_at: entry.before.updated_at as string,
        })
        .where("id", "=", entry.primaryKey.id as string)
        .execute();
    }
  }
}

describe("project cleanup apply", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
    await seedBase(db);
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("merges transitively, repoints mentions and relationships, unions aliases, and soft-deletes sources", async () => {
    for (const id of ["file-a", "file-b"]) await seedFile(db, id);
    await seedEntity(db, "project-a", "Project A", ["Alpha"]);
    await seedEntity(db, "project-b", "Project B");
    await seedEntity(db, "project-c", "Project C", ["Canonical"]);
    await seedEntity(db, "project-d", "Project D");
    await seedMention(db, "mention-a", "project-a", "file-a");
    await seedMention(db, "mention-b", "project-b", "file-b");
    await seedRelationship(db, "rel-a-d", "project-a", "project-d");
    await seedRelationship(db, "rel-d-a", "project-d", "project-a");
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "unrelated-review-row",
        proposed_name: "Unrelated Candidate",
        normalized_name: "unrelated candidate",
        entity_type: "project",
        source: "llm_extraction",
        source_id: "llm_extraction:unrelated-review-row",
        candidate_entity_id: null,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: "system",
      })
      .execute();

    const result = await applyProjectCleanup(
      db,
      [
        verdict({ entityId: "project-a", name: "Project A", action: "merge_into", targetEntityId: "project-b" }),
        verdict({ entityId: "project-b", name: "Project B", action: "merge_into", targetEntityId: "project-c" }),
      ],
      { execute: true, verdictPath: "test-verdicts.json" },
    );

    expect(result.counts.merge_into.applied).toBe(2);
    await expect(
      db.selectFrom("entity_mentions").select(["entity_id"]).where("id", "=", "mention-a").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ entity_id: "project-c" });
    await expect(
      db
        .selectFrom("entity_relationships")
        .select(["source_entity_id", "target_entity_id"])
        .where("id", "=", "rel-a-d")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ source_entity_id: "project-c", target_entity_id: "project-d" });
    await expect(
      db
        .selectFrom("entity_relationships")
        .select(["source_entity_id", "target_entity_id"])
        .where("id", "=", "rel-d-a")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ source_entity_id: "project-d", target_entity_id: "project-c" });
    const survivor = await db
      .selectFrom("entities")
      .select(["aliases"])
      .where("id", "=", "project-c")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(survivor.aliases ?? "[]").sort()).toEqual(
      ["Alpha", "Canonical", "Project A", "Project B"].sort(),
    );
    const deleted = await db
      .selectFrom("entities")
      .select(["deleted_at", "merged_into_entity_id"])
      .where("id", "in", ["project-a", "project-b"])
      .orderBy("id")
      .execute();
    expect(deleted.every((row) => row.deleted_at && row.merged_into_entity_id === "project-c")).toBe(true);
    expect(result.manifest?.mutations.some((entry) => entry.table === "entity_review_queue")).toBe(false);
  });

  it("fails an archive that gained references while applying other rows in the same run", async () => {
    await seedEntity(db, "archive-me", "Archive Me");
    await seedEntity(db, "referencer", "Referencer");
    await seedEntity(db, "child", "Child");
    await seedEntity(db, "parent", "Parent");
    await seedRelationship(db, "rel-new", "archive-me", "referencer");

    const result = await applyProjectCleanup(
      db,
      [
        verdict({ entityId: "archive-me", name: "Archive Me", action: "archive" }),
        verdict({ entityId: "child", name: "Child", action: "nest_under", targetEntityId: "parent" }),
      ],
      { execute: true, verdictPath: "test-verdicts.json" },
    );

    expect(result.counts.archive.failed).toBe(1);
    expect(result.counts.nest_under.applied).toBe(1);
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "archive-me").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null });
    await expect(
      db
        .selectFrom("entity_relationships")
        .select(["source_entity_id", "target_entity_id", "relationship_type"])
        .where("source_entity_id", "=", "child")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ source_entity_id: "child", target_entity_id: "parent", relationship_type: "part_of" });
  });

  it("skips unapproved and validation-flagged rows and records before-values that restore a merge", async () => {
    await seedFile(db, "file-restore");
    await seedEntity(db, "merge-source", "Merge Source");
    await seedEntity(db, "merge-target", "Merge Target");
    await seedEntity(db, "unapproved", "Unapproved");
    await seedEntity(db, "flagged", "Flagged");
    await seedMention(db, "mention-restore", "merge-source", "file-restore");

    const result = await applyProjectCleanup(
      db,
      [
        verdict({
          entityId: "merge-source",
          name: "Merge Source",
          action: "merge_into",
          targetEntityId: "merge-target",
        }),
        verdict({ entityId: "unapproved", name: "Unapproved", action: "archive", approved: false }),
        verdict({
          entityId: "flagged",
          name: "Flagged",
          action: "merge_into",
          targetEntityId: "merge-target",
          validation: "needs_human_fix",
          validationReason: "test_flag",
        }),
      ],
      { execute: true, verdictPath: "test-verdicts.json" },
    );

    expect(result.counts.merge_into.applied).toBe(1);
    expect(result.counts.archive.skipped).toBe(1);
    expect(result.counts.merge_into.skipped).toBe(1);
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "unapproved").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null });
    await expect(
      db.selectFrom("entities").select("merged_into_entity_id").where("id", "=", "flagged").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ merged_into_entity_id: null });
    expect(result.manifest?.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "entities", primaryKey: { id: "merge-source" } }),
        expect.objectContaining({ table: "entity_mentions", primaryKey: { id: "mention-restore" } }),
        expect.objectContaining({ table: "entity_merges", before: null }),
      ]),
    );
    if (!result.manifest) throw new Error("manifest missing");

    await restoreManifestSubset(db, result.manifest);

    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "merge-source")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null, merged_into_entity_id: null });
    await expect(
      db
        .selectFrom("entity_mentions")
        .select("entity_id")
        .where("id", "=", "mention-restore")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ entity_id: "merge-source" });
  });
});
