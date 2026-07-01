import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbIndex from "../../db/index";
import { EMBEDDING_DIMENSIONS } from "../../db/index";
import type { DB } from "../../db/schema";
import {
  reconcileMissingNameEmbeddings,
  retrieveEntityNameCandidates,
  retrieveNameDedupCandidates,
} from "./trunk-name-embeddings";
import type { EmbeddingProvider } from "./types";

/**
 * Unit vector whose cosine similarity to the base query vector (vector(1) =
 * [1, 0, ...]) equals `cosine`. The dedup vec0 tables use distance_metric=cosine,
 * so a stored vector(c) retrieved against a vector(1) query scores similarity c.
 */
function vector(cosine: number): number[] {
  const embedding = new Array(EMBEDDING_DIMENSIONS).fill(0);
  embedding[0] = cosine;
  embedding[1] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return embedding;
}

function makeProvider(embeddings?: number[][]): EmbeddingProvider & { embedTexts: ReturnType<typeof vi.fn> } {
  return {
    name: "test",
    dimensions: EMBEDDING_DIMENSIONS,
    supportsImages: false,
    embedTexts: vi.fn(async (texts: string[]) => embeddings ?? texts.map(() => vector(1))),
  };
}

async function createDb(): Promise<Kysely<DB>> {
  const raw = new Database(":memory:");
  sqliteVec.load(raw);
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
  await sql`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      deleted_at TEXT,
      merged_into_entity_id TEXT
    )
  `.execute(db);
  await sql`
    CREATE TABLE entity_review_queue (
      id TEXT PRIMARY KEY,
      proposed_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE VIRTUAL TABLE entity_name_embeddings USING vec0(
      entity_id TEXT PRIMARY KEY,
      embedding float[${sql.lit(EMBEDDING_DIMENSIONS)}] distance_metric=cosine
    )
  `.execute(db);
  await sql`
    CREATE VIRTUAL TABLE entity_review_queue_embeddings USING vec0(
      review_id TEXT PRIMARY KEY,
      embedding float[${sql.lit(EMBEDDING_DIMENSIONS)}] distance_metric=cosine
    )
  `.execute(db);
  return db;
}

async function insertEntity(
  db: Kysely<DB>,
  row: { id: string; name: string; type: string; deleted?: boolean; mergedInto?: string | null },
): Promise<void> {
  await sql`
    INSERT INTO entities (id, name, source_type, deleted_at, merged_into_entity_id)
    VALUES (${row.id}, ${row.name}, ${row.type}, ${row.deleted ? "2026-06-30T00:00:00.000Z" : null}, ${
      row.mergedInto ?? null
    })
  `.execute(db);
}

async function insertReview(
  db: Kysely<DB>,
  row: { id: string; name: string; type: string; status?: string },
): Promise<void> {
  await sql`
    INSERT INTO entity_review_queue (id, proposed_name, entity_type, status)
    VALUES (${row.id}, ${row.name}, ${row.type}, ${row.status ?? "pending"})
  `.execute(db);
}

async function insertEntityEmbedding(db: Kysely<DB>, id: string, embedding: number[]): Promise<void> {
  await sql`INSERT INTO entity_name_embeddings (entity_id, embedding) VALUES (${id}, ${JSON.stringify(embedding)})`.execute(
    db,
  );
}

async function insertReviewEmbedding(db: Kysely<DB>, id: string, embedding: number[]): Promise<void> {
  await sql`INSERT INTO entity_review_queue_embeddings (review_id, embedding) VALUES (${id}, ${JSON.stringify(
    embedding,
  )})`.execute(db);
}

async function entityEmbeddingIds(db: Kysely<DB>): Promise<string[]> {
  const rows = await sql<{ entity_id: string }>`
    SELECT entity_id FROM entity_name_embeddings ORDER BY entity_id ASC
  `.execute(db);
  return rows.rows.map((row) => row.entity_id);
}

async function reviewEmbeddingIds(db: Kysely<DB>): Promise<string[]> {
  const rows = await sql<{ review_id: string }>`
    SELECT review_id FROM entity_review_queue_embeddings ORDER BY review_id ASC
  `.execute(db);
  return rows.rows.map((row) => row.review_id);
}

