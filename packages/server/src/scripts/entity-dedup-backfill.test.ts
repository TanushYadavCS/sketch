import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import type { AdjudicationGenerator } from "../entities/adjudicate";
import { unmergeEntities } from "../entities/merge";
import { createTestDb } from "../test-utils";
import { runEntityDedupBackfill } from "./entity-dedup-backfill";

const USER_ID = "entity-dedup-backfill-user";

function fakeGenerator(verdict: { match: string | null; confidence: string; reason: string }): AdjudicationGenerator {
  return { generateJSON: async <T>() => verdict as T };
}

function throwingGenerator(counter?: { calls: number }): AdjudicationGenerator {
  return {
    generateJSON: async () => {
      if (counter) counter.calls += 1;
      throw new Error("timeout");
    },
  };
}

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Backfill User", email: "backfill@example.com" }).execute();
}

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-1",
      connector_type: "test",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedEntity(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    type: string;
    metadata?: Record<string, unknown>;
    hotness?: number;
    createdAt?: string;
    status?: string;
    mergedIntoEntityId?: string | null;
    deletedAt?: string | null;
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
      status: input.status ?? "confirmed",
      hotness: input.hotness ?? 0,
      created_at: input.createdAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: input.deletedAt ?? null,
      merged_into_entity_id: input.mergedIntoEntityId ?? null,
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

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: "connector-1",
      provider_file_id: `provider-${id}`,
      file_name: `${id}.md`,
      file_type: "document",
      content_category: "document",
      source: "test",
      provider_url: `https://example.com/${id}`,
      synced_at: new Date().toISOString(),
      is_archived: 0,
    })
    .execute();
}

async function seedMention(db: Kysely<DB>, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: `mention-${entityId}-${fileId}`,
      entity_id: entityId,
      indexed_file_id: fileId,
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

async function seedRelationship(
  db: Kysely<DB>,
  id: string,
  input: { source: string; target: string; type: string; confidenceScore?: number },
): Promise<void> {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: input.source,
      target_entity_id: input.target,
      relationship_type: input.type,
      confidence: "EXTRACTED",
      confidence_score: input.confidenceScore ?? 0.95,
      source: "test",
    })
    .execute();
}

async function seedSharedCoMentionAnchor(
  db: Kysely<DB>,
  input: { leftId: string; rightId: string; anchorId: string; filePrefix: string },
): Promise<void> {
  for (const suffix of ["a", "b"]) {
    const fileId = `${input.filePrefix}-${suffix}`;
    await seedFile(db, fileId);
    await seedMention(db, input.leftId, fileId);
    await seedMention(db, input.rightId, fileId);
    await seedMention(db, input.anchorId, fileId);
  }
}

