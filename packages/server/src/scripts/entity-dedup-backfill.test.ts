import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { unmergeEntities } from "../entities/merge";
import { createTestDb } from "../test-utils";
import { runEntityDedupBackfill } from "./entity-dedup-backfill";

const USER_ID = "entity-dedup-backfill-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Backfill User", email: "backfill@example.com" }).execute();
}

async function seedEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    type: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.type,
      subtype: null,
      aliases: null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
}

async function seedCorporateDomain(db: Kysely<DB>, id: string, entityId: string, domain: string): Promise<void> {
  await db
    .insertInto("entity_domains")
    .values({
      id,
      entity_id: entityId,
      domain,
      kind: "corporate",
      is_primary: 1,
      confidence: 1,
      source: "test",
    })
    .execute();
}

describe("entity dedup backfill", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("dry-run reports a strict Redseer pair without mutating the graph", async () => {
    await seedEntity(db, { id: "redseer-a", name: "Redseer Consulting", type: "company" });
    await seedEntity(db, { id: "redseer-b", name: "RedseerConsulting", type: "company" });

    const result = await runEntityDedupBackfill(db, { userId: USER_ID });

    expect(result.mode).toBe("dry-run");
    expect(result.autoMergeCandidates).toEqual([
      expect.objectContaining({
        survivorId: "redseer-a",
        loserId: "redseer-b",
        survivorName: "Redseer Consulting",
        loserName: "RedseerConsulting",
        reason: "strict",
      }),
    ]);
    expect(result.queuedCandidates).toHaveLength(0);
    await expect(db.selectFrom("entities").selectAll().where("deleted_at", "is", null).execute()).resolves.toHaveLength(
      2,
    );
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("execute merges a strict pair, writes the ledger, and unmerge reverses it", async () => {
    await seedEntity(db, { id: "redseer-a", name: "Redseer Consulting", type: "company" });
    await seedEntity(db, { id: "redseer-b", name: "RedseerConsulting", type: "company" });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID });

    expect(result.merged).toEqual([
      expect.objectContaining({
        survivorId: "redseer-a",
        loserId: "redseer-b",
        reason: "strict",
      }),
    ]);
    const merge = await db.selectFrom("entity_merges").selectAll().executeTakeFirstOrThrow();
    expect(merge.survivor_entity_id).toBe("redseer-a");
    expect(merge.merged_entity_id).toBe("redseer-b");
    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "redseer-b")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ merged_into_entity_id: "redseer-a" });

    await unmergeEntities(db, { mergeId: merge.id, userId: USER_ID });

    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "redseer-b")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ deleted_at: null, merged_into_entity_id: null });
  });

  it("queues same-name people with different mapped companies instead of merging them", async () => {
    await seedEntity(db, { id: "company-a", name: "Acme", type: "company" });
    await seedEntity(db, { id: "company-b", name: "Beta", type: "company" });
    await seedCorporateDomain(db, "domain-a", "company-a", "acme.com");
    await seedCorporateDomain(db, "domain-b", "company-b", "beta.com");
    await seedEntity(db, {
      id: "person-a",
      name: "Alex Rao",
      type: "person",
      metadata: { email: "alex@acme.com" },
    });
    await seedEntity(db, {
      id: "person-b",
      name: "AlexRao",
      type: "person",
      metadata: { email: "alex@beta.com" },
    });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID });

    expect(result.merged).toHaveLength(0);
    expect(result.queued).toEqual([
      expect.objectContaining({
        survivorId: "person-a",
        loserId: "person-b",
        reason: "person_scope_mismatch",
      }),
    ]);
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(0);
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.source_id).not.toContain("\0");
  });

  it("re-resolves queued pairs after strict auto-merges", async () => {
    await seedEntity(db, { id: "redseer-a", name: "Redseer Consulting", type: "company" });
    await seedEntity(db, { id: "redseer-b", name: "RedseerConsulting", type: "company" });
    await seedEntity(db, { id: "redseer-c", name: "Redseer Consultng", type: "company" });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, fuzzyThreshold: 0.7 });

    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "redseer-b")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ merged_into_entity_id: "redseer-a" });
    expect(result.queued.some((pair) => pair.survivorId === "redseer-b" || pair.loserId === "redseer-b")).toBe(false);
    const queue = await db.selectFrom("entity_review_queue").selectAll().execute();
    expect(queue.some((row) => row.candidate_entity_id === "redseer-b")).toBe(false);
  });
});
