import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeName } from "../../connectors/name-normalize";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { upsertSlackPersonEntity } from "./slack-entity-sync";

type SlackProfile = Parameters<typeof upsertSlackPersonEntity>[1];

function profile(overrides: Partial<SlackProfile> = {}): SlackProfile {
  return {
    teamId: "T123",
    slackUserId: "U123",
    name: "Alice Example",
    realName: "Alice Example",
    email: "alice@example.com",
    profileTeamId: "T123",
    isBot: false,
    isGuest: false,
    isStranger: false,
    isRestricted: false,
    isUltraRestricted: false,
    deleted: false,
    providerUpdatedAt: "2026-08-05T10:00:00.000Z",
    fetchedAt: "2026-08-05T10:01:00.000Z",
    ...overrides,
  };
}

describe("upsertSlackPersonEntity", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await createTestPgDb();
    await db
      .insertInto("users")
      .values({ id: "admin", name: "Admin", email: "admin@example.com", auth_role: "admin" })
      .execute();
    await db
      .insertInto("connector_configs")
      .values({
        id: "slack-connector",
        connector_type: "slack",
        auth_type: "system",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();
    await db
      .insertInto("organization_domains")
      .values({
        id: "domain-example",
        domain: "example.com",
        source: "admin_email",
        verified_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();
  }, 30000);

  afterAll(async () => {
    await db.destroy();
  });

  it("concurrent same-user upserts create one entity and one source ref", async () => {
    const input = profile();
    await Promise.all(Array.from({ length: 8 }, () => upsertSlackPersonEntity(db, input)));

    await expect(
      db.selectFrom("entities").select("id").where("source_type", "=", "person").execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db.selectFrom("entity_source_refs").selectAll().where("source", "=", "slack_user").execute(),
    ).resolves.toHaveLength(1);
  });

  it("creates a source-owned person and review row for duplicate email matches", async () => {
    await db
      .insertInto("entities")
      .values([
        {
          id: "existing-person-a",
          name: "A",
          source_type: "person",
          subtype: "internal",
          aliases: null,
          metadata: JSON.stringify({ email: "duplicate@example.com" }),
          source_ref_id: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
        {
          id: "existing-person-b",
          name: "B",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: JSON.stringify({ email: "duplicate@example.com" }),
          source_ref_id: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
      ])
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({ slackUserId: "U-DUP", name: "Duplicate", email: "duplicate@example.com" }),
    );

    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("source", "=", "slack_user")
      .where("source_id", "=", "T123:U-DUP")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.candidate_entity_ids ?? "[]")).toEqual(["existing-person-a", "existing-person-b"]);
    expect(row.candidate_reason).toBe("ambiguous-email");
  });

  it("creates separate source-scoped suggestions for same-name Slack users", async () => {
    await upsertSlackPersonEntity(db, profile({ slackUserId: "U-NAME-1", email: null }));
    await upsertSlackPersonEntity(db, profile({ slackUserId: "U-NAME-2", email: null }));

    const rows = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("source", "=", "slack_user")
      .where("proposed_name", "=", "Alice Example")
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.source_id))).toEqual(new Set(["T123:U-NAME-1", "T123:U-NAME-2"]));
  });

  it("does not mint a suppressed person name", async () => {
    await db
      .insertInto("entity_creation_suppressions")
      .values({
        id: "suppressed-alice",
        normalized_name: normalizeName("Suppressed Person"),
        entity_type: "person",
        original_entity_id: null,
        reason: "admin decision",
        created_by: "admin",
      })
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({ slackUserId: "U-SUPPRESSED", name: "Suppressed Person", realName: "Suppressed Person", email: null }),
    );

    await expect(
      db.selectFrom("entity_source_refs").selectAll().where("source_id", "=", "T123:U-SUPPRESSED").execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select("entity_id")
        .where("slack_user_id", "=", "U-SUPPRESSED")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ entity_id: null });
  });

  it("keeps same-team rotation idempotent and rejects stale profile writes", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({ slackUserId: "U-MONO", name: "Fresh Name", email: "fresh@example.com" }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-MONO",
        name: "Stale Name",
        realName: "Stale Name",
        email: "stale@example.com",
        providerUpdatedAt: "2026-08-05T09:00:00.000Z",
        fetchedAt: "2026-08-05T09:01:00.000Z",
      }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({ slackUserId: "U-MONO", name: "Fresh Name", email: "fresh@example.com" }),
    );

    const entity = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .selectAll("entities")
      .where("entity_source_refs.source_id", "=", "T123:U-MONO")
      .executeTakeFirstOrThrow();
    expect(entity.name).toBe("Fresh Name");
    expect(JSON.parse(entity.metadata ?? "{}").email).toBe("fresh@example.com");

    const state = await db
      .selectFrom("slack_user_sync_state")
      .select(["provider_updated_at", "fetched_at"])
      .where("slack_user_id", "=", "U-MONO")
      .executeTakeFirstOrThrow();
    expect(state.provider_updated_at).toBe("2026-08-05T10:00:00.000Z");
    expect(state.fetched_at).toBe("2026-08-05T10:01:00.000Z");
  });

  it("preserves an existing subtype when a linked Slack profile becomes unclassified", async () => {
    await db
      .insertInto("entities")
      .values({
        id: "internal-person-subtype",
        name: "Internal Person",
        source_type: "person",
        subtype: "internal",
        aliases: null,
        metadata: JSON.stringify({ email: "subtype@example.com" }),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "human_confirmed",
        hotness: 0,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-SUBTYPE",
        name: "Internal Person",
        email: "subtype@example.com",
      }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-SUBTYPE",
        name: "Internal Person",
        email: null,
        providerUpdatedAt: "2026-08-05T11:00:00.000Z",
        fetchedAt: "2026-08-05T11:01:00.000Z",
      }),
    );

    const entity = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select(["entities.subtype"])
      .where("entity_source_refs.source_id", "=", "T123:U-SUBTYPE")
      .executeTakeFirstOrThrow();
    expect(entity.subtype).toBe("internal");

    const state = await db
      .selectFrom("slack_user_sync_state")
      .select(["classification", "classification_source"])
      .where("slack_user_id", "=", "U-SUBTYPE")
      .executeTakeFirstOrThrow();
    expect(state.classification).toBeNull();
    expect(state.classification_source).toBe("unknown");
  });
});
