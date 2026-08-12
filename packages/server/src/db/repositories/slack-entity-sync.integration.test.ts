import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeName } from "../../connectors/name-normalize";
import { createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createEntityRepository } from "./entities";
import { isInternalSlackUser, upsertSlackPersonEntity } from "./slack-entity-sync";

type SlackProfile = Parameters<typeof upsertSlackPersonEntity>[1];

function profile(overrides: Partial<SlackProfile> = {}): SlackProfile {
  return {
    teamId: "T123",
    slackUserId: "U123",
    name: "Alice Example",
    realName: "Alice Example",
    email: "alice@example.com",
    phone: null,
    profileTeamId: "T123",
    isBot: false,
    isGuest: false,
    isStranger: false,
    isRestricted: false,
    isUltraRestricted: false,
    deleted: false,
    providerUpdatedAt: "00000000001785924000",
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
    const dbA = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => result,
    });
    const dbB = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => result,
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => upsertSlackPersonEntity(index % 2 === 0 ? dbA : dbB, input)),
    );

    await expect(
      db.selectFrom("entities").select("id").where("source_type", "=", "person").execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db.selectFrom("entity_source_refs").selectAll().where("source", "=", "slack_user").execute(),
    ).resolves.toHaveLength(1);
  });

  it("requires lifecycle evidence before allowing Slack provisioning", async () => {
    await expect(isInternalSlackUser(db, "U-DOMAIN", "alice@example.com")).resolves.toBe(true);
    await expect(isInternalSlackUser(db, "U-UNKNOWN", "alice@outside.example")).resolves.toBe(false);

    await db
      .insertInto("slack_user_sync_state")
      .values({
        team_id: "T123",
        slack_user_id: "U-ROSTER",
        classification: "internal",
        classification_source: "team_roster",
      })
      .execute();
    await expect(isInternalSlackUser(db, "U-ROSTER", null)).resolves.toBe(true);

    await db
      .insertInto("slack_user_sync_state")
      .values({ team_id: "T123", slack_user_id: "U-GUEST", is_guest: 1, classification: "external" })
      .execute();
    await expect(isInternalSlackUser(db, "U-GUEST", "guest@example.com")).resolves.toBe(false);
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

  it("writes a normalized Slack phone contact point without using it for classification", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-PHONE-CONTACT",
        name: "Phone Contact",
        realName: "Phone Contact",
        email: null,
        phone: "00 1 (415) 555-1234",
      }),
    );

    const entity = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select("entities.id")
      .where("entity_source_refs.source_id", "=", "T123:U-PHONE-CONTACT")
      .executeTakeFirstOrThrow();
    await expect(
      db
        .selectFrom("entity_contact_points")
        .select(["kind", "value", "source", "is_primary"])
        .where("entity_id", "=", entity.id)
        .where("kind", "=", "phone")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ kind: "phone", value: "+14155551234", source: "slack_user", is_primary: 1 });
    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select(["classification", "classification_source"])
        .where("slack_user_id", "=", "U-PHONE-CONTACT")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ classification: "external", classification_source: "default_no_evidence" });
  });

  it("links a Slack profile to a WhatsApp entity by an exact phone match", async () => {
    await db
      .insertInto("entities")
      .values({
        id: "whatsapp-phone-person",
        name: "WhatsApp Phone Person",
        source_type: "person",
        subtype: "external",
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("entity_contact_points")
      .values({
        id: "whatsapp-phone-contact",
        entity_id: "whatsapp-phone-person",
        kind: "whatsapp",
        value: "+16465550199",
        display_value: "+1 646 555 0199",
        label: null,
        is_primary: 1,
        source: "whatsapp",
        connector_config_id: null,
        created_by_user_id: null,
        verified_at: null,
        last_contacted_at: null,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();

    await expect(
      createEntityRepository(db).getPersonEntitiesByContactPointKinds("+1 (646) 555-0199", ["phone", "whatsapp"]),
    ).resolves.toMatchObject([{ id: "whatsapp-phone-person" }]);

    const result = await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-WHATSAPP-PHONE",
        name: "Slack Phone Person",
        realName: "Slack Phone Person",
        email: null,
        phone: "+1 (646) 555-0199",
      }),
    );
    expect(result.entity?.id).toBe("whatsapp-phone-person");

    await expect(
      db
        .selectFrom("entity_source_refs")
        .select("entity_id")
        .where("source_id", "=", "T123:U-WHATSAPP-PHONE")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ entity_id: "whatsapp-phone-person" });
  });

  it("creates a source-owned entity and review row for ambiguous phone matches", async () => {
    await db
      .insertInto("entities")
      .values([
        {
          id: "phone-match-a",
          name: "Phone Match A",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: null,
          source_ref_id: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
        {
          id: "phone-match-b",
          name: "Phone Match B",
          source_type: "person",
          subtype: "external",
          aliases: null,
          metadata: null,
          source_ref_id: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
      ])
      .execute();
    await db
      .insertInto("entity_contact_points")
      .values([
        {
          id: "phone-match-contact-a",
          entity_id: "phone-match-a",
          kind: "whatsapp",
          value: "+12125551234",
          display_value: null,
          label: null,
          is_primary: 1,
          source: "whatsapp",
          connector_config_id: null,
          created_by_user_id: null,
          verified_at: null,
          last_contacted_at: null,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
        {
          id: "phone-match-contact-b",
          entity_id: "phone-match-b",
          kind: "phone",
          value: "+12125551234",
          display_value: null,
          label: null,
          is_primary: 1,
          source: "manual",
          connector_config_id: null,
          created_by_user_id: "admin",
          verified_at: null,
          last_contacted_at: null,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
        },
      ])
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-AMBIGUOUS-PHONE",
        name: "Ambiguous Phone",
        realName: "Ambiguous Phone",
        email: null,
        phone: "+1 212 555 1234",
      }),
    );

    const ref = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source_id", "=", "T123:U-AMBIGUOUS-PHONE")
      .executeTakeFirstOrThrow();
    expect(ref.entity_id).not.toBe("phone-match-a");
    expect(ref.entity_id).not.toBe("phone-match-b");
    await expect(
      db
        .selectFrom("entity_review_queue")
        .select(["candidate_entity_ids", "candidate_reason"])
        .where("source_id", "=", "T123:U-AMBIGUOUS-PHONE")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      candidate_entity_ids: JSON.stringify(["phone-match-a", "phone-match-b"]),
      candidate_reason: "ambiguous-phone",
    });
  });

  it("does not write a Slack phone contact point when the profile has no phone", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({ slackUserId: "U-NO-PHONE", name: "No Phone", realName: "No Phone", phone: null }),
    );

    const entity = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source_id", "=", "T123:U-NO-PHONE")
      .executeTakeFirstOrThrow();
    await expect(
      db
        .selectFrom("entity_contact_points")
        .select("id")
        .where("entity_id", "=", entity.entity_id)
        .where("kind", "=", "phone")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("skips an unparseable Slack phone value", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-INVALID-PHONE",
        name: "Invalid Phone",
        realName: "Invalid Phone",
        email: null,
        phone: "not-a-phone",
      }),
    );

    const entity = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("source_id", "=", "T123:U-INVALID-PHONE")
      .executeTakeFirstOrThrow();
    await expect(
      db
        .selectFrom("entity_contact_points")
        .select("id")
        .where("entity_id", "=", entity.entity_id)
        .where("kind", "=", "phone")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("creates separate source-scoped suggestions for same-name Slack users", async () => {
    await upsertSlackPersonEntity(db, profile({ slackUserId: "U-NAME-1", email: null }));
    await upsertSlackPersonEntity(db, profile({ slackUserId: "U-NAME-2", email: null }));
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-NAME-1",
        email: null,
        providerUpdatedAt: "00000000001785945600",
        fetchedAt: "2026-08-05T11:01:00.000Z",
      }),
    );

    const rows = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("source", "=", "slack_user")
      .where("source_id", "in", ["T123:U-NAME-1", "T123:U-NAME-2"])
      .where("proposed_name", "=", "Alice Example")
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.source_id))).toEqual(new Set(["T123:U-NAME-1", "T123:U-NAME-2"]));
    expect(rows.find((row) => row.source_id === "T123:U-NAME-1")?.occurrence_count).toBe(2);
  });

  it("classifies an unflagged profile without email as external by default", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-DEFAULT-EXTERNAL",
        name: "Default External Person",
        realName: "Default External Person",
        email: null,
      }),
    );

    const state = await db
      .selectFrom("slack_user_sync_state")
      .select(["classification", "classification_source"])
      .where("slack_user_id", "=", "U-DEFAULT-EXTERNAL")
      .executeTakeFirstOrThrow();
    expect(state).toEqual({ classification: "external", classification_source: "default_no_evidence" });

    const entity = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select("entities.subtype")
      .where("entity_source_refs.source_id", "=", "T123:U-DEFAULT-EXTERNAL")
      .executeTakeFirstOrThrow();
    expect(entity.subtype).toBe("external");
  });

  it("uses an existing Sketch roster user as internal evidence", async () => {
    await db
      .insertInto("users")
      .values({ id: "roster-user", name: "Roster User", slack_user_id: "U-TEAM-ROSTER", auth_role: "member" })
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-TEAM-ROSTER",
        name: "Roster User",
        realName: "Roster User",
        email: null,
      }),
    );

    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select(["classification", "classification_source"])
        .where("slack_user_id", "=", "U-TEAM-ROSTER")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ classification: "internal", classification_source: "team_roster" });
  });

  it("promotes default external to internal when an organization email arrives", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-PROMOTE",
        name: "Promoted Person",
        realName: "Promoted Person",
        email: null,
      }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-PROMOTE",
        name: "Promoted Person",
        realName: "Promoted Person",
        email: "promoted@example.com",
        providerUpdatedAt: "00000000001785927600",
        fetchedAt: "2026-08-05T11:01:00.000Z",
      }),
    );

    const state = await db
      .selectFrom("slack_user_sync_state")
      .select(["classification", "classification_source"])
      .where("slack_user_id", "=", "U-PROMOTE")
      .executeTakeFirstOrThrow();
    expect(state).toEqual({ classification: "internal", classification_source: "organization_domain" });
    await expect(
      db
        .selectFrom("entities")
        .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
        .select("entities.subtype")
        .where("entity_source_refs.source_id", "=", "T123:U-PROMOTE")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ subtype: "internal" });
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
      profile({ slackUserId: "U-MONO", name: "fresh.handle", realName: "Fresh Name", email: "fresh@example.com" }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-MONO",
        name: "Stale Name",
        realName: "Stale Name",
        email: "stale@example.com",
        providerUpdatedAt: "00000000001785920400",
        fetchedAt: "2026-08-05T09:01:00.000Z",
      }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({ slackUserId: "U-MONO", name: "fresh.handle", realName: "Fresh Name", email: "fresh@example.com" }),
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
    expect(state.provider_updated_at).toBe("00000000001785924000");
    expect(state.fetched_at).toBe("2026-08-05T10:01:00.000Z");
  });

  it("queues a newer payload behind an in-flight sync", async () => {
    const older = profile({
      slackUserId: "U-CHAIN",
      name: "Older Handle",
      realName: "Older Name",
      email: "chain@example.com",
      providerUpdatedAt: "00000000001785931200",
      fetchedAt: "2026-08-05T12:01:00.000Z",
    });
    const newer = profile({
      slackUserId: "U-CHAIN",
      name: "newer.handle",
      realName: "Newer Name",
      email: "chain@example.com",
      providerUpdatedAt: "00000000001785934800",
      fetchedAt: "2026-08-05T13:01:00.000Z",
    });

    await Promise.all([upsertSlackPersonEntity(db, older), upsertSlackPersonEntity(db, newer)]);

    const entity = await db
      .selectFrom("entities")
      .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
      .select(["entities.name"])
      .where("entity_source_refs.source_id", "=", "T123:U-CHAIN")
      .executeTakeFirstOrThrow();
    expect(entity.name).toBe("Newer Name");
    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select("entity_created_by_sync")
        .where("slack_user_id", "=", "U-CHAIN")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ entity_created_by_sync: 1 });
  });

  it("uses the real name and preserves a linked entity name and metadata", async () => {
    await db
      .insertInto("entities")
      .values({
        id: "linked-person",
        name: "Existing Canonical Name",
        source_type: "person",
        subtype: "internal",
        aliases: JSON.stringify(["Existing Alias", "slack display name"]),
        metadata: JSON.stringify({ email: "linked@example.com", owner: "human" }),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "human_confirmed",
        hotness: 0,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("entity_contact_points")
      .values({
        id: "linked-primary-email",
        entity_id: "linked-person",
        kind: "email",
        value: "linked@example.com",
        display_value: "linked@example.com",
        label: null,
        is_primary: 1,
        source: "manual",
        connector_config_id: null,
        created_by_user_id: "admin",
        verified_at: "2026-08-05T00:00:00.000Z",
        last_contacted_at: null,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-LINKED",
        name: "deprecated.handle",
        realName: "Slack Real Name",
        displayName: "Slack Display Name",
        email: "linked@example.com",
      }),
    );

    const entity = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "linked-person")
      .executeTakeFirstOrThrow();
    expect(entity.name).toBe("Existing Canonical Name");
    expect(JSON.parse(entity.aliases ?? "[]")).toEqual([
      "Existing Alias",
      "slack display name",
      "deprecated.handle",
      "Slack Real Name",
      "linked@example.com",
    ]);
    expect(JSON.parse(entity.metadata ?? "{}")).toEqual({ email: "linked@example.com", owner: "human" });
    const contactPoints = await db
      .selectFrom("entity_contact_points")
      .select(["value", "is_primary"])
      .where("entity_id", "=", "linked-person")
      .where("kind", "=", "email")
      .execute();
    expect(contactPoints).toEqual([{ value: "linked@example.com", is_primary: 1 }]);
    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select("entity_created_by_sync")
        .where("slack_user_id", "=", "U-LINKED")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ entity_created_by_sync: 0 });
  });

  it("demotes internal classification when a positive guest signal arrives", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-STALE-CLASSIFICATION",
        email: "internal@example.com",
        providerUpdatedAt: "00000000001785938400",
        fetchedAt: "2026-08-05T14:01:00.000Z",
      }),
    );
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-STALE-CLASSIFICATION",
        email: null,
        isGuest: true,
        providerUpdatedAt: "00000000001785942000",
        fetchedAt: "2026-08-05T15:01:00.000Z",
      }),
    );

    const state = await db
      .selectFrom("slack_user_sync_state")
      .select(["classification", "classification_source"])
      .where("slack_user_id", "=", "U-STALE-CLASSIFICATION")
      .executeTakeFirstOrThrow();
    expect(state.classification).toBe("external");
    expect(state.classification_source).toBe("provider_flag");
    await expect(
      db
        .selectFrom("entities")
        .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
        .select("entities.subtype")
        .where("entity_source_refs.source_id", "=", "T123:U-STALE-CLASSIFICATION")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ subtype: "external" });
  });

  it("lets a positive provider signal override an organization-domain email", async () => {
    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-DOMAIN-GUEST",
        email: "guest@example.com",
        isGuest: true,
      }),
    );

    const state = await db
      .selectFrom("slack_user_sync_state")
      .select(["classification", "classification_source"])
      .where("slack_user_id", "=", "U-DOMAIN-GUEST")
      .executeTakeFirstOrThrow();
    expect(state).toEqual({ classification: "external", classification_source: "provider_flag" });
    await expect(
      db
        .selectFrom("entities")
        .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
        .select("entities.subtype")
        .where("entity_source_refs.source_id", "=", "T123:U-DOMAIN-GUEST")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ subtype: "external" });
  });

  it("does not recreate an identity whose source ref points to a deleted entity", async () => {
    await db
      .insertInto("entities")
      .values({
        id: "deleted-slack-person",
        name: "Deleted Slack Person",
        source_type: "person",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "structural",
        hotness: 0,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
        deleted_at: "2026-08-05T00:00:00.000Z",
        merged_into_entity_id: null,
      })
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "deleted-slack-ref",
        entity_id: "deleted-slack-person",
        source: "slack_user",
        source_id: "T123:U-DELETED",
        source_url: null,
        last_seen_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();

    await upsertSlackPersonEntity(db, profile({ slackUserId: "U-DELETED", name: "Deleted Person" }));

    await expect(
      db.selectFrom("entity_source_refs").select("entity_id").where("source_id", "=", "T123:U-DELETED").execute(),
    ).resolves.toEqual([{ entity_id: "deleted-slack-person" }]);
    await expect(
      db.selectFrom("entities").select("id").where("id", "=", "deleted-slack-person").execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select("entity_id")
        .where("slack_user_id", "=", "U-DELETED")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ entity_id: null });
  });

  it("preserves internal classification and source when email evidence disappears", async () => {
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
        providerUpdatedAt: "00000000001785927600",
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
    expect(state.classification).toBe("internal");
    expect(state.classification_source).toBe("organization_domain");
  });

  it("preserves an internal linked entity when legacy sync classification is absent", async () => {
    await db
      .insertInto("entities")
      .values({
        id: "legacy-internal-person",
        name: "Legacy Internal Person",
        source_type: "person",
        subtype: "internal",
        aliases: null,
        metadata: JSON.stringify({ email: "legacy@example.com" }),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "structural",
        hotness: 0,
        created_at: "2026-08-05T00:00:00.000Z",
        updated_at: "2026-08-05T00:00:00.000Z",
      })
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-LEGACY-INTERNAL",
        name: "Legacy Internal Person",
        email: "legacy@example.com",
      }),
    );
    await db
      .updateTable("slack_user_sync_state")
      .set({ classification: null, classification_source: null })
      .where("slack_user_id", "=", "U-LEGACY-INTERNAL")
      .execute();

    await upsertSlackPersonEntity(
      db,
      profile({
        slackUserId: "U-LEGACY-INTERNAL",
        name: "Legacy Internal Person",
        email: null,
        providerUpdatedAt: "00000000001785927600",
        fetchedAt: "2026-08-05T11:02:00.000Z",
      }),
    );

    await expect(
      db
        .selectFrom("entities")
        .innerJoin("entity_source_refs", "entity_source_refs.entity_id", "entities.id")
        .select("entities.subtype")
        .where("entity_source_refs.source_id", "=", "T123:U-LEGACY-INTERNAL")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ subtype: "internal" });
    await expect(
      db
        .selectFrom("slack_user_sync_state")
        .select(["classification", "classification_source"])
        .where("slack_user_id", "=", "U-LEGACY-INTERNAL")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ classification: "internal", classification_source: null });
  });
});
