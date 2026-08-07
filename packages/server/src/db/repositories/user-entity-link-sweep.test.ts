import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createUserEntityLinkSweepService } from "./user-entity-link-sweep";
import { createUserRepository } from "./users";

describe("user entity link sweep", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: "admin", name: "Admin", type: "human", auth_role: "admin" }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("backfills links with durable counters and resumes between batches", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values({ id: "sweep-user", name: "Sweep User", type: "human", email: "sweep@example.com" })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "sweep-entity",
        name: "Sweep User",
        source_type: "person",
        subtype: "external",
        metadata: JSON.stringify({ email: "sweep@example.com" }),
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const sweep = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 1 });
    const result = await sweep.runOnce();

    expect(result.status).toBe("completed");
    expect(result.linkedByEmail).toBe(1);
    await expect(
      db.selectFrom("user_entity_link_sweep_runs").select(["stage", "status"]).executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      stage: "completed",
      status: "completed",
    });
  });

  it("drains every batch in one claimed run", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values([
        { id: "drain-user-1", name: "Drain One", type: "human", email: "drain-1@example.com" },
        { id: "drain-user-2", name: "Drain Two", type: "human", email: "drain-2@example.com" },
      ])
      .execute();
    await db
      .insertInto("entities")
      .values([
        {
          id: "drain-entity-1",
          name: "Drain One",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "drain-1@example.com" }),
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "drain-entity-2",
          name: "Drain Two",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "drain-2@example.com" }),
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    const sweep = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 1 });

    await expect(sweep.runOnce()).resolves.toMatchObject({ status: "completed" });
    await expect(
      db.selectFrom("user_entity_links").selectAll().where("user_id", "in", ["drain-user-1", "drain-user-2"]).execute(),
    ).resolves.toHaveLength(2);
  });

  it("counts user creation links, queued reviews, and only no-action users as skipped", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("users")
      .values([
        { id: "user-created", name: "Created User", type: "human" },
        { id: "user-review", name: "Review User", type: "human", email: "ambiguous@example.com" },
        { id: "user-skipped", name: "Skipped User", type: "human", email: "agent@example.com" },
        { id: "agent-skipped", name: "Skipped Agent", type: "agent", whatsapp_number: "+14155550123" },
      ])
      .execute();
    await db
      .insertInto("entities")
      .values([
        {
          id: "created-entity",
          name: "Created Entity",
          source_type: "person",
          subtype: "external",
          metadata: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        ...["ambiguous-a", "ambiguous-b"].map((id) => ({
          id,
          name: id,
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "ambiguous@example.com" }),
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        })),
        {
          id: "agent-entity",
          name: "Agent Entity",
          source_type: "person",
          subtype: "external",
          metadata: JSON.stringify({ email: "agent@example.com" }),
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("entity_contact_points")
      .values({
        id: "agent-entity-phone",
        entity_id: "agent-entity",
        kind: "phone",
        value: "+14155550123",
        display_value: "+14155550123",
        label: null,
        is_primary: 1,
        source: "test",
        connector_config_id: null,
        created_by_user_id: null,
        verified_at: null,
        last_contacted_at: null,
      })
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "created-source-ref",
        entity_id: "created-entity",
        source: "sketch_user",
        source_id: "user-created",
        source_url: null,
        last_seen_at: now,
      })
      .execute();
    await db
      .insertInto("user_entity_link_sweep_runs")
      .values({
        id: "outcome-run",
        run_key: "user-entity-link-sweep",
        status: "queued",
        stage: "human-users-without-links",
        user_cursor: "admin",
      })
      .execute();

    const sweep = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 10 });
    const result = await sweep.runOnce();

    expect(result).toMatchObject({
      status: "completed",
      linkedByUserCreation: 1,
      reviewQueued: 1,
      skipped: 1,
    });
  });

  it("queues review for a deleted merged loser without repointing its link", async () => {
    const now = new Date().toISOString();
    await db.insertInto("users").values({ id: "merged-user", name: "Merged User", type: "human" }).execute();
    await db
      .insertInto("entities")
      .values([
        {
          id: "merged-loser",
          name: "Merged Loser",
          source_type: "person",
          subtype: "external",
          metadata: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
          deleted_at: now,
          merged_into_entity_id: "merged-survivor",
        },
        {
          id: "merged-survivor",
          name: "Merged Survivor",
          source_type: "person",
          subtype: "external",
          metadata: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("user_entity_links")
      .values({
        id: "merged-link",
        user_id: "merged-user",
        entity_id: "merged-loser",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();

    const sweep = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 10 });
    let result = await sweep.runOnce();
    for (let attempt = 0; result.status === "running" && attempt < 5; attempt += 1) result = await sweep.runOnce();

    expect(result.status).toBe("completed");
    await expect(
      db
        .selectFrom("entity_review_queue")
        .select(["candidate_reason", "candidate_entity_ids"])
        .where("source", "=", "user_entity_link")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      candidate_reason: "stale-merged-link",
      candidate_entity_ids: JSON.stringify(["merged-loser", "merged-survivor"]),
    });
    await expect(
      db.selectFrom("user_entity_links").select("entity_id").where("user_id", "=", "merged-user").execute(),
    ).resolves.toEqual([{ entity_id: "merged-loser" }]);
  });

  it("does not recount or rewrite an already pending stale-link review", async () => {
    const now = new Date().toISOString();
    await db.insertInto("users").values({ id: "repeat-merged-user", name: "Repeat Merged", type: "human" }).execute();
    await db
      .insertInto("entities")
      .values([
        {
          id: "repeat-merged-loser",
          name: "Repeat Loser",
          source_type: "person",
          subtype: "external",
          metadata: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
          deleted_at: now,
          merged_into_entity_id: "repeat-merged-survivor",
        },
        {
          id: "repeat-merged-survivor",
          name: "Repeat Survivor",
          source_type: "person",
          subtype: "external",
          metadata: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto("user_entity_links")
      .values({
        id: "repeat-merged-link",
        user_id: "repeat-merged-user",
        entity_id: "repeat-merged-loser",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();

    const sweep = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 10 });
    const first = await sweep.runOnce();
    const second = await sweep.runOnce();

    expect(first.reviewQueued).toBe(1);
    expect(second.reviewQueued).toBe(1);
    await expect(
      db
        .selectFrom("entity_review_queue")
        .select("occurrence_count")
        .where("source_id", "=", "repeat-merged-loser")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ occurrence_count: 1 });
  });

  it("reclaims a running sweep whose heartbeat has expired", async () => {
    const staleHeartbeat = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db
      .insertInto("user_entity_link_sweep_runs")
      .values({
        id: "stale-run",
        run_key: "user-entity-link-sweep",
        status: "running",
        stage: "human-users-without-links",
        heartbeat_at: staleHeartbeat,
      })
      .execute();

    const sweep = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 10 });
    await expect(sweep.runOnce()).resolves.toMatchObject({ status: "completed" });
  });

  it("does not race when two sweep workers create the durable run row", async () => {
    const first = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 10 });
    const second = createUserEntityLinkSweepService({ db, users: createUserRepository(db), batchSize: 10 });

    await expect(Promise.all([first.runOnce(), second.runOnce()])).resolves.toHaveLength(2);
    await expect(
      db
        .selectFrom("user_entity_link_sweep_runs")
        .select("run_key")
        .where("run_key", "=", "user-entity-link-sweep")
        .execute(),
    ).resolves.toHaveLength(1);
  });
});
