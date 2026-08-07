import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import {
  confirmUserEntityLink,
  ensureEntitiesForUsers,
  ensureEntitiesForUsersWithOutcomes,
  ensureEntityForUser,
  ensureUserEntityLinkForEntity,
  provisionUnverifiedUser,
} from "./user-entity-linking";
import { resolvePersonEntitiesForUser } from "./user-entity-resolver";
import { createUserRepository } from "./users";

describe("ensureUserEntityLinkForEntity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insertInto("users").values({ id: "admin", name: "Admin", type: "human", auth_role: "admin" }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not load entities when every requested user is already linked", async () => {
    await db.insertInto("users").values({ id: "already-linked-user", name: "Already Linked", type: "human" }).execute();
    await db
      .insertInto("entities")
      .values({
        id: "already-linked-entity",
        name: "Already Linked",
        source_type: "person",
        subtype: "external",
        metadata: null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("user_entity_links")
      .values({
        id: "already-linked-row",
        user_id: "already-linked-user",
        entity_id: "already-linked-entity",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();
    const entityQueries: string[] = [];
    const instrumentedDb = db.withPlugin({
      transformQuery({ node }) {
        const serialized = JSON.stringify(node);
        if (serialized.includes('"name":"entities"')) entityQueries.push(serialized);
        return node;
      },
      async transformResult(args) {
        return args.result;
      },
    });

    await expect(ensureEntitiesForUsersWithOutcomes(instrumentedDb, ["already-linked-user"])).resolves.toMatchObject(
      new Map([
        [
          "already-linked-user",
          { entity: null, outcome: { outcome: "already_linked", entityId: "already-linked-entity" } },
        ],
      ]),
    );
    expect(entityQueries).toEqual([]);
  });

  it("does not create an entity for a timezone-only user update", async () => {
    await db
      .insertInto("users")
      .values({ id: "timezone-only-user", name: "Timezone Only", type: "human", timezone: "UTC" })
      .execute();

    await createUserRepository(db).update("timezone-only-user", { timezone: "Asia/Kolkata" });

    await expect(
      db.selectFrom("entity_source_refs").selectAll().where("source_id", "=", "timezone-only-user").execute(),
    ).resolves.toEqual([]);
  });

  async function addEntity(input: {
    id: string;
    name?: string;
    subtype?: string;
    email?: string;
    provenanceTier?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: input.id,
        name: input.name ?? input.id,
        source_type: "person",
        subtype: input.subtype ?? "external",
        metadata: input.email ? JSON.stringify({ email: input.email }) : null,
        status: "confirmed",
        provenance_tier: input.provenanceTier ?? "inferred",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function addContactPoint(entityId: string, kind: "email" | "phone" | "whatsapp", value: string): Promise<void> {
    await db
      .insertInto("entity_contact_points")
      .values({
        id: `${entityId}-${kind}`,
        entity_id: entityId,
        kind,
        value,
        display_value: value,
        label: null,
        is_primary: 1,
        source: "test",
        connector_config_id: null,
        created_by_user_id: null,
        verified_at: null,
        last_contacted_at: null,
      })
      .execute();
  }

  async function addSlackEvidence(entityId: string, source: "organization_domain" | "team_roster"): Promise<void> {
    await db
      .insertInto("slack_user_sync_state")
      .values({
        team_id: "team-1",
        slack_user_id: `slack-${entityId}`,
        name: entityId,
        real_name: entityId,
        display_name: entityId,
        email: null,
        profile_team_id: "team-1",
        profile_json: null,
        is_bot: 0,
        is_guest: 0,
        is_stranger: 0,
        is_restricted: 0,
        is_ultra_restricted: 0,
        deleted: 0,
        classification: "internal",
        classification_source: source,
        provider_updated_at: null,
        fetched_at: new Date().toISOString(),
        entity_id: entityId,
        entity_created_by_sync: 0,
        inactive_at: null,
        last_roster_seen_at: null,
      })
      .execute();
  }

  it("links an unlinked person entity to its single exact email user", async () => {
    await db
      .insertInto("users")
      .values({ id: "user-1", name: "Alice", type: "human", email: "Alice@Example.com" })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "entity-1",
        name: "Alice",
        source_type: "person",
        subtype: "external",
        metadata: JSON.stringify({ email: "alice@example.com" }),
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    await expect(ensureUserEntityLinkForEntity(db, "entity-1")).resolves.toMatchObject({
      outcome: "linked",
      userId: "user-1",
      matchedVia: "email",
    });
    await expect(db.selectFrom("user_entity_links").selectAll().execute()).resolves.toMatchObject([
      { user_id: "user-1", entity_id: "entity-1", matched_via: "email" },
    ]);
  });

  it("matches phone users through whatsapp contact points", async () => {
    await db
      .insertInto("users")
      .values({ id: "user-phone", name: "Phone User", type: "human", whatsapp_number: "+14155550123" })
      .execute();
    await addEntity({ id: "entity-phone", name: "Phone User" });
    await addContactPoint("entity-phone", "whatsapp", "+1 (415) 555-0123");

    await expect(ensureUserEntityLinkForEntity(db, "entity-phone")).resolves.toMatchObject({
      outcome: "linked",
      userId: "user-phone",
      matchedVia: "phone",
    });
  });

  it("queues a review when email and phone identify different users", async () => {
    await db
      .insertInto("users")
      .values([
        { id: "user-email", name: "Email User", type: "human", email: "email@example.com" },
        { id: "user-phone", name: "Phone User", type: "human", whatsapp_number: "+14155550123" },
      ])
      .execute();
    await addEntity({ id: "entity-disagreement", name: "Ambiguous Person", email: "email@example.com" });
    await addContactPoint("entity-disagreement", "phone", "+1 (415) 555-0123");

    await expect(ensureUserEntityLinkForEntity(db, "entity-disagreement")).resolves.toMatchObject({
      outcome: "review_queued",
      reason: "identifier-ambiguity",
    });
    const review = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("source", "=", "user_entity_link")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(review.candidate_user_ids ?? "[]")).toEqual(["user-email", "user-phone"]);
    await expect(db.selectFrom("user_entity_links").selectAll().execute()).resolves.toEqual([]);
  });

  it("does not provision an evidence-free internal subtype", async () => {
    await addEntity({ id: "entity-inherited", subtype: "internal", email: "inherited@example.com" });

    await expect(
      ensureUserEntityLinkForEntity(db, "entity-inherited", { users: createUserRepository(db) }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "internal_without_evidence",
    });
    await expect(
      db.selectFrom("users").select("email").where("email", "=", "inherited@example.com").execute(),
    ).resolves.toEqual([]);
  });

  it("provisions an unverified human only for evidence-backed internal entities", async () => {
    await addEntity({
      id: "entity-provision",
      name: "Provisioned User",
      subtype: "internal",
      email: "provision@example.com",
    });
    await addSlackEvidence("entity-provision", "organization_domain");

    await expect(
      ensureUserEntityLinkForEntity(db, "entity-provision", { users: createUserRepository(db) }),
    ).resolves.toMatchObject({
      outcome: "linked",
      matchedVia: "provisioning",
    });
    const user = await db
      .selectFrom("users")
      .selectAll()
      .where("email", "=", "provision@example.com")
      .executeTakeFirstOrThrow();
    expect(user.type).toBe("human");
    expect(user.email_verified_at).toBeNull();
    expect(
      await db.selectFrom("user_entity_links").selectAll().where("entity_id", "=", "entity-provision").execute(),
    ).toHaveLength(1);
  });

  it("hard-stops an entity with an open identity review", async () => {
    await addEntity({ id: "entity-review-stop", subtype: "internal", email: "stop@example.com" });
    await addSlackEvidence("entity-review-stop", "team_roster");
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "review-stop",
        proposed_name: "Stopped",
        normalized_name: "stopped",
        entity_type: "person",
        source: "user_entity_link",
        source_id: "entity-review-stop",
        proposed_email: null,
        candidate_entity_id: null,
        candidate_entity_ids: null,
        candidate_user_ids: null,
        candidate_score: null,
        candidate_reason: "identifier-ambiguity",
        candidate_generated_at: new Date().toISOString(),
        triggered_by_user_id: "admin",
      })
      .execute();

    await expect(
      ensureUserEntityLinkForEntity(db, "entity-review-stop", { users: createUserRepository(db) }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "open_review",
    });
  });

  it("does not provision when an identifier belongs to an agent", async () => {
    await db
      .insertInto("users")
      .values({ id: "agent-email", name: "Agent", type: "agent", email: "agent@example.com" })
      .execute();
    await addEntity({ id: "entity-agent-email", subtype: "internal", email: "agent@example.com" });
    await addSlackEvidence("entity-agent-email", "organization_domain");

    await expect(
      ensureUserEntityLinkForEntity(db, "entity-agent-email", { users: createUserRepository(db) }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "non_human_identifier",
    });
    await expect(db.selectFrom("user_entity_links").selectAll().execute()).resolves.toEqual([]);
  });

  it("does not provision an agent-anchored entity", async () => {
    await db.insertInto("users").values({ id: "agent-anchor", name: "Agent", type: "agent" }).execute();
    await addEntity({ id: "entity-agent-anchor", subtype: "internal", email: "anchor@example.com" });
    await addSlackEvidence("entity-agent-anchor", "organization_domain");
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "agent-anchor-ref",
        entity_id: "entity-agent-anchor",
        source: "sketch_user",
        source_id: "agent-anchor",
        source_url: null,
        last_seen_at: new Date().toISOString(),
      })
      .execute();

    await expect(
      ensureUserEntityLinkForEntity(db, "entity-agent-anchor", { users: createUserRepository(db) }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "agent_anchored",
    });
  });

  it("does not link a human user to an agent-anchored entity during user-side provisioning", async () => {
    await db
      .insertInto("users")
      .values([
        { id: "human-user", name: "Human", type: "human", email: "shared-anchor@example.com" },
        { id: "agent-user", name: "Agent", type: "agent" },
      ])
      .execute();
    await addEntity({ id: "agent-anchored-match", name: "Agent Anchored", email: "shared-anchor@example.com" });
    await db
      .insertInto("entity_source_refs")
      .values({
        id: "agent-user-ref",
        entity_id: "agent-anchored-match",
        source: "sketch_user",
        source_id: "agent-user",
        source_url: null,
        last_seen_at: new Date().toISOString(),
      })
      .execute();

    await expect(ensureEntitiesForUsers(db, ["human-user"])).resolves.toEqual(new Map([["human-user", null]]));
    await expect(db.selectFrom("user_entity_links").selectAll().execute()).resolves.toEqual([]);
  });

  it("hard-stops on a non-terminal Slack review that points at the entity", async () => {
    await db
      .insertInto("users")
      .values({ id: "slack-review-user", name: "Slack Review User", type: "human", email: "slack-review@example.com" })
      .execute();
    await addEntity({ id: "slack-review-entity", name: "Slack Review", email: "slack-review@example.com" });
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "slack-review",
        proposed_name: "Slack Review",
        normalized_name: "slack review",
        entity_type: "person",
        source: "slack_user",
        source_id: "T123:U-REVIEW",
        proposed_email: "slack-review@example.com",
        candidate_entity_id: "slack-review-entity",
        candidate_entity_ids: JSON.stringify(["slack-review-entity"]),
        candidate_user_ids: null,
        candidate_score: 1,
        candidate_reason: "ambiguous-email",
        candidate_generated_at: new Date().toISOString(),
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        occurrence_count: 1,
        status: "confirming",
        triggered_by_user_id: "admin",
      })
      .execute();

    await expect(ensureUserEntityLinkForEntity(db, "slack-review-entity")).resolves.toMatchObject({
      outcome: "skipped",
      reason: "open_review",
    });
    await expect(db.selectFrom("user_entity_links").selectAll().execute()).resolves.toEqual([]);
  });

  it("hard-stops any human match when an agent shares the identifier", async () => {
    await db
      .insertInto("users")
      .values([
        { id: "mixed-human", name: "Mixed Human", type: "human", whatsapp_number: "+14155550123" },
        { id: "mixed-agent", name: "Mixed Agent", type: "agent", email: "mixed-agent@example.com" },
      ])
      .execute();
    await addEntity({ id: "mixed-match-entity", name: "Mixed Match", email: "mixed-agent@example.com" });
    await addContactPoint("mixed-match-entity", "phone", "+1 (415) 555-0123");

    await expect(ensureUserEntityLinkForEntity(db, "mixed-match-entity")).resolves.toMatchObject({
      outcome: "skipped",
      reason: "non_human_identifier",
    });
    await expect(db.selectFrom("user_entity_links").selectAll().execute()).resolves.toEqual([]);
  });

  it("returns only the confirmed linked entity and follows a stale merge pointer", async () => {
    await db
      .insertInto("users")
      .values({ id: "linked-user", name: "Linked", type: "human", email: "linked@example.com" })
      .execute();
    await addEntity({ id: "linked-source", name: "Linked Source", email: "linked@example.com" });
    await addEntity({ id: "linked-target", name: "Linked Target", email: "linked@example.com" });
    await db
      .updateTable("entities")
      .set({ deleted_at: new Date().toISOString(), merged_into_entity_id: "linked-target" })
      .where("id", "=", "linked-source")
      .execute();
    await db
      .insertInto("user_entity_links")
      .values({
        id: "linked-row",
        user_id: "linked-user",
        entity_id: "linked-source",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();

    await expect(resolvePersonEntitiesForUser(db, "linked-user", ["linked@example.com"])).resolves.toMatchObject(
      new Map([["linked@example.com", [expect.objectContaining({ id: "linked-target" })]]]),
    );
  });

  it("preserves the existing email join when no link exists", async () => {
    await db
      .insertInto("users")
      .values({ id: "fallback-user", name: "Fallback", type: "human", email: "fallback@example.com" })
      .execute();
    await addEntity({ id: "fallback-entity", name: "Fallback", email: "fallback@example.com" });

    const resolved = await resolvePersonEntitiesForUser(db, "fallback-user", ["fallback@example.com"]);
    expect([...resolved.values()].flat().map((entity) => entity.id)).toEqual(["fallback-entity"]);
  });

  it("returns a linked phone-only entity even when the user has no fallback email", async () => {
    await db
      .insertInto("users")
      .values({ id: "phone-only-user", name: "Phone Only", type: "human", email: null })
      .execute();
    await addEntity({ id: "phone-only-entity", name: "Phone Only" });
    await db
      .insertInto("user_entity_links")
      .values({
        id: "phone-only-link",
        user_id: "phone-only-user",
        entity_id: "phone-only-entity",
        matched_via: "phone",
        confirmed_by_user_id: null,
      })
      .execute();

    const resolved = await resolvePersonEntitiesForUser(db, "phone-only-user", []);
    expect([...resolved.values()].flat().map((entity) => entity.id)).toEqual(["phone-only-entity"]);
  });

  it("rolls back user creation when entity linking fails", async () => {
    const users = createUserRepository(db);
    await expect(users.create({ name: "Invalid Email", email: "invalid-email" })).rejects.toThrow(
      "Email contact point must be a valid email-like value",
    );
    await expect(db.selectFrom("users").select("id").where("email", "=", "invalid-email").execute()).resolves.toEqual(
      [],
    );
  });

  it("re-reads a human email owner after a unique-email provisioning race", async () => {
    let findCalls = 0;
    const provisioner = {
      findByEmail: async () => {
        findCalls += 1;
        return findCalls === 1 ? undefined : { id: "raced-human", type: "human" };
      },
      create: async () => {
        throw new Error("UNIQUE constraint failed: users.email");
      },
    };

    await expect(
      provisionUnverifiedUser(provisioner, { name: "Raced Human", email: "raced@example.com" }),
    ).resolves.toEqual(expect.objectContaining({ id: "raced-human" }));
    expect(findCalls).toBe(2);
  });

  it("re-reads a human email owner after a SQLite primary-key provisioning race", async () => {
    let findCalls = 0;
    const provisioner = {
      findByEmail: async () => {
        findCalls += 1;
        return findCalls === 1 ? undefined : { id: "sqlite-raced-human", type: "human" };
      },
      create: async () => {
        throw Object.assign(new Error("UNIQUE constraint failed: users.id"), {
          code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        });
      },
    };

    await expect(
      provisionUnverifiedUser(provisioner, { name: "SQLite Raced Human", email: "sqlite-raced@example.com" }),
    ).resolves.toEqual(expect.objectContaining({ id: "sqlite-raced-human" }));
    expect(findCalls).toBe(2);
  });

  it("runs a queued single-flight attempt after a rejected predecessor", async () => {
    await db.insertInto("users").values({ id: "single-flight-user", name: "Single Flight", type: "human" }).execute();
    let failures = 1;
    const instrumentedDb = db.withPlugin({
      transformQuery({ node }) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("transient query failure");
        }
        return node;
      },
      async transformResult(args) {
        return args.result;
      },
    });

    const first = ensureEntityForUser(instrumentedDb, "single-flight-user");
    const second = ensureEntityForUser(instrumentedDb, "single-flight-user");

    await expect(first).rejects.toThrow("transient query failure");
    await expect(second).resolves.toEqual(expect.objectContaining({ source_type: "person" }));
  });

  it("confirms an identity review by writing a durable review link", async () => {
    await db
      .insertInto("users")
      .values([
        { id: "candidate-a", name: "Candidate A", type: "human", email: "ambiguous@example.com" },
        { id: "candidate-b", name: "Candidate B", type: "human", whatsapp_number: "+14155550123" },
      ])
      .execute();
    await addEntity({ id: "review-entity", name: "Ambiguous", email: "ambiguous@example.com" });
    await addContactPoint("review-entity", "phone", "+1 (415) 555-0123");

    await expect(ensureUserEntityLinkForEntity(db, "review-entity")).resolves.toMatchObject({
      outcome: "review_queued",
    });
    const review = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("source", "=", "user_entity_link")
      .where("source_id", "=", "review-entity")
      .executeTakeFirstOrThrow();
    if (!review.candidate_generated_at) throw new Error("identity review is missing its candidate timestamp");
    const confirmed = await confirmUserEntityLink(db, {
      reviewId: review.id,
      confirmingUserId: "admin",
      linkUserId: "candidate-b",
      candidateGeneratedAt: review.candidate_generated_at,
    });

    expect(confirmed.row.status).toBe("confirmed");
    await expect(
      db.selectFrom("user_entity_links").selectAll().where("entity_id", "=", "review-entity").executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      user_id: "candidate-b",
      matched_via: "review",
      confirmed_by_user_id: "admin",
    });
  });
});
