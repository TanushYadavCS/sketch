import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityRepository, whereLiveEntity } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { buildMaterializeDeps } from "./materialize-deps";
import { EntityMergeError, mergeEntities, unmergeEntities } from "./merge";
import { proposeEntity } from "./propose";

const USER_ID = "merge-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Merge User", email: "merge@example.com" }).execute();
}

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: "merge-config",
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
      connector_config_id: "merge-config",
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

async function seedEntity(
  db: Kysely<DB>,
  id: string,
  name: string,
  sourceType = "person",
  provenanceTier = "inferred",
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: provenanceTier,
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
}

async function seedRelationship(
  db: Kysely<DB>,
  id: string,
  source: string,
  target: string,
  type = "works_at",
): Promise<void> {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: source,
      target_entity_id: target,
      relationship_type: type,
      confidence: "high",
      confidence_score: 0.9,
      source: "test",
      valid_from: "",
    })
    .execute();
}

describe("entity merge core", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
    await seedConnector(db);
    await seedFile(db, "file-a");
    await seedFile(db, "file-b");
    await seedFile(db, "file-c");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("re-points fan-out, drops self-loops, and tombstones the loser", async () => {
    await seedEntity(db, "survivor", "Alex");
    await seedEntity(db, "loser", "Alex Duplicate");
    await seedEntity(db, "company", "Acme", "company");
    await db
      .insertInto("entity_source_refs")
      .values([
        { id: "ref-survivor", entity_id: "survivor", source: "seed", source_id: "survivor", last_seen_at: "2026" },
        { id: "ref-loser", entity_id: "loser", source: "seed", source_id: "loser", last_seen_at: "2026" },
      ])
      .execute();
    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-loser",
        entity_id: "loser",
        indexed_file_id: "file-a",
        confidence: "EXTRACTED",
        source: "test",
        relation: "mentioned",
        mentioned_at: "2026",
      })
      .execute();
    await seedRelationship(db, "rel-company", "loser", "company");
    await seedRelationship(db, "rel-self", "loser", "survivor", "partner_of");

    await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });

    await expect(
      db.selectFrom("entity_mentions").selectAll().where("id", "=", "mention-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "survivor" });
    await expect(
      db.selectFrom("entity_source_refs").selectAll().where("id", "=", "ref-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "survivor" });
    await expect(
      db.selectFrom("entity_relationships").selectAll().where("id", "=", "rel-company").executeTakeFirst(),
    ).resolves.toMatchObject({ source_entity_id: "survivor", target_entity_id: "company" });
    await expect(
      db.selectFrom("entity_relationships").selectAll().where("id", "=", "rel-self").executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      db.selectFrom("entities").selectAll().where("id", "=", "loser").executeTakeFirst(),
    ).resolves.toMatchObject({
      merged_into_entity_id: "survivor",
    });
    await expect(db.selectFrom("entities").selectAll().where(whereLiveEntity()).execute()).resolves.toHaveLength(2);
  });

  it("keeps the strongest provenance tier when merging declared and inferred entities", async () => {
    await seedEntity(db, "survivor", "Alex", "person", "inferred");
    await seedEntity(db, "loser", "Alex Product Owner", "person", "declared");

    await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });

    await expect(
      db.selectFrom("entities").select(["provenance_tier"]).where("id", "=", "survivor").executeTakeFirst(),
    ).resolves.toEqual({ provenance_tier: "declared" });
  });

  it.each([
    ["external", "internal"],
    ["internal", "external"],
  ] as const)("keeps internal subtype when merging %s survivor and %s loser", async (survivorSubtype, loserSubtype) => {
    await seedEntity(db, "subtype-survivor", "Subtype Survivor");
    await seedEntity(db, "subtype-loser", "Subtype Loser");
    await db.updateTable("entities").set({ subtype: survivorSubtype }).where("id", "=", "subtype-survivor").execute();
    await db.updateTable("entities").set({ subtype: loserSubtype }).where("id", "=", "subtype-loser").execute();

    await mergeEntities(db, { survivorId: "subtype-survivor", loserId: "subtype-loser", userId: USER_ID });

    await expect(
      db.selectFrom("entities").select("subtype").where("id", "=", "subtype-survivor").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ subtype: "internal" });
  });

  it("unmerges re-pointed rows, collisions, self-loops, and relationship evidence", async () => {
    await seedEntity(db, "survivor", "Alex");
    await seedEntity(db, "loser", "Alex Duplicate");
    await seedEntity(db, "company", "Acme", "company");
    await db
      .insertInto("entity_mentions")
      .values([
        {
          id: "mention-survivor",
          entity_id: "survivor",
          indexed_file_id: "file-a",
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: "2026",
        },
        {
          id: "mention-loser",
          entity_id: "loser",
          indexed_file_id: "file-a",
          confidence: "EXTRACTED",
          source: "test",
          relation: "mentioned",
          mentioned_at: "2026",
        },
      ])
      .execute();
    await seedRelationship(db, "rel-survivor", "survivor", "company");
    await seedRelationship(db, "rel-loser", "loser", "company");
    await seedRelationship(db, "rel-self", "loser", "survivor", "partner_of");
    await db
      .insertInto("entity_relationship_evidence")
      .values([
        {
          id: "ev-survivor",
          relationship_id: "rel-survivor",
          indexed_file_id: "file-a",
          evidence_key: "same",
        },
        { id: "ev-loser-collide", relationship_id: "rel-loser", indexed_file_id: "file-b", evidence_key: "same" },
        { id: "ev-loser-move", relationship_id: "rel-loser", indexed_file_id: "file-c", evidence_key: "move" },
        { id: "ev-self", relationship_id: "rel-self", indexed_file_id: "file-c", evidence_key: "self" },
      ])
      .execute();

    const result = await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });
    await unmergeEntities(db, { mergeId: result.mergeId, userId: USER_ID });

    await expect(
      db.selectFrom("entities").selectAll().where("id", "=", "loser").executeTakeFirst(),
    ).resolves.toMatchObject({
      deleted_at: null,
      merged_into_entity_id: null,
    });
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("id", "=", "mention-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "loser" });
    await expect(
      db.selectFrom("entity_relationships").selectAll().where("id", "=", "rel-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ source_entity_id: "loser", target_entity_id: "company" });
    await expect(
      db.selectFrom("entity_relationships").selectAll().where("id", "=", "rel-self").executeTakeFirst(),
    ).resolves.toMatchObject({ source_entity_id: "loser", target_entity_id: "survivor" });
    await expect(
      db.selectFrom("entity_relationship_evidence").selectAll().where("id", "=", "ev-loser-move").executeTakeFirst(),
    ).resolves.toMatchObject({ relationship_id: "rel-loser" });
    await expect(
      db.selectFrom("entity_relationship_evidence").selectAll().where("id", "=", "ev-loser-collide").executeTakeFirst(),
    ).resolves.toMatchObject({ relationship_id: "rel-loser" });
    await expect(
      db.selectFrom("entity_relationship_evidence").selectAll().where("id", "=", "ev-self").executeTakeFirst(),
    ).resolves.toMatchObject({ relationship_id: "rel-self" });
  });

  it("rejects cross-type merges without mutation", async () => {
    await seedEntity(db, "person", "Alex");
    await seedEntity(db, "company", "Acme", "company");

    await expect(
      mergeEntities(db, { survivorId: "person", loserId: "company", userId: USER_ID }),
    ).rejects.toMatchObject({
      code: "TYPE_MISMATCH",
    });
    await expect(db.selectFrom("entity_merges").selectAll().execute()).resolves.toHaveLength(0);
    await expect(
      db.selectFrom("entities").selectAll().where("id", "=", "company").executeTakeFirst(),
    ).resolves.toMatchObject({
      deleted_at: null,
    });
  });

  it("handles scoped collisions, candidate JSON reversal, and redirected writes that survive unmerge", async () => {
    await seedEntity(db, "survivor", "Alex");
    await seedEntity(db, "loser", "Alex Duplicate");
    await db
      .insertInto("entity_contact_points")
      .values([
        { id: "cp-survivor", entity_id: "survivor", kind: "email", value: "a@example.com", source: "test" },
        { id: "cp-loser", entity_id: "loser", kind: "email", value: "a@example.com", source: "test" },
      ])
      .execute();
    await db
      .insertInto("entity_share_emails")
      .values([
        { entity_id: "survivor", email: "shared@example.com", granted_by_user_id: USER_ID },
        { entity_id: "loser", email: "shared@example.com", granted_by_user_id: USER_ID },
      ])
      .execute();
    await db
      .insertInto("entity_alias_rejections")
      .values([
        {
          id: "reject-survivor",
          entity_id: "survivor",
          rejected_name: "Al",
          normalized_rejected_name: "al",
          rejected_by: USER_ID,
        },
        {
          id: "reject-loser",
          entity_id: "loser",
          rejected_name: "Al",
          normalized_rejected_name: "al",
          rejected_by: USER_ID,
        },
      ])
      .execute();
    await db
      .insertInto("entity_domains")
      .values({
        id: "domain-loser",
        entity_id: "loser",
        domain: "loser.example.com",
        kind: "observed",
        is_primary: 0,
        confidence: 0.8,
        source: "test",
      })
      .execute();
    await db
      .insertInto("entity_candidates")
      .values({
        id: "candidate",
        name: "Candidate",
        type: "domain_observation",
        variations: null,
        first_seen_file_id: "file-a",
        seen_file_ids: JSON.stringify(["file-a"]),
        seen_count: 1,
        promoted_entity_id: "loser",
        created_at: "2026",
        updated_at: "2026",
        domain: "candidate.example.com",
        observed_person_entity_ids: JSON.stringify(["loser", "survivor"]),
        evidence_file_ids: JSON.stringify(["loser"]),
      })
      .execute();

    const repo = createEntityRepository(db);
    const result = await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });
    await repo.createMention({
      entityId: "loser",
      indexedFileId: "file-b",
      confidence: "EXTRACTED",
      source: "test",
      relation: "mentioned",
    });
    await unmergeEntities(db, { mergeId: result.mergeId, userId: USER_ID });

    await expect(
      db.selectFrom("entity_contact_points").selectAll().where("id", "=", "cp-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "loser" });
    await expect(
      db
        .selectFrom("entity_share_emails")
        .selectAll()
        .where("entity_id", "=", "loser")
        .where("email", "=", "shared@example.com")
        .executeTakeFirst(),
    ).resolves.toBeDefined();
    await expect(
      db.selectFrom("entity_alias_rejections").selectAll().where("id", "=", "reject-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "loser" });
    await expect(
      db.selectFrom("entity_domains").selectAll().where("id", "=", "domain-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "loser" });
    const candidate = await db
      .selectFrom("entity_candidates")
      .selectAll()
      .where("id", "=", "candidate")
      .executeTakeFirstOrThrow();
    expect(candidate.promoted_entity_id).toBe("loser");
    expect(candidate.observed_person_entity_ids).toBe(JSON.stringify(["loser", "survivor"]));
    expect(candidate.evidence_file_ids).toBe(JSON.stringify(["loser"]));
    await expect(
      db.selectFrom("entity_mentions").selectAll().where("indexed_file_id", "=", "file-b").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "survivor" });
  });

  it("keeps the survivor primary contact when moving a different loser primary", async () => {
    await seedEntity(db, "survivor", "Alex");
    await seedEntity(db, "loser", "Alex Duplicate");
    await db
      .insertInto("entity_contact_points")
      .values([
        {
          id: "cp-survivor",
          entity_id: "survivor",
          kind: "email",
          value: "survivor@example.com",
          is_primary: 1,
          source: "test",
        },
        {
          id: "cp-loser",
          entity_id: "loser",
          kind: "email",
          value: "loser@example.com",
          is_primary: 1,
          source: "test",
        },
      ])
      .execute();

    await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });

    await expect(
      db.selectFrom("entity_contact_points").select(["id", "is_primary"]).where("entity_id", "=", "survivor").execute(),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cp-survivor", is_primary: 1 }),
        expect.objectContaining({ id: "cp-loser", is_primary: 0 }),
      ]),
    );
  });

  it("carries loser names into survivor aliases, links future proposals, and reverses only recorded additions", async () => {
    await seedEntity(db, "survivor", "Acme Corporation", "company");
    await seedEntity(db, "loser", "Acme Corp", "company");
    await db
      .updateTable("entities")
      .set({ aliases: JSON.stringify(["Acme Corporation Inc"]) })
      .where("id", "=", "survivor")
      .execute();
    await db
      .updateTable("entities")
      .set({ aliases: JSON.stringify(["ACME Corp Ltd", "acmecorp"]) })
      .where("id", "=", "loser")
      .execute();

    const result = await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });

    const mergedSurvivor = await db
      .selectFrom("entities")
      .select(["aliases"])
      .where("id", "=", "survivor")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(mergedSurvivor.aliases ?? "[]")).toEqual(["Acme Corporation Inc", "Acme Corp", "ACME Corp Ltd"]);

    const ledger = await db
      .selectFrom("entity_merges")
      .select("moves")
      .where("id", "=", result.mergeId)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(ledger.moves)).toEqual(
      expect.arrayContaining([
        { kind: "alias_added", value: "Acme Corp", normalizedKey: "acmecorp" },
        { kind: "alias_added", value: "ACME Corp Ltd", normalizedKey: "acmecorpltd" },
      ]),
    );

    const deps = await buildMaterializeDeps(db);
    const proposal = await proposeEntity(deps, {
      name: "Acme Corp",
      entityType: "company",
      subtype: "external",
      source: "test",
      sourceId: "test:acme-corp",
      evidence: [{ indexedFileId: "file-a" }],
      triggeredByUserId: USER_ID,
    });
    expect(proposal.kind).toBe("linked");
    if (proposal.kind !== "linked") throw new Error("expected linked proposal");
    expect(proposal.entity.id).toBe("survivor");

    await db
      .updateTable("entities")
      .set({ aliases: JSON.stringify(["Acme Corporation Inc", "Acme Corp", "ACME Corp Ltd", "Post Merge Alias"]) })
      .where("id", "=", "survivor")
      .execute();
    await unmergeEntities(db, { mergeId: result.mergeId, userId: USER_ID });

    const unmergedSurvivor = await db
      .selectFrom("entities")
      .select(["aliases"])
      .where("id", "=", "survivor")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(unmergedSurvivor.aliases ?? "[]")).toEqual(["Acme Corporation Inc", "Post Merge Alias"]);
  });

  it("does not steal source refs that moved after merge", async () => {
    await seedEntity(db, "survivor", "Alex");
    await seedEntity(db, "loser", "Alex Duplicate");
    await seedEntity(db, "third", "Third");
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "ref-loser",
        entity_id: "loser",
        source: "linear",
        source_id: "u1",
        source_url: null,
        last_seen_at: "2026",
      })
      .execute();

    const result = await mergeEntities(db, { survivorId: "survivor", loserId: "loser", userId: USER_ID });
    await db.updateTable("entity_source_refs").set({ entity_id: "third" }).where("id", "=", "ref-loser").execute();

    await expect(unmergeEntities(db, { mergeId: result.mergeId, userId: USER_ID })).rejects.toMatchObject({
      code: "MERGE_CONFLICT",
    });
    await expect(
      db.selectFrom("entity_source_refs").select("entity_id").where("id", "=", "ref-loser").executeTakeFirst(),
    ).resolves.toMatchObject({ entity_id: "third" });
  });

  it("enforces LIFO unmerge and fails cleanly when a loser is merged twice", async () => {
    await seedEntity(db, "a", "A");
    await seedEntity(db, "b", "B");
    await seedEntity(db, "c", "C");

    const first = await mergeEntities(db, { survivorId: "b", loserId: "a", userId: USER_ID });
    await mergeEntities(db, { survivorId: "c", loserId: "b", userId: USER_ID });

    await expect(unmergeEntities(db, { mergeId: first.mergeId, userId: USER_ID })).rejects.toMatchObject({
      code: "MERGE_SUPERSEDED",
    });
    await expect(mergeEntities(db, { survivorId: "c", loserId: "a", userId: USER_ID })).rejects.toBeInstanceOf(
      EntityMergeError,
    );
  });
});
