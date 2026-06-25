import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { up as qualifyContainerNames } from "./115-container-name-qualification";

const NOW = "2026-06-23T00:00:00.000Z";

async function insertProjectFixture(
  db: Kysely<DB>,
  input: {
    id: string;
    name: string;
    source: "linear" | "clickup";
    sourceId: string;
    rawName: string;
    metadata: Record<string, unknown>;
    aliases?: string | null;
    mergedIntoEntityId?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: "project",
      subtype: null,
      aliases: input.aliases ?? null,
      metadata: JSON.stringify(input.metadata),
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: NOW,
      updated_at: NOW,
      merged_into_entity_id: input.mergedIntoEntityId ?? null,
    })
    .execute();
  await db
    .insertInto("entity_source_refs")
    .values({
      id: `${input.id}-ref`,
      entity_id: input.id,
      source: input.source,
      source_id: input.sourceId,
      source_url: null,
      last_seen_at: NOW,
    })
    .execute();
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: `${input.id}-fact`,
      indexed_file_id: null,
      connector_config_id: null,
      created_by_user_id: null,
      source: input.source,
      fact_type: "structural_seed",
      relation: "seeded",
      subject_name: input.rawName,
      subject_source: input.source,
      subject_source_id: input.sourceId,
      context_snippet: null,
      raw: JSON.stringify({
        name: input.rawName,
        sourceType: "project",
        source: input.source,
        sourceId: input.sourceId,
        metadata: input.metadata,
      }),
      fact_key: `${input.source}:${input.sourceId}:seeded`,
      last_seen_sync_run_id: null,
      deleted_at: null,
      content_hash: null,
      materialized_at: null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

describe("115-container-name-qualification", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("qualifies untouched project entities without rewriting facts", async () => {
    await insertProjectFixture(db, {
      id: "untouched-linear",
      name: "Analytics",
      source: "linear",
      sourceId: "lin-analytics",
      rawName: "Analytics",
      metadata: { teams: ["Sketch"] },
    });
    await insertProjectFixture(db, {
      id: "edited-clickup",
      name: "Edited Rollout",
      source: "clickup",
      sourceId: "cu-rollout",
      rawName: "Rollout",
      metadata: { spaceName: "Delivery" },
    });
    await db
      .insertInto("entities")
      .values({
        id: "some-survivor",
        name: "Sketch Archive",
        source_type: "project",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    await insertProjectFixture(db, {
      id: "merged-linear",
      name: "Archive",
      source: "linear",
      sourceId: "lin-archive",
      rawName: "Archive",
      metadata: { teams: ["Sketch"] },
      mergedIntoEntityId: "some-survivor",
    });

    await qualifyContainerNames(db as unknown as Kysely<unknown>);
    await qualifyContainerNames(db as unknown as Kysely<unknown>);

    const untouched = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "untouched-linear")
      .executeTakeFirstOrThrow();
    expect(untouched.name).toBe("Sketch Analytics");
    expect(JSON.parse(untouched.aliases ?? "[]")).toEqual(["Analytics"]);

    const untouchedFact = await db
      .selectFrom("indexed_file_facts")
      .select(["subject_name", "raw"])
      .where("id", "=", "untouched-linear-fact")
      .executeTakeFirstOrThrow();
    expect(untouchedFact.subject_name).toBe("Analytics");
    expect(JSON.parse(untouchedFact.raw ?? "{}")).toMatchObject({ name: "Analytics" });

    const edited = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "edited-clickup")
      .executeTakeFirstOrThrow();
    expect(edited.name).toBe("Edited Rollout");
    expect(edited.aliases).toBeNull();
    const editedFact = await db
      .selectFrom("indexed_file_facts")
      .select(["subject_name", "raw"])
      .where("id", "=", "edited-clickup-fact")
      .executeTakeFirstOrThrow();
    expect(editedFact.subject_name).toBe("Rollout");
    expect(JSON.parse(editedFact.raw ?? "{}")).toMatchObject({ name: "Rollout" });

    const merged = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "merged-linear")
      .executeTakeFirstOrThrow();
    expect(merged.name).toBe("Archive");
    expect(merged.aliases).toBeNull();
  });

  it("requalifies pending project queue rows, is idempotent, and leaves facts untouched", async () => {
    await insertProjectFixture(db, {
      id: "queue-linear-entity",
      name: "Already Edited",
      source: "linear",
      sourceId: "lin-platform",
      rawName: "Platform",
      metadata: { teams: ["Sketch"] },
    });
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "queue-platform",
        proposed_name: "Platform",
        normalized_name: "platform",
        entity_type: "project",
        proposed_email: null,
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: null,
        candidate_generated_at: NOW,
        first_seen_at: NOW,
        last_seen_at: NOW,
        occurrence_count: 1,
        status: "pending",
        triggered_by_user_id: "user-1",
        review_started_at: null,
        review_started_by: null,
        backfill_cursor: null,
        resolved_by: null,
        resolved_at: null,
        resolved_entity_id: null,
        seed_source: "linear",
        seed_source_id: "lin-platform",
        seed_aliases: null,
      })
      .execute();

    const factBefore = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_key"])
      .where("id", "=", "queue-linear-entity-fact")
      .executeTakeFirstOrThrow();
    const factCountBefore = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    await qualifyContainerNames(db as unknown as Kysely<unknown>);
    await qualifyContainerNames(db as unknown as Kysely<unknown>);

    const queueRow = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", "queue-platform")
      .executeTakeFirstOrThrow();
    expect(queueRow.proposed_name).toBe("Sketch Platform");
    expect(queueRow.normalized_name).toBe("sketch platform");
    expect(queueRow.seed_aliases).toBe(JSON.stringify(["Platform"]));

    const factAfter = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_key"])
      .where("id", "=", "queue-linear-entity-fact")
      .executeTakeFirstOrThrow();
    const factCountAfter = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(factAfter.fact_key).toBe(factBefore.fact_key);
    expect(factCountAfter.count).toBe(factCountBefore.count);
  });
});
