import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createSlackChannelParticipantsRepository } from "./slack-channel-participants";

function runSuite(label: string, createDb: () => Promise<Kysely<DB>>) {
  describe(label, () => {
    let db: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("upserts and removes exact memberships", async () => {
      const repo = createSlackChannelParticipantsRepository(db);
      await repo.upsert("C1", "U1", "2026-07-31T00:00:00.000Z");
      await repo.upsert("C1", "U1", "2026-07-31T01:00:00.000Z");
      await repo.upsert("C1", "U2", "2026-07-31T01:00:00.000Z");

      await expect(
        db
          .selectFrom("slack_channel_participants")
          .selectAll()
          .where("channel_id", "=", "C1")
          .orderBy("slack_user_id", "asc")
          .execute(),
      ).resolves.toEqual([
        { channel_id: "C1", slack_user_id: "U1", last_seen_at: "2026-07-31T01:00:00.000Z" },
        { channel_id: "C1", slack_user_id: "U2", last_seen_at: "2026-07-31T01:00:00.000Z" },
      ]);

      await repo.remove("C1", "U1");
      await expect(
        db.selectFrom("slack_channel_participants").select("slack_user_id").where("channel_id", "=", "C1").execute(),
      ).resolves.toEqual([{ slack_user_id: "U2" }]);
    });

    it("atomically replaces one channel roster without changing another", async () => {
      const repo = createSlackChannelParticipantsRepository(db);
      await repo.replaceChannelRoster("C1", [" U1 ", "U1", "U2"], "2026-07-31T00:00:00.000Z");
      await repo.replaceChannelRoster("C2", ["U9"], "2026-07-31T00:00:00.000Z");
      await repo.replaceChannelRoster("C1", ["U2", "U3"], "2026-07-31T02:00:00.000Z");

      await expect(
        db
          .selectFrom("slack_channel_participants")
          .selectAll()
          .orderBy("channel_id", "asc")
          .orderBy("slack_user_id", "asc")
          .execute(),
      ).resolves.toEqual([
        { channel_id: "C1", slack_user_id: "U2", last_seen_at: "2026-07-31T02:00:00.000Z" },
        { channel_id: "C1", slack_user_id: "U3", last_seen_at: "2026-07-31T02:00:00.000Z" },
        { channel_id: "C2", slack_user_id: "U9", last_seen_at: "2026-07-31T00:00:00.000Z" },
      ]);
    });

    it("preserves participants observed after the provider snapshot began", async () => {
      const repo = createSlackChannelParticipantsRepository(db);
      await repo.upsert("C1", "U-STALE", "2026-07-31T00:00:00.000Z");
      await repo.upsert("C1", "U-OBSERVED", "2026-07-31T01:00:00.001Z");

      await repo.replaceChannelRoster("C1", ["U-PROVIDER"], "2026-07-31T01:00:01.000Z", "2026-07-31T01:00:00.000Z");

      await expect(
        db
          .selectFrom("slack_channel_participants")
          .select("slack_user_id")
          .where("channel_id", "=", "C1")
          .orderBy("slack_user_id", "asc")
          .execute(),
      ).resolves.toEqual([{ slack_user_id: "U-OBSERVED" }, { slack_user_id: "U-PROVIDER" }]);
    });

    it("rejects an empty replacement without deleting the prior roster", async () => {
      const repo = createSlackChannelParticipantsRepository(db);
      await repo.replaceChannelRoster("C1", ["U1"], "2026-07-31T00:00:00.000Z");
      await expect(repo.replaceChannelRoster("C1", [])).rejects.toThrow("must not be empty");
      await expect(
        db.selectFrom("slack_channel_participants").select("slack_user_id").where("channel_id", "=", "C1").execute(),
      ).resolves.toEqual([{ slack_user_id: "U1" }]);
    });

    it("clears every channel roster on Slack disconnect", async () => {
      const repo = createSlackChannelParticipantsRepository(db);
      await repo.upsert("C1", "U1");
      await repo.upsert("C2", "U2");

      await repo.clearAll();

      await expect(db.selectFrom("slack_channel_participants").selectAll().execute()).resolves.toEqual([]);
    });
  });
}

runSuite("slack channel participants sqlite", async () => createTestDb());
runSuite("slack channel participants postgres", async () => createTestPgDb());