describe("entity dedup backfill", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
    await seedConnector(db);
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

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, useLlm: false });

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

  it("merges a confident token-set reorder through LLM adjudication", async () => {
    await seedEntity(db, { id: "ohoud-survivor", name: "Ohoud Zitan", type: "person", hotness: 10 });
    await seedEntity(db, { id: "ohoud-loser", name: "Zitan, Ohoud", type: "person" });
    const generator = fakeGenerator({
      match: "ohoud-survivor",
      confidence: "high",
      reason: "matching workplace context",
    });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, generator });

    expect(result.merged).toEqual([
      expect.objectContaining({ survivorId: "ohoud-survivor", loserId: "ohoud-loser", reason: "token-set" }),
    ]);
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(1);
    await expect(
      db.selectFrom("entities").select("merged_into_entity_id").where("id", "=", "ohoud-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ merged_into_entity_id: "ohoud-survivor" });
    const survivor = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", "ohoud-survivor")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(survivor.aliases ?? "[]")).toContain("Zitan, Ohoud");
  });

  it("records a confident token-set namesake rejection both ways without merging", async () => {
    await seedEntity(db, { id: "li-survivor", name: "Li Wang", type: "person" });
    await seedEntity(db, { id: "li-loser", name: "Wang Li", type: "person" });
    const generator = fakeGenerator({ match: null, confidence: "high", reason: "plausible namesake" });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, generator });

    expect(result.merged).toHaveLength(0);
    await expect(db.selectFrom("entities").selectAll().where("deleted_at", "is", null).execute()).resolves.toHaveLength(
      2,
    );
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(0);
    await expect(
      db.selectFrom("entity_alias_rejections").select(["entity_id", "rejected_name"]).orderBy("entity_id").execute(),
    ).resolves.toEqual([
      { entity_id: "li-loser", rejected_name: "Li Wang" },
      { entity_id: "li-survivor", rejected_name: "Wang Li" },
    ]);
  });

  it("queues uncertain token-set pairs for manual review", async () => {
    await seedEntity(db, { id: "li-survivor", name: "Li Wang", type: "person" });
    await seedEntity(db, { id: "li-loser", name: "Wang Li", type: "person" });
    const generator = fakeGenerator({ match: null, confidence: "low", reason: "thin evidence" });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, generator });

    expect(result.merged).toHaveLength(0);
    expect(result.queued).toEqual([expect.objectContaining({ reason: "token-set" })]);
    await expect(db.selectFrom("entities").selectAll().where("deleted_at", "is", null).execute()).resolves.toHaveLength(
      2,
    );
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(1);
    await expect(db.selectFrom("entity_alias_rejections").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("queues token-set pairs when adjudication generation fails", async () => {
    await seedEntity(db, { id: "li-survivor", name: "Li Wang", type: "person" });
    await seedEntity(db, { id: "li-loser", name: "Wang Li", type: "person" });

    const result = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, generator: throwingGenerator() });

    expect(result.adjudicated).toEqual([
      expect.objectContaining({ matchEntityId: null, confidence: "low", reason: "Entity adjudication failed." }),
    ]);
    expect(result.queued).toHaveLength(1);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(1);
    await expect(db.selectFrom("entity_alias_rejections").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("recalls adjacency pairs while pruning hubs and enforcing structural evidence", async () => {
    await seedEntity(db, { id: "real-a", name: "Orchid Runtime", type: "project", hotness: 10 });
    await seedEntity(db, { id: "real-b", name: "Cobalt Launch", type: "project", hotness: 1 });
    await seedEntity(db, { id: "hub-only-a", name: "Copper Matrix", type: "project" });
    await seedEntity(db, { id: "hub-only-b", name: "Silver Orbit", type: "project" });
    await seedEntity(db, { id: "contributor", name: "Shared Builder", type: "person" });
    await seedEntity(db, { id: "contributor-2", name: "Second Builder", type: "person" });
    await seedEntity(db, { id: "hub", name: "Universal Contributor", type: "person" });
    await seedEntity(db, { id: "anchor", name: "Context Anchor", type: "company" });
    const fillerNames = [
      "Alder",
      "Banyan",
      "Cedar",
      "Daphne",
      "Elm",
      "Fern",
      "Ginkgo",
      "Hazel",
      "Iris",
      "Juniper",
      "Koa",
      "Laurel",
      "Maple",
      "Nettle",
      "Olive",
      "Pine",
      "Quince",
      "Rowan",
      "Sage",
      "Tamarind",
      "Ulmus",
      "Verbena",
      "Willow",
      "Xenia",
      "Yarrow",
      "Zinnia",
      "Acacia",
      "Birch",
      "Cypress",
      "Dogwood",
      "Elder",
    ];
    for (let i = 0; i < fillerNames.length; i += 1) {
      const fillerId = `hub-filler-${i}`;
      await seedEntity(db, { id: fillerId, name: fillerNames[i], type: "product" });
      await seedRelationship(db, `rel-hub-${fillerId}`, {
        source: "hub",
        target: fillerId,
        type: "contributes_to",
      });
    }
    for (const target of ["real-a", "real-b", "hub-only-a", "hub-only-b"]) {
      await seedRelationship(db, `rel-hub-${target}`, { source: "hub", target, type: "contributes_to" });
    }
    for (const target of ["real-a", "real-b"]) {
      await seedRelationship(db, `rel-contributor-${target}`, {
        source: "contributor",
        target,
        type: "contributes_to",
      });
      await seedRelationship(db, `rel-contributor-2-${target}`, {
        source: "contributor-2",
        target,
        type: "contributes_to",
      });
    }
    await seedSharedCoMentionAnchor(db, {
      leftId: "real-a",
      rightId: "real-b",
      anchorId: "anchor",
      filePrefix: "real-shared",
    });
    await seedSharedCoMentionAnchor(db, {
      leftId: "hub-only-a",
      rightId: "hub-only-b",
      anchorId: "anchor",
      filePrefix: "hub-only-shared",
    });

    const result = await runEntityDedupBackfill(db, {
      execute: true,
      userId: USER_ID,
      generator: fakeGenerator({ match: "real-a", confidence: "high", reason: "shared contributor and files" }),
    });

    expect(result.autoMergeCandidates).toHaveLength(0);
    expect(result.queuedCandidates).toEqual([
      expect.objectContaining({ survivorId: "real-a", loserId: "real-b", reason: "adjacency" }),
    ]);
    expect(result.counts.adjacencyCandidates).toBe(1);
    expect(result.merged).toEqual([
      expect.objectContaining({ survivorId: "real-a", loserId: "real-b", reason: "adjacency" }),
    ]);
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(1);
    const survivor = await db
      .selectFrom("entities")
      .select("aliases")
      .where("id", "=", "real-a")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(survivor.aliases ?? "[]")).toContain("Cobalt Launch");
  });

  it("owner-gates project candidates without durable rejection or LLM calls", async () => {
    const calls = { calls: 0 };
    await seedEntity(db, { id: "company-a", name: "Maaden", type: "company" });
    await seedEntity(db, { id: "company-b", name: "GCC", type: "company" });
    await seedEntity(db, { id: "project-a", name: "Maaden Dashboard", type: "project" });
    await seedEntity(db, { id: "project-b", name: "Dashboard Maaden", type: "project" });
    await seedRelationship(db, "rel-project-a-owner", {
      source: "project-a",
      target: "company-a",
      type: "engagement_for",
    });
    await seedRelationship(db, "rel-project-b-owner", {
      source: "project-b",
      target: "company-b",
      type: "engagement_for",
    });

    const result = await runEntityDedupBackfill(db, {
      execute: true,
      userId: USER_ID,
      generator: throwingGenerator(calls),
    });

    expect(result.merged).toHaveLength(0);
    expect(result.adjudicated).toEqual([
      expect.objectContaining({
        pair: expect.objectContaining({ survivorId: "project-a", loserId: "project-b", reason: "token-set" }),
        matchEntityId: null,
        confidence: "low",
        reason: "owner-scope mismatch",
      }),
    ]);
    expect(result.counts.ownerGateBlocked).toBe(1);
    expect(calls.calls).toBe(0);
    await expect(db.selectFrom("entity_alias_rejections").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(0);
  });

  it("owner-gates strict project and team pairs before auto-merge", async () => {
    const calls = { calls: 0 };
    await seedEntity(db, { id: "company-a", name: "Maaden", type: "company" });
    await seedEntity(db, { id: "company-b", name: "GCC", type: "company" });
    await seedEntity(db, { id: "project-a", name: "Shared Dashboard", type: "project" });
    await seedEntity(db, { id: "project-b", name: "SharedDashboard", type: "project" });
    await seedEntity(db, { id: "team-a", name: "Platform Team", type: "team" });
    await seedEntity(db, { id: "team-b", name: "PlatformTeam", type: "team" });
    await seedRelationship(db, "rel-project-a-owner", {
      source: "project-a",
      target: "company-a",
      type: "engagement_for",
    });
    await seedRelationship(db, "rel-project-b-owner", {
      source: "project-b",
      target: "company-b",
      type: "engagement_for",
    });
    await seedRelationship(db, "rel-team-a-owner", { source: "team-a", target: "company-a", type: "part_of" });
    await seedRelationship(db, "rel-team-b-owner", { source: "team-b", target: "company-b", type: "part_of" });

    const result = await runEntityDedupBackfill(db, {
      execute: true,
      userId: USER_ID,
      generator: throwingGenerator(calls),
    });

    expect(result.autoMergeCandidates).toHaveLength(0);
    expect(result.queuedCandidates).toEqual([
      expect.objectContaining({
        entityType: "project",
        survivorId: "project-a",
        loserId: "project-b",
        reason: "strict",
      }),
      expect.objectContaining({ entityType: "team", survivorId: "team-a", loserId: "team-b", reason: "strict" }),
    ]);
    expect(result.merged).toHaveLength(0);
    expect(result.counts.ownerGateBlocked).toBe(2);
    expect(calls.calls).toBe(0);
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db.selectFrom("entity_review_queue").selectAll().execute()).resolves.toHaveLength(2);
  });

  it("resolves a three-node adjacency cluster over two runs", async () => {
    await seedEntity(db, { id: "cluster-a", name: "Atlas Boreal One", type: "project", hotness: 10 });
    await seedEntity(db, { id: "cluster-b", name: "Zephyr Atlas Boreal", type: "project", hotness: 5 });
    await seedEntity(db, { id: "cluster-c", name: "Boreal Three", type: "project", hotness: 1 });
    await seedEntity(db, { id: "contributor-ab", name: "Contributor AB", type: "person" });
    await seedEntity(db, { id: "contributor-bc", name: "Contributor BC", type: "person" });
    await seedEntity(db, { id: "anchor-ab", name: "Anchor AB", type: "company" });
    await seedEntity(db, { id: "anchor-bc", name: "Anchor BC", type: "company" });
    for (const target of ["cluster-a", "cluster-b"]) {
      await seedRelationship(db, `rel-ab-${target}`, { source: "contributor-ab", target, type: "contributes_to" });
    }
    for (const target of ["cluster-b", "cluster-c"]) {
      await seedRelationship(db, `rel-bc-${target}`, { source: "contributor-bc", target, type: "contributes_to" });
    }
    await seedSharedCoMentionAnchor(db, {
      leftId: "cluster-a",
      rightId: "cluster-b",
      anchorId: "anchor-ab",
      filePrefix: "cluster-ab",
    });
    await seedSharedCoMentionAnchor(db, {
      leftId: "cluster-b",
      rightId: "cluster-c",
      anchorId: "anchor-bc",
      filePrefix: "cluster-bc",
    });

    const generator = fakeGenerator({ match: "cluster-a", confidence: "high", reason: "same adjacency cluster" });
    const first = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, generator });

    expect(first.merged).toEqual([
      expect.objectContaining({ survivorId: "cluster-a", loserId: "cluster-b", reason: "adjacency" }),
      expect.objectContaining({ survivorId: "cluster-a", loserId: "cluster-c", reason: "adjacency" }),
    ]);
    expect(first.skipped).toHaveLength(0);
    await expect(
      db.selectFrom("entities").select("merged_into_entity_id").where("id", "=", "cluster-c").executeTakeFirst(),
    ).resolves.toMatchObject({ merged_into_entity_id: "cluster-a" });

    const second = await runEntityDedupBackfill(db, { execute: true, userId: USER_ID, generator });

    expect(second.merged).toHaveLength(0);
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(2);
  });
});
