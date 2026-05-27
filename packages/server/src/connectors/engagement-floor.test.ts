/**
 * engagement-floor tests — three load-bearing failure modes:
 *
 * 1. Cross-domain meeting with action items → emits one `engaged_with` per
 *    (action-item owner × other-company) pair. End-to-end including
 *    materialization into `entity_relationships`. If this slips, the floor
 *    silently produces no recall improvement — the whole reason we built
 *    this layer.
 * 2. Internal-only meeting (all attendees share a domain) → emits ZERO
 *    facts. Without this guard, every internal standup would manufacture
 *    a "engagement" edge to the same company, polluting the graph.
 * 3. Markdown without a recognisable Action Items section degrades to
 *    "no floor facts" without throwing — non-Fireflies sources (Drive
 *    docs, Granola, manual notes) should never crash this pipeline.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { applyEngagementFloor } from "./engagement-floor";

const CONNECTOR_ID = "cfg-ef";

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: "admin-ef",
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: new Date().toISOString(),
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "fireflies",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin-ef",
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
      file_name: id,
      file_type: "meeting",
      content_category: "meeting",
      source: "fireflies",
      content_hash: `hash-${id}`,
      is_archived: 0,
      source_updated_at: now,
      synced_at: now,
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, args: { id: string; name: string; sourceType: string }): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: args.id,
      name: args.name,
      source_type: args.sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedDomain(db: Kysely<DB>, args: { entityId: string; domain: string; kind: string }): Promise<void> {
  await db
    .insertInto("entity_domains")
    .values({
      id: randomUUID(),
      entity_id: args.entityId,
      domain: args.domain,
      kind: args.kind,
      is_primary: 1,
      confidence: 1.0,
      source: "manual",
    })
    .execute();
}

async function seedAttendee(db: Kysely<DB>, args: { fileId: string; name: string; email: string }): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: args.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: "admin-ef",
    contentHash: `hash-${args.fileId}`,
    source: "fireflies",
    factType: "attendee",
    relation: "attended",
    subjectName: args.name,
    subjectEmail: args.email,
    subjectSource: "fireflies",
    subjectSourceId: `${args.fileId}:${args.email}`,
    raw: { providerFileId: args.fileId, attendee: { name: args.name, email: args.email } },
  });
}

const OW_CANVAS_BODY = `# OW <> Canvas Standup
## Action Items
-
**Vedant Parikh**
Continue Aviation Edge scraper (05:00)

**Ohoud Zitan**
Provide updated purpose of travel data (06:16)
`;

describe("engagement-floor", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedConnector(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("emits engaged_with facts for each (action-item owner × other-company) pair and materializes into entity_relationships", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas", name: "Canvas", sourceType: "company" });
    await seedEntity(db, { id: "ent-ow", name: "Oliver Wyman", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas", domain: "canvasx.ai", kind: "corporate" });
    await seedDomain(db, { entityId: "ent-ow", domain: "oliverwyman.com", kind: "corporate" });

    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Apeksha Maithani", email: "apeksha@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Ohoud Zitan", email: "ohoud.zitan@oliverwyman.com" });

    const result = await applyEngagementFloor(
      { db, logger: createTestLogger() },
      {
        fileId,
        fileContent: OW_CANVAS_BODY,
        connectorConfigId: CONNECTOR_ID,
        contentHash: `hash-${fileId}`,
      },
    );

    expect(result.emitted).toBe(2);

    const { materializeUnmaterializedFacts } = await import("../entities/materialize");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const edges = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as src", "src.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as tgt", "tgt.id", "entity_relationships.target_entity_id")
      .select(["src.name as src", "tgt.name as tgt", "entity_relationships.relationship_type"])
      .where("entity_relationships.relationship_type", "=", "engaged_with")
      .orderBy("src.name")
      .execute();

    expect(edges).toEqual([
      { src: "Ohoud Zitan", tgt: "Canvas", relationship_type: "engaged_with" },
      { src: "Vedant Parikh", tgt: "Oliver Wyman", relationship_type: "engaged_with" },
    ]);
  });

  it("tombstones stale attendee-action facts when rerun emits no supported pairs", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas-stale", name: "Canvas", sourceType: "company" });
    await seedEntity(db, { id: "ent-ow-stale", name: "Oliver Wyman", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas-stale", domain: "canvasx.ai", kind: "corporate" });
    await seedDomain(db, { entityId: "ent-ow-stale", domain: "oliverwyman.com", kind: "corporate" });
    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Ohoud Zitan", email: "ohoud.zitan@oliverwyman.com" });

    const first = await applyEngagementFloor(
      { db, logger: createTestLogger() },
      {
        fileId,
        fileContent: OW_CANVAS_BODY,
        connectorConfigId: CONNECTOR_ID,
        contentHash: `hash-${fileId}`,
      },
    );
    expect(first.emitted).toBe(2);

    const { materializeUnmaterializedFacts } = await import("../entities/materialize");
    await materializeUnmaterializedFacts(db, createTestLogger());

    const second = await applyEngagementFloor(
      { db, logger: createTestLogger() },
      {
        fileId,
        fileContent: "Meeting notes without an action item section.",
        connectorConfigId: CONNECTOR_ID,
        contentHash: `hash-${fileId}`,
      },
    );

    expect(second.emitted).toBe(0);
    expect(second.tombstoned).toBe(2);

    const activeFacts = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "attendee_action_item")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(activeFacts.count)).toBe(0);

    const edges = await db
      .selectFrom("entity_relationships")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("relationship_type", "=", "engaged_with")
      .executeTakeFirstOrThrow();
    expect(Number(edges.count)).toBe(0);
  });

  it("emits zero facts for an internal-only meeting (one company across all attendees)", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas-2", name: "Canvas", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas-2", domain: "canvasx.ai", kind: "corporate" });

    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Apeksha Maithani", email: "apeksha@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Himanshu Kalra", email: "himanshu@canvasx.ai" });

    const result = await applyEngagementFloor(
      { db, logger: createTestLogger() },
      {
        fileId,
        fileContent: "## Action Items\n-\n**Vedant Parikh**\nInternal task (00:00)\n",
        connectorConfigId: CONNECTOR_ID,
        contentHash: `hash-${fileId}`,
      },
    );

    expect(result.emitted).toBe(0);

    const factCount = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "attendee_action_item")
      .executeTakeFirstOrThrow();
    expect(Number(factCount.count)).toBe(0);
  });

  it("returns zero without throwing when the markdown has no recognisable Action Items section", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas-3", name: "Canvas", sourceType: "company" });
    await seedEntity(db, { id: "ent-ow-3", name: "Oliver Wyman", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas-3", domain: "canvasx.ai", kind: "corporate" });
    await seedDomain(db, { entityId: "ent-ow-3", domain: "oliverwyman.com", kind: "corporate" });
    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Ohoud Zitan", email: "ohoud.zitan@oliverwyman.com" });

    const body =
      "A free-form Drive doc.\n\nVedant talked with Ohoud about Aviation Edge.\nNo action items section here, just prose.";

    const result = await applyEngagementFloor(
      { db, logger: createTestLogger() },
      {
        fileId,
        fileContent: body,
        connectorConfigId: CONNECTOR_ID,
        contentHash: `hash-${fileId}`,
      },
    );

    expect(result.emitted).toBe(0);
  });
});
