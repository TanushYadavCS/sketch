import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runFeatureArchiveSweep } from "./feature-archive-sweep";

async function seedEntity(
  db: Kysely<DB>,
  args: { id: string; name: string; sourceType?: string; createdAt: string },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: args.id,
      name: args.name,
      source_type: args.sourceType ?? "feature",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: args.createdAt,
      updated_at: args.createdAt,
      ai_brief: null,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: `user-${id}`,
      name: `User ${id}`,
      email: `${id}@example.com`,
      email_verified_at: new Date().toISOString(),
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: `cfg-${id}`,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: `user-${id}`,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: `cfg-${id}`,
      provider_file_id: id,
      file_name: id,
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedMention(db: Kysely<DB>, entityId: string, fileId: string, source = "llm_extraction"): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: `mention-${entityId}-${fileId}-${source}`,
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "INFERRED",
      source,
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

async function seedSourceRef(db: Kysely<DB>, entityId: string, source = "llm_extraction"): Promise<void> {
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `ref-${entityId}-${source}`,
      entity_id: entityId,
      source,
      source_id: `${source}:${entityId}`,
      source_url: null,
      last_seen_at: new Date().toISOString(),
    })
    .execute();
}

describe("runFeatureArchiveSweep", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedFile(db, "file-1");
    await seedFile(db, "file-2");
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("archives only stale, low-mention, AI-only features", async () => {
    const now = Date.UTC(2026, 4, 27);
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    await seedEntity(db, { id: "archive-me", name: "Backend Work", createdAt: old });
    await seedEntity(db, { id: "enough-mentions", name: "Access Control Integration", createdAt: old });
    await seedEntity(db, { id: "recent", name: "New Feature", createdAt: recent });
    await seedEntity(db, { id: "manual-backed", name: "Manual Feature", createdAt: old });
    await seedEntity(db, { id: "manual-empty", name: "Manual Empty Feature", createdAt: old });
    await seedEntity(db, { id: "connector-backed", name: "Connector Feature", createdAt: old });

    await seedSourceRef(db, "archive-me");
    await seedSourceRef(db, "enough-mentions");
    await seedSourceRef(db, "recent");
    await seedMention(db, "archive-me", "file-1");
    await seedMention(db, "enough-mentions", "file-1");
    await seedMention(db, "enough-mentions", "file-2");
    await seedMention(db, "recent", "file-1");
    await seedMention(db, "manual-backed", "file-1", "manual");
    await seedMention(db, "connector-backed", "file-1");
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "connector-ref",
        entity_id: "connector-backed",
        source: "clickup",
        source_id: "clickup:feature",
        source_url: null,
        last_seen_at: old,
      })
      .execute();

    const result = await runFeatureArchiveSweep(db, createTestLogger(), { now: () => now });
    const rows = await db.selectFrom("entities").select(["id", "status"]).orderBy("id").execute();
    const status = new Map(rows.map((row) => [row.id, row.status]));

    expect(result.archived).toBe(1);
    expect(status.get("archive-me")).toBe("archived");
    expect(status.get("enough-mentions")).toBe("confirmed");
    expect(status.get("recent")).toBe("confirmed");
    expect(status.get("manual-backed")).toBe("confirmed");
    expect(status.get("manual-empty")).toBe("confirmed");
    expect(status.get("connector-backed")).toBe("confirmed");
  });
});