describe("trunk name embedding reconcile", () => {
  let db: Kysely<DB>;
  let vecSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await createDb();
    vecSpy = vi.spyOn(dbIndex, "isSqliteVecAvailable").mockReturnValue(true);
  });

  afterEach(async () => {
    vecSpy.mockRestore();
    await db.destroy();
  });

  it("embeds person and company entity rows but keeps review rows project/product only", async () => {
    await insertEntity(db, { id: "entity-project", name: "Project Atlas", type: "project" });
    await insertEntity(db, { id: "entity-product", name: "Product OS", type: "product" });
    await insertEntity(db, { id: "entity-person", name: "Sarah Chen", type: "person" });
    await insertEntity(db, { id: "entity-company", name: "Sarah Chen Co", type: "company" });
    await insertEntity(db, { id: "entity-deleted", name: "Deleted Project", type: "project", deleted: true });
    await insertEntity(db, { id: "entity-existing", name: "Embedded Project", type: "project" });
    await insertReview(db, { id: "review-project", name: "Review Project", type: "project" });
    await insertReview(db, { id: "review-product", name: "Review Product", type: "product" });
    await insertReview(db, { id: "review-person", name: "Review Person", type: "person" });
    await insertReview(db, { id: "review-company", name: "Review Company", type: "company" });
    await insertReview(db, { id: "review-team", name: "Review Team", type: "team" });
    await insertReview(db, { id: "review-confirmed", name: "Confirmed Project", type: "project", status: "confirmed" });
    await insertReview(db, { id: "review-existing", name: "Embedded Review", type: "project" });
    await sql`INSERT INTO entity_name_embeddings (entity_id, embedding) VALUES (${"entity-existing"}, ${JSON.stringify(
      vector(0.5),
    )})`.execute(db);
    await sql`INSERT INTO entity_review_queue_embeddings (review_id, embedding) VALUES (${"review-existing"}, ${JSON.stringify(
      vector(0.6),
    )})`.execute(db);
    const provider = makeProvider();

    await reconcileMissingNameEmbeddings(db, provider);

    const embeddedNames = provider.embedTexts.mock.calls.flatMap((call) => call[0]).sort();
    expect(embeddedNames).toEqual(
      ["Product OS", "Project Atlas", "Review Product", "Review Project", "Sarah Chen", "Sarah Chen Co"].sort(),
    );
    expect(await entityEmbeddingIds(db)).toEqual([
      "entity-company",
      "entity-existing",
      "entity-person",
      "entity-product",
      "entity-project",
    ]);
    expect(await reviewEmbeddingIds(db)).toEqual(["review-existing", "review-product", "review-project"]);

    const candidates = await retrieveEntityNameCandidates(db, provider, { name: "Sarah Chen", type: "person" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ entityId: "entity-person", name: "Sarah Chen", type: "person" });
    expect(candidates[0].similarity).toBeCloseTo(1);
  });

  it("fails open when provider is absent", async () => {
    await insertEntity(db, { id: "entity-project", name: "Project Atlas", type: "project" });

    await expect(reconcileMissingNameEmbeddings(db, null)).resolves.toBeUndefined();

    expect(await entityEmbeddingIds(db)).toEqual([]);
  });

  it("fails open when sqlite vec storage is unavailable", async () => {
    vecSpy.mockReturnValue(false);
    await insertEntity(db, { id: "entity-project", name: "Project Atlas", type: "project" });
    const provider = makeProvider();

    await expect(reconcileMissingNameEmbeddings(db, provider)).resolves.toBeUndefined();

    expect(provider.embedTexts).not.toHaveBeenCalled();
    expect(await entityEmbeddingIds(db)).toEqual([]);
  });

  it("retrieves type-correct candidates above the similarity threshold", async () => {
    await insertEntity(db, { id: "entity-project", name: "Project Atlas", type: "project" });
    await insertEntity(db, { id: "entity-product", name: "Product Atlas", type: "product" });
    await insertReview(db, { id: "review-project", name: "Review Atlas", type: "project" });
    await insertReview(db, { id: "review-far", name: "Far Atlas", type: "project" });
    await insertEntityEmbedding(db, "entity-project", vector(0.95));
    await insertEntityEmbedding(db, "entity-product", vector(0.96));
    await insertReviewEmbedding(db, "review-project", vector(0.9));
    await insertReviewEmbedding(db, "review-far", vector(0.1));
    const provider = makeProvider([vector(1)]);

    const candidates = await retrieveNameDedupCandidates(db, provider, [{ name: "Atlas Project", type: "project" }], {
      topK: 10,
    });

    expect(provider.embedTexts).toHaveBeenCalledOnce();
    expect(provider.embedTexts).toHaveBeenCalledWith(["Atlas Project"]);
    expect(candidates).toEqual([
      { name: "Project Atlas", type: "project", entityId: "entity-project" },
      { name: "Review Atlas", type: "project", reviewId: "review-project" },
    ]);
  });

  it("overfetches so wrong-type and orphan nearest rows do not hide usable candidates", async () => {
    for (let index = 0; index < 3; index++) {
      await insertEntity(db, { id: `wrong-${index}`, name: `Wrong ${index}`, type: "product" });
      await insertEntityEmbedding(db, `wrong-${index}`, vector(1));
      await insertEntityEmbedding(db, `orphan-${index}`, vector(1));
    }
    for (let index = 0; index < 3; index++) {
      await insertEntity(db, { id: `usable-${index}`, name: `Usable ${index}`, type: "project" });
      await insertEntityEmbedding(db, `usable-${index}`, vector(0.95 - index * 0.01));
    }
    const provider = makeProvider([vector(1)]);

    const candidates = await retrieveNameDedupCandidates(db, provider, [{ name: "Usable Project", type: "project" }], {
      topK: 3,
    });

    expect(candidates.map((candidate) => candidate.name).sort()).toEqual(["Usable 0", "Usable 1", "Usable 2"]);
  });

  it("fails open when retrieval has no provider or the provider throws", async () => {
    await insertEntity(db, { id: "entity-project", name: "Project Atlas", type: "project" });
    await insertEntityEmbedding(db, "entity-project", vector(1));
    const throwingProvider = makeProvider();
    throwingProvider.embedTexts.mockRejectedValueOnce(new Error("embedding unavailable"));

    await expect(retrieveNameDedupCandidates(db, null, [{ name: "Atlas Project", type: "project" }])).resolves.toEqual(
      [],
    );
    await expect(
      retrieveNameDedupCandidates(db, throwingProvider, [{ name: "Atlas Project", type: "project" }]),
    ).resolves.toEqual([]);
  });
});
