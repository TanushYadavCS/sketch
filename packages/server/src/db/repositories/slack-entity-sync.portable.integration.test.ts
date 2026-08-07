import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { upsertSlackPersonEntity } from "./slack-entity-sync";

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await db
        .insertInto("entities")
        .values(
          Array.from({ length: 101 }, (_, index) => ({
            id: `wildcard-candidate-${index}`,
            name: `Existing Person ${index}`,
            source_type: "person",
            subtype: null,
            aliases: JSON.stringify(["AliceX_wildcard"]),
            metadata: "{}",
            source_ref_id: null,
            status: "confirmed",
            provenance_tier: "inferred",
            hotness: 0,
            created_at: "2026-08-05T10:00:00.000Z",
            updated_at: "2026-08-05T10:00:00.000Z",
          })),
        )
        .execute();
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("escapes wildcard characters before the bounded alias candidate scan", async () => {
      const logger = { warn: vi.fn() };
      await upsertSlackPersonEntity(
        db,
        {
          teamId: "T-WILDCARD",
          slackUserId: "U-WILDCARD",
          name: "alice%_wildcard",
          realName: "Alice%_wildcard",
          displayName: "Alice%_wildcard",
          email: null,
          phone: null,
          profileTeamId: "T-WILDCARD",
          isBot: false,
          isGuest: false,
          isStranger: false,
          isRestricted: false,
          isUltraRestricted: false,
          deleted: false,
          providerUpdatedAt: "00000000001785924000",
          fetchedAt: "2026-08-05T11:00:00.000Z",
        },
        { logger },
      );

      expect(logger.warn).not.toHaveBeenCalled();
      await expect(
        db
          .selectFrom("entity_source_refs")
          .select("entity_id")
          .where("source_id", "=", "T-WILDCARD:U-WILDCARD")
          .execute(),
      ).resolves.toHaveLength(1);
      await expect(
        db.selectFrom("entity_review_queue").select("id").where("source_id", "=", "T-WILDCARD:U-WILDCARD").execute(),
      ).resolves.toHaveLength(0);
    });

    it("logs when ambiguous email candidates have no usable profile name", async () => {
      await db
        .insertInto("entities")
        .values([
          {
            id: "ambiguous-name-missing-a",
            name: "A",
            source_type: "person",
            subtype: null,
            aliases: null,
            metadata: JSON.stringify({ email: "ambiguous-name-missing@example.com" }),
            source_ref_id: null,
            status: "confirmed",
            provenance_tier: "inferred",
            hotness: 0,
            created_at: "2026-08-05T10:00:00.000Z",
            updated_at: "2026-08-05T10:00:00.000Z",
          },
          {
            id: "ambiguous-name-missing-b",
            name: "B",
            source_type: "person",
            subtype: null,
            aliases: null,
            metadata: JSON.stringify({ email: "ambiguous-name-missing@example.com" }),
            source_ref_id: null,
            status: "confirmed",
            provenance_tier: "inferred",
            hotness: 0,
            created_at: "2026-08-05T10:00:00.000Z",
            updated_at: "2026-08-05T10:00:00.000Z",
          },
        ])
        .execute();
      const logger = { warn: vi.fn() };

      await upsertSlackPersonEntity(
        db,
        {
          teamId: "T-MISSING-NAME",
          slackUserId: "U-MISSING-NAME",
          name: "",
          realName: "",
          displayName: "",
          email: "ambiguous-name-missing@example.com",
          phone: null,
          profileTeamId: "T-MISSING-NAME",
          isBot: false,
          isGuest: false,
          isStranger: false,
          isRestricted: false,
          isUltraRestricted: false,
          deleted: false,
          providerUpdatedAt: "00000000001785924000",
          fetchedAt: "2026-08-05T11:00:00.000Z",
        },
        { logger },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        { candidateEntityIds: ["ambiguous-name-missing-a", "ambiguous-name-missing-b"], slackUserId: "U-MISSING-NAME" },
        "Skipping Slack entity review row because the profile has no usable name",
      );
      await expect(
        db
          .selectFrom("entity_review_queue")
          .select("id")
          .where("source_id", "=", "T-MISSING-NAME:U-MISSING-NAME")
          .execute(),
      ).resolves.toHaveLength(0);
    });

    it("logs conflicting Slack identity ids without dropping the sync", async () => {
      await db
        .insertInto("users")
        .values({
          id: "conflict-user",
          name: "Existing Conflict",
          type: "human",
          email: "conflict@example.com",
          slack_user_id: "U-EXISTING",
        })
        .execute();
      await db
        .insertInto("entities")
        .values({
          id: "conflict-entity",
          name: "Existing Conflict",
          source_type: "person",
          subtype: "internal",
          aliases: null,
          metadata: JSON.stringify({ email: "conflict@example.com" }),
          source_ref_id: null,
          status: "confirmed",
          provenance_tier: "inferred",
          hotness: 0,
          created_at: "2026-08-05T10:00:00.000Z",
          updated_at: "2026-08-05T10:00:00.000Z",
        })
        .execute();
      const logger = { warn: vi.fn() };

      await upsertSlackPersonEntity(
        db,
        {
          teamId: "T-CONFLICT",
          slackUserId: "U-INCOMING",
          name: "Existing Conflict",
          realName: "Existing Conflict",
          displayName: "Existing Conflict",
          email: "conflict@example.com",
          phone: null,
          profileTeamId: "T-CONFLICT",
          isBot: false,
          isGuest: false,
          isStranger: false,
          isRestricted: false,
          isUltraRestricted: false,
          deleted: false,
          providerUpdatedAt: "00000000001785924000",
          fetchedAt: "2026-08-05T11:00:00.000Z",
        },
        { logger },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        {
          email: "conflict@example.com",
          existingSlackUserId: "U-EXISTING",
          incomingSlackUserId: "U-INCOMING",
        },
        "Skipped Sketch account link for conflicting Slack identity",
      );
    });

    it("uses live Slack lookup when the human roster snapshot has no user", async () => {
      await db
        .insertInto("users")
        .values({
          id: "roster-agent",
          name: "Roster Agent",
          type: "agent",
          email: "agent@example.com",
          slack_user_id: "U-ROSTER-MISS",
        })
        .execute();

      await expect(
        upsertSlackPersonEntity(
          db,
          {
            teamId: "T-ROSTER-MISS",
            slackUserId: "U-ROSTER-MISS",
            name: "Roster Agent",
            realName: "Roster Agent",
            displayName: "Roster Agent",
            email: "new-human@example.com",
            phone: null,
            profileTeamId: "T-ROSTER-MISS",
            isBot: false,
            isGuest: false,
            isStranger: false,
            isRestricted: false,
            isUltraRestricted: false,
            deleted: false,
            providerUpdatedAt: "00000000001785924000",
            fetchedAt: "2026-08-05T11:00:00.000Z",
          },
          {
            teamRoster: {
              slackUserIds: new Set(["U-ROSTER-MISS"]),
              emails: new Set(["new-human@example.com"]),
              usersBySlackId: new Map(),
            },
          },
        ),
      ).resolves.toMatchObject({ applied: true });

      await expect(
        db.selectFrom("users").select(["id", "slack_user_id"]).where("slack_user_id", "=", "U-ROSTER-MISS").execute(),
      ).resolves.toEqual([{ id: "roster-agent", slack_user_id: "U-ROSTER-MISS" }]);
    });
  });
}

runSuite("Slack entity sync wildcard scan SQLite", createTestDb);
runSuite("Slack entity sync wildcard scan Postgres", createTestPgDb);
