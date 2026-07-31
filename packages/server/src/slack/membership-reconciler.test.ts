import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSlackChannelParticipantsRepository } from "../db/repositories/slack-channel-participants";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { SlackMembershipReconciler } from "./membership-reconciler";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SlackMembershipReconciler", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("refreshes persisted channels sequentially and preserves a failed channel", async () => {
    const conversations = createConversationRepository(db);
    await conversations.getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C1",
    });
    await conversations.getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C2",
    });
    const participants = createSlackChannelParticipantsRepository(db);
    await participants.upsert("C2", "U-OLD", "2026-07-30T00:00:00.000Z");
    const active = { value: 0 };
    const maxActive = { value: 0 };
    const listChannelMembers = vi.fn(async (channelId: string) => {
      active.value += 1;
      maxActive.value = Math.max(maxActive.value, active.value);
      try {
        if (channelId === "C2") throw new Error("rate limited");
        return ["U1", "U2"];
      } finally {
        active.value -= 1;
      }
    });
    const reconciler = new SlackMembershipReconciler({
      db,
      logger: createTestLogger(),
      getSlack: () => ({ listChannelMembers }),
    });

    await reconciler.wake();

    expect(maxActive.value).toBe(1);
    expect(listChannelMembers.mock.calls.map(([channelId]) => channelId)).toEqual(["C1", "C2"]);
    await expect(
      db
        .selectFrom("slack_channel_participants")
        .select(["channel_id", "slack_user_id"])
        .orderBy("channel_id", "asc")
        .orderBy("slack_user_id", "asc")
        .execute(),
    ).resolves.toEqual([
      { channel_id: "C1", slack_user_id: "U1" },
      { channel_id: "C1", slack_user_id: "U2" },
      { channel_id: "C2", slack_user_id: "U-OLD" },
    ]);
  });

  it("preserves the prior roster when Slack returns an empty channel roster", async () => {
    const conversations = createConversationRepository(db);
    await conversations.getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C1",
    });
    const participants = createSlackChannelParticipantsRepository(db);
    await participants.upsert("C1", "U-OLD", "2026-07-30T00:00:00.000Z");
    const reconciler = new SlackMembershipReconciler({
      db,
      logger: createTestLogger(),
      getSlack: () => ({ listChannelMembers: async () => [] }),
    });

    await reconciler.wake();

    await expect(
      db.selectFrom("slack_channel_participants").select("slack_user_id").where("channel_id", "=", "C1").execute(),
    ).resolves.toEqual([{ slack_user_id: "U-OLD" }]);
  });

  it("does not restore a leave event from an older provider snapshot", async () => {
    const conversations = createConversationRepository(db);
    await conversations.getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C1",
    });
    const participants = createSlackChannelParticipantsRepository(db);
    await participants.upsert("C1", "U1");
    const snapshotStarted = deferred();
    const continueSnapshot = deferred();
    const listChannelMembers = vi
      .fn<(channelId: string) => Promise<string[]>>()
      .mockImplementationOnce(async () => {
        snapshotStarted.resolve();
        await continueSnapshot.promise;
        return ["U1"];
      })
      .mockResolvedValue([]);
    const reconciler = new SlackMembershipReconciler({
      db,
      logger: createTestLogger(),
      getSlack: () => ({ listChannelMembers }),
    });

    const wake = reconciler.wake();
    await snapshotStarted.promise;
    await reconciler.recordParticipantLeft("C1", "U1");
    continueSnapshot.resolve();
    await wake;

    expect(listChannelMembers).toHaveBeenCalledTimes(2);
    await expect(
      db.selectFrom("slack_channel_participants").selectAll().where("channel_id", "=", "C1").execute(),
    ).resolves.toEqual([]);
  });

  it("does not restore an in-flight provider snapshot after disconnect clears the roster", async () => {
    const conversations = createConversationRepository(db);
    await conversations.getOrCreate({
      platform: "slack",
      kind: "channel",
      providerConversationId: "C1",
    });
    const participants = createSlackChannelParticipantsRepository(db);
    await participants.upsert("C1", "U1");
    const snapshotStarted = deferred();
    const continueSnapshot = deferred();
    const listChannelMembers = vi
      .fn<(channelId: string) => Promise<string[]>>()
      .mockImplementationOnce(async () => {
        snapshotStarted.resolve();
        await continueSnapshot.promise;
        return ["U1"];
      })
      .mockResolvedValue([]);
    const reconciler = new SlackMembershipReconciler({
      db,
      logger: createTestLogger(),
      getSlack: () => ({ listChannelMembers }),
    });

    const wake = reconciler.wake();
    await snapshotStarted.promise;
    await reconciler.clearAllParticipants();
    continueSnapshot.resolve();
    await wake;

    await expect(
      db.selectFrom("slack_channel_participants").selectAll().where("channel_id", "=", "C1").execute(),
    ).resolves.toEqual([]);
  });

  it("does no work while Slack is disconnected", async () => {
    const reconciler = new SlackMembershipReconciler({
      db,
      logger: createTestLogger(),
      getSlack: () => null,
    });
    await expect(reconciler.wake()).resolves.toBeUndefined();
  });
});
