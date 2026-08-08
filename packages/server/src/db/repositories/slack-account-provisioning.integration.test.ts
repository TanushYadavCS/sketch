import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findVerifiedUserByEmail } from "../../auth/magic-link";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { upsertSlackPersonEntity } from "./slack-entity-sync";

type SlackProfile = Parameters<typeof upsertSlackPersonEntity>[1];

function profile(overrides: Partial<SlackProfile> = {}): SlackProfile {
  return {
    teamId: "T-ACCOUNT",
    slackUserId: "U-ACCOUNT",
    name: "alice.account",
    realName: "Alice Account",
    email: "alice@acme.example",
    phone: null,
    profileTeamId: "T-ACCOUNT",
    isBot: false,
    isGuest: false,
    isStranger: false,
    isRestricted: false,
    isUltraRestricted: false,
    deleted: false,
    providerUpdatedAt: "100",
    fetchedAt: "2026-08-06T10:00:00.000Z",
    ...overrides,
  };
}

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await db
        .insertInto("organization_domains")
        .values({
          id: "domain-acme",
          domain: "acme.example",
          source: "admin_email",
          verified_at: "2026-08-06T00:00:00.000Z",
        })
        .execute();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("creates an unverified member for an organization-domain classification", async () => {
      await upsertSlackPersonEntity(db, profile());

      await expect(
        db.selectFrom("users").selectAll().where("email", "=", "alice@acme.example").execute(),
      ).resolves.toEqual([
        expect.objectContaining({
          name: "Alice Account",
          email: "alice@acme.example",
          slack_user_id: "U-ACCOUNT",
          type: "human",
          auth_role: "member",
          email_verified_at: null,
        }),
      ]);
    });

    it("does not create accounts for external or no-evidence profiles", async () => {
      await upsertSlackPersonEntity(
        db,
        profile({ slackUserId: "U-EXTERNAL", email: "alice@outside.example", providerUpdatedAt: "101" }),
      );
      await upsertSlackPersonEntity(
        db,
        profile({ slackUserId: "U-NO-EVIDENCE", email: null, providerUpdatedAt: "102" }),
      );

      await expect(db.selectFrom("users").select("id").execute()).resolves.toEqual([]);
    });

    it("does not allow an unverified provisioned account to request a magic link", async () => {
      await upsertSlackPersonEntity(db, profile());

      await expect(findVerifiedUserByEmail(db, "alice@acme.example")).resolves.toBeNull();
    });

    it("is idempotent across repeated lifecycle upserts", async () => {
      await upsertSlackPersonEntity(db, profile());
      await upsertSlackPersonEntity(db, profile());

      await expect(
        db.selectFrom("users").selectAll().where("email", "=", "alice@acme.example").execute(),
      ).resolves.toHaveLength(1);
    });

    it("defers to an existing managed member identity without creating or replacing the user", async () => {
      await db
        .insertInto("users")
        .values({
          id: "existing-account",
          name: "Existing Account",
          email: "alice@acme.example",
          email_verified_at: "2026-08-05T00:00:00.000Z",
          whatsapp_number: "+15555550123",
          auth_role: "admin",
          type: "human",
        })
        .execute();

      await upsertSlackPersonEntity(db, profile());

      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", "existing-account")
        .executeTakeFirstOrThrow();
      expect(user).toMatchObject({
        id: "existing-account",
        name: "Alice Account",
        email: "alice@acme.example",
        slack_user_id: "U-ACCOUNT",
        whatsapp_number: "+15555550123",
        auth_role: "admin",
      });
      expect(user.email_verified_at).not.toBeNull();
    });

    it("does not change a verified existing Slack identity when the profile email differs", async () => {
      await db
        .insertInto("users")
        .values({
          id: "verified-profile-account",
          name: "Alice Account",
          email: "alice.account@example.com",
          email_verified_at: "2026-08-05T00:00:00.000Z",
          slack_user_id: "U-ACCOUNT",
          auth_role: "member",
          type: "human",
        })
        .execute();

      await upsertSlackPersonEntity(db, profile({ email: "alice@acme.example" }));

      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", "verified-profile-account")
        .executeTakeFirstOrThrow();
      expect(user.email).toBe("alice.account@example.com");
      expect(user.email_verified_at).not.toBeNull();
    });

    it("does not change an unverified existing Slack identity during provisioning", async () => {
      await db
        .insertInto("users")
        .values({
          id: "unverified-profile-account",
          name: "Alice Account",
          email: "alice.account@example.com",
          email_verified_at: null,
          slack_user_id: "U-ACCOUNT",
          auth_role: "member",
          type: "human",
        })
        .execute();

      await upsertSlackPersonEntity(db, profile({ email: "alice@acme.example" }));

      await expect(
        db.selectFrom("users").selectAll().where("id", "=", "unverified-profile-account").executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ email: "alice.account@example.com", email_verified_at: null });
    });

    it("links an email-matched user without changing its verification state", async () => {
      await db
        .insertInto("users")
        .values({
          id: "email-matched-account",
          name: "Alice Account",
          email: "alice@acme.example",
          email_verified_at: null,
          auth_role: "member",
          type: "human",
        })
        .execute();

      await upsertSlackPersonEntity(db, profile());

      await expect(
        db.selectFrom("users").selectAll().where("id", "=", "email-matched-account").executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ slack_user_id: "U-ACCOUNT", email_verified_at: null });
    });

    it("preserves a conflicting Slack identity", async () => {
      await db
        .insertInto("users")
        .values({
          id: "conflicting-account",
          name: "Conflicting Account",
          email: "alice@acme.example",
          slack_user_id: "U-OTHER",
          auth_role: "member",
          type: "human",
        })
        .execute();

      await upsertSlackPersonEntity(db, profile());

      await expect(
        db
          .selectFrom("users")
          .select(["id", "slack_user_id"])
          .where("email", "=", "alice@acme.example")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ id: "conflicting-account", slack_user_id: "U-OTHER" });
    });
  });
}

runSuite("Slack account provisioning SQLite", createTestDb);
runSuite("Slack account provisioning Postgres", createTestPgDb);
