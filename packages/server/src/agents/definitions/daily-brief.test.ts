import type { Kysely, Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB, UsersTable } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import {
  DAILY_BRIEF_ENTITY_WINDOW_DAYS,
  DAILY_BRIEF_EVIDENCE_WINDOW_DAYS,
  buildDailyBriefCandidateContext,
  dailyBriefDefinition,
} from "./daily-brief";

const NOW = new Date("2026-06-25T08:00:00.000Z");

async function seedUser(
  db: Kysely<DB>,
  params: { id?: string; email?: string; authRole?: "member" | "admin" } = {},
): Promise<Selectable<UsersTable>> {
  const id = params.id ?? "user-1";
  await db
    .insertInto("users")
    .values({
      id,
      name: "Agent User",
      email: params.email ?? "agent@example.com",
      auth_role: params.authRole ?? "member",
    })
    .execute();
  return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function seedConnectorConfig(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "config-1",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      created_by: "user-1",
      scope_config: "{}",
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, params: { id: string; name: string; hotness?: number }): Promise<void> {
  const now = NOW.toISOString();
  await db
    .insertInto("entities")
    .values({
      id: params.id,
      name: params.name,
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: params.hotness ?? 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedIndexedFile(
  db: Kysely<DB>,
  params: { id: string; sourceUpdatedAt: string; restrictedTo?: string },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: params.id,
      connector_config_id: "config-1",
      provider_file_id: `provider-${params.id}`,
      file_name: `${params.id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: "brief evidence",
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: params.sourceUpdatedAt,
      source_created_at: null,
      synced_at: NOW.toISOString(),
      embedding_status: "pending",
    })
    .execute();

  if (params.restrictedTo) {
    await db.insertInto("file_access").values({ indexed_file_id: params.id, email: params.restrictedTo }).execute();
  }
}

async function seedMention(
  db: Kysely<DB>,
  params: { id: string; entityId: string; fileId: string; mentionedAt?: string },
): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: params.id,
      entity_id: params.entityId,
      indexed_file_id: params.fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
      mentioned_at: params.mentionedAt ?? NOW.toISOString(),
    })
    .execute();
}

describe("dailyBriefDefinition.buildInstructions", () => {
  it("is static and defers per-user values to the runtime context (prompt-cache safe)", () => {
    const instructions = dailyBriefDefinition.buildInstructions();

    expect(instructions).toContain("runtime context `sections`");
    expect(instructions).toContain("runtime context `maxItemsPerSection`");
    expect(instructions).toContain("`focus` field");
    expect(instructions).toContain("dailyBriefCandidateContext");
    expect(instructions).toContain("evidenceSince");
    expect(instructions).toContain("windowEnd");

    expect(instructions).toContain("todos:");
    expect(instructions).toContain("customer_updates:");
    expect(instructions).toContain("active_projects:");

    expect(instructions).not.toMatch(/at most \d+ items/);
  });
});

describe("buildDailyBriefCandidateContext", () => {
  let db: Kysely<DB>;
  let user: Selectable<UsersTable>;

  beforeEach(async () => {
    db = await createTestDb();
    user = await seedUser(db);
    await seedConnectorConfig(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("selects 7-day active entities, hot fallback entities inside 30 days, and excludes stale or invisible entities", async () => {
    await seedEntity(db, { id: "entity-recent", name: "Recent Project", hotness: 1 });
    await seedEntity(db, { id: "entity-hot", name: "Hot Eighth Day Project", hotness: 9 });
    await seedEntity(db, { id: "entity-stale", name: "Stale Hot Project", hotness: 100 });
    await seedEntity(db, { id: "entity-private", name: "Private Project", hotness: 50 });

    await seedIndexedFile(db, { id: "file-recent", sourceUpdatedAt: "2026-06-24T10:00:00.000Z" });
    await seedIndexedFile(db, { id: "file-hot", sourceUpdatedAt: "2026-06-17T10:00:00.000Z" });
    await seedIndexedFile(db, { id: "file-stale", sourceUpdatedAt: "2026-05-20T10:00:00.000Z" });
    await seedIndexedFile(db, {
      id: "file-private",
      sourceUpdatedAt: "2026-06-24T12:00:00.000Z",
      restrictedTo: "someone-else@example.com",
    });

    await seedMention(db, { id: "mention-recent", entityId: "entity-recent", fileId: "file-recent" });
    await seedMention(db, { id: "mention-hot", entityId: "entity-hot", fileId: "file-hot" });
    await seedMention(db, { id: "mention-stale", entityId: "entity-stale", fileId: "file-stale" });
    await seedMention(db, { id: "mention-private", entityId: "entity-private", fileId: "file-private" });

    const context = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    expect(context.entityWindowDays).toBe(DAILY_BRIEF_ENTITY_WINDOW_DAYS);
    expect(context.evidenceWindowDays).toBe(DAILY_BRIEF_EVIDENCE_WINDOW_DAYS);
    expect(context.windowEnd).toBe("2026-06-25T23:59:59.999Z");
    expect(context.entitySince).toBe("2026-06-18T23:59:59.999Z");
    expect(context.evidenceSince).toBe("2026-05-26T23:59:59.999Z");
    expect(context.recentEntities.map((entity) => entity.id)).toEqual(["entity-recent"]);
    expect(context.hotFallbackEntities.map((entity) => entity.id)).toEqual(["entity-hot"]);
    expect(context.recentEntities[0]).toMatchObject({
      reason: "recent_activity",
      evidenceCountLast30Days: 1,
      evidenceCountLast7Days: 1,
      sampleFileIds: ["file-recent"],
      sampleMentionIds: ["mention-recent"],
    });
    expect(context.hotFallbackEntities[0]).toMatchObject({
      reason: "hotness_fallback",
      evidenceCountLast30Days: 1,
      evidenceCountLast7Days: 0,
      sampleFileIds: ["file-hot"],
      sampleMentionIds: ["mention-hot"],
    });
  });

  it("does not put recent entities overflow into the hotness fallback list", async () => {
    for (let i = 0; i < 31; i += 1) {
      await seedEntity(db, { id: `entity-recent-${i}`, name: `Recent Project ${i}`, hotness: 100 + i });
      await seedIndexedFile(db, { id: `file-recent-${i}`, sourceUpdatedAt: "2026-06-24T10:00:00.000Z" });
      await seedMention(db, {
        id: `mention-recent-${i}`,
        entityId: `entity-recent-${i}`,
        fileId: `file-recent-${i}`,
      });
    }
    await seedEntity(db, { id: "entity-fallback", name: "Fallback Project", hotness: 1 });
    await seedIndexedFile(db, { id: "file-fallback", sourceUpdatedAt: "2026-06-17T10:00:00.000Z" });
    await seedMention(db, {
      id: "mention-fallback",
      entityId: "entity-fallback",
      fileId: "file-fallback",
    });

    const context = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    expect(context.recentEntities).toHaveLength(30);
    expect(context.hotFallbackEntities.map((entity) => entity.id)).toEqual(["entity-fallback"]);
    expect(context.hotFallbackEntities[0].evidenceCountLast7Days).toBe(0);
  });

  it("honors the admin content-read setting when building candidate context", async () => {
    user = await seedUser(db, { id: "admin-user", email: "admin@example.com", authRole: "admin" });
    await seedEntity(db, { id: "entity-private", name: "Private Project", hotness: 50 });
    await seedIndexedFile(db, {
      id: "file-private",
      sourceUpdatedAt: "2026-06-24T12:00:00.000Z",
      restrictedTo: "someone-else@example.com",
    });
    await seedMention(db, { id: "mention-private", entityId: "entity-private", fileId: "file-private" });

    const defaultContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["admin@example.com"],
    });

    const bypassContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: true,
      contentUserEmails: undefined,
    });

    expect(defaultContext.recentEntities).toEqual([]);
    expect(defaultContext.hotFallbackEntities).toEqual([]);
    expect(bypassContext.recentEntities.map((entity) => entity.id)).toEqual(["entity-private"]);
  });

  it("uses linked provider emails when filtering candidate visibility", async () => {
    await seedEntity(db, { id: "entity-provider-email", name: "Provider Email Project", hotness: 1 });
    await seedIndexedFile(db, {
      id: "file-provider-email",
      sourceUpdatedAt: "2026-06-24T12:00:00.000Z",
      restrictedTo: "provider@example.com",
    });
    await seedMention(db, {
      id: "mention-provider-email",
      entityId: "entity-provider-email",
      fileId: "file-provider-email",
    });

    const primaryOnlyContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    const linkedEmailContext = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-25",
      timezone: "UTC",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com", "provider@example.com"],
    });

    expect(primaryOnlyContext.recentEntities).toEqual([]);
    expect(linkedEmailContext.recentEntities.map((entity) => entity.id)).toEqual(["entity-provider-email"]);
  });

  it("anchors candidate windows to the requested output date instead of the current wall clock", async () => {
    await seedEntity(db, { id: "entity-historical", name: "Historical Project", hotness: 1 });
    await seedEntity(db, { id: "entity-future", name: "Future Project", hotness: 100 });
    await seedIndexedFile(db, { id: "file-historical", sourceUpdatedAt: "2026-06-15T12:00:00.000Z" });
    await seedIndexedFile(db, { id: "file-future", sourceUpdatedAt: "2026-06-24T12:00:00.000Z" });
    await seedMention(db, { id: "mention-historical", entityId: "entity-historical", fileId: "file-historical" });
    await seedMention(db, { id: "mention-future", entityId: "entity-future", fileId: "file-future" });

    const context = await buildDailyBriefCandidateContext({
      db,
      user,
      outputDate: "2026-06-15",
      timezone: "Asia/Kolkata",
      now: NOW,
      adminCanReadAllFiles: false,
      contentUserEmails: ["agent@example.com"],
    });

    expect(context.windowEnd).toBe("2026-06-15T18:29:59.999Z");
    expect(context.entitySince).toBe("2026-06-08T18:29:59.999Z");
    expect(context.evidenceSince).toBe("2026-05-16T18:29:59.999Z");
    expect(context.recentEntities.map((entity) => entity.id)).toEqual(["entity-historical"]);
    expect(context.hotFallbackEntities).toEqual([]);
  });
});
