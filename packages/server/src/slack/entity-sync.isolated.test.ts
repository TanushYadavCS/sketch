import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { type SlackEntitySyncConnection, type SlackEntitySyncFacade, createSlackEntitySync } from "./entity-sync";
import type { SlackIndexingChannel, SlackIndexingUser } from "./indexing-facade";

function user(overrides: Partial<SlackIndexingUser> = {}): SlackIndexingUser {
  return {
    slackUserId: "U1",
    name: "alice",
    realName: "Alice Example",
    displayName: "Alice",
    email: null,
    profileTeamId: "T1",
    isBot: false,
    isGuest: false,
    isStranger: false,
    isRestricted: false,
    isUltraRestricted: false,
    deleted: false,
    providerUpdatedAt: "100",
    ...overrides,
  };
}

function channel(overrides: Partial<SlackIndexingChannel> = {}): SlackIndexingChannel {
  return { id: "C1", name: "general", isMember: false, isPrivate: false, ...overrides };
}

function invalidCursorError(): Error & { data: { error: string } } {
  return Object.assign(new Error("invalid_cursor"), { data: { error: "invalid_cursor" } });
}

function providerError(code: string): Error & { data: { error: string } } {
  return Object.assign(new Error(code), { data: { error: code } });
}

function emptyFacade(): SlackEntitySyncFacade {
  return {
    listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    listChannelsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    listChannelMembersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    getUserInfo: vi.fn(),
  };
}

describe("Slack entity sync", () => {
  let db: Kysely<DB> | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await db?.destroy();
    db = undefined;
  });

  function makeSync(
    facade: SlackEntitySyncFacade,
    active: SlackEntitySyncConnection = { botToken: "xoxb-t1", teamId: "T1" },
    overrides: Partial<Parameters<typeof createSlackEntitySync>[0]> = {},
  ) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sync = createSlackEntitySync({
      db: db as Kysely<DB>,
      logger,
      enabled: true,
      publicChannelsEnabled: true,
      getActiveConnection: async () => active,
      createFacade: () => facade,
      ...overrides,
    });
    return { sync, logger };
  }

  async function createDb(): Promise<Kysely<DB>> {
    db = await createTestDb();
    return db;
  }

  function getDb(): Kysely<DB> {
    if (!db) throw new Error("test database is not initialized");
    return db;
  }

  it("completes a backfill from bounded pages without blocking enqueue", async () => {
    vi.useFakeTimers();
    await createDb();
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async (cursor?: string) =>
        cursor ? { items: [], nextCursor: null } : { items: [user()], nextCursor: null },
      ),
      listChannelsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelMembersPage: vi.fn(),
      getUserInfo: vi.fn(),
    };
    const { sync } = makeSync(facade, active);

    const run = sync.enqueueBackfill(active);
    expect(run).toBeInstanceOf(Promise);
    await run;

    await expect(
      db?.selectFrom("slack_sync_runs").select(["status", "stage"]).executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "completed",
      stage: "completed",
    });
    await expect(db?.selectFrom("slack_user_sync_state").selectAll().execute()).resolves.toHaveLength(1);
    expect(facade.listUsersPage).toHaveBeenCalledWith(undefined);
    expect(facade.listChannelsPage).toHaveBeenCalledWith(undefined);
  });

  it("excludes bots and records deleted humans as inactive without tombstoning by absence", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({
        items: [
          user({ slackUserId: "U-BOT", isBot: true }),
          user({ slackUserId: "U-DELETED", name: "gone", deleted: true }),
        ],
        nextCursor: null,
      })),
      listChannelsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelMembersPage: vi.fn(),
      getUserInfo: vi.fn(),
    };
    const { sync } = makeSync(facade);
    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    await expect(getDb().selectFrom("slack_user_sync_state").selectAll().execute()).resolves.toMatchObject([
      expect.objectContaining({ slack_user_id: "U-DELETED", deleted: 1 }),
    ]);
    await expect(
      getDb().selectFrom("entity_source_refs").selectAll().where("source_id", "=", "T1:U-BOT").execute(),
    ).resolves.toHaveLength(0);
  });

  it("resumes from the last committed cursor after a provider failure", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi
        .fn()
        .mockResolvedValueOnce({ items: [user({ slackUserId: "U1" })], nextCursor: "users-2" })
        .mockRejectedValueOnce(providerError("ratelimited"))
        .mockResolvedValueOnce({ items: [user({ slackUserId: "U2", name: "bob" })], nextCursor: null }),
      listChannelsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelMembersPage: vi.fn(),
      getUserInfo: vi.fn(),
    };
    const { sync } = makeSync(facade);
    const active = { botToken: "xoxb-t1", teamId: "T1" };

    await sync.enqueueBackfill(active);
    await sync.enqueueBackfill(active);

    expect(facade.listUsersPage).toHaveBeenNthCalledWith(1, undefined);
    expect(facade.listUsersPage).toHaveBeenNthCalledWith(2, "users-2");
    expect(facade.listUsersPage).toHaveBeenNthCalledWith(3, "users-2");
    await expect(db?.selectFrom("slack_user_sync_state").selectAll().execute()).resolves.toHaveLength(2);
  });

  it("restarts a stage when Slack rejects a resumed cursor", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi
        .fn()
        .mockResolvedValueOnce({ items: [user({ slackUserId: "U1" })], nextCursor: "expired" })
        .mockRejectedValueOnce(invalidCursorError())
        .mockResolvedValueOnce({ items: [user({ slackUserId: "U2", name: "bob" })], nextCursor: null }),
      listChannelsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelMembersPage: vi.fn(),
      getUserInfo: vi.fn(),
    };
    const { sync } = makeSync(facade);
    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    expect(facade.listUsersPage).toHaveBeenNthCalledWith(3, undefined);
    await expect(db?.selectFrom("slack_user_sync_state").selectAll().execute()).resolves.toHaveLength(2);
  });

  it("aborts before page writes when the active team changes", async () => {
    await createDb();
    let active: SlackEntitySyncConnection = { botToken: "xoxb-t1", teamId: "T1" };
    const facade = emptyFacade();
    facade.listUsersPage = vi.fn(async () => {
      active = { botToken: "xoxb-t2", teamId: "T2" };
      return { items: [user()], nextCursor: null };
    });
    const tokens: string[] = [];
    const { sync } = makeSync(facade, active, {
      getActiveConnection: async () => active,
      createFacade: (token) => {
        tokens.push(token);
        return facade;
      },
    });

    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    expect(tokens).toEqual(["xoxb-t1"]);
    await expect(db?.selectFrom("slack_user_sync_state").selectAll().execute()).resolves.toHaveLength(0);
    await expect(db?.selectFrom("slack_sync_runs").select("status").executeTakeFirstOrThrow()).resolves.toMatchObject({
      status: "aborted",
    });
  });

  it("syncs a public non-member channel and roster-only Slack Connect users", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({ items: [channel({ id: "C-PUBLIC" })], nextCursor: null })),
      listChannelMembersPage: vi.fn(async () => ({ items: ["U-CONNECT"], nextCursor: null })),
      getUserInfo: vi.fn(async () =>
        user({
          slackUserId: "U-CONNECT",
          name: "external",
          realName: "External Collaborator",
          isStranger: true,
          profileTeamId: "T2",
        }),
      ),
    };
    const { sync } = makeSync(facade);
    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    await expect(
      db?.selectFrom("entity_source_refs").selectAll().where("source_id", "=", "T1:U-CONNECT").execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        ?.selectFrom("slack_user_sync_state")
        .select(["classification", "email"])
        .where("slack_user_id", "=", "U-CONNECT")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ classification: "external", email: null });
    expect(facade.listChannelMembersPage).toHaveBeenCalledWith("C-PUBLIC", undefined);
  });

  it("persists empty rosters separately from failed roster reads", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({
        items: [channel({ id: "C-EMPTY" }), channel({ id: "C-FAILED" })],
        nextCursor: null,
      })),
      listChannelMembersPage: vi.fn(async (channelId: string) => {
        if (channelId === "C-FAILED") throw providerError("channel_not_found");
        return { items: [], nextCursor: null };
      }),
      getUserInfo: vi.fn(),
    };
    const { sync } = makeSync(facade);
    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    const run = await getDb().selectFrom("slack_sync_runs").select("error").executeTakeFirstOrThrow();
    expect(JSON.parse(run.error ?? "{}").skipReasons).toEqual([{ channelId: "C-FAILED", reason: "channel_not_found" }]);
    expect(facade.getUserInfo).not.toHaveBeenCalled();
  });

  it("skips private channels where Sketch is not a member and gates public channels", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({
        items: [channel({ id: "C-PUBLIC" }), channel({ id: "C-PRIVATE", isPrivate: true, isMember: false })],
        nextCursor: null,
      })),
      listChannelMembersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      getUserInfo: vi.fn(),
    };
    const { sync } = makeSync(facade, undefined, { publicChannelsEnabled: false });
    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    const run = await getDb().selectFrom("slack_sync_runs").select("error").executeTakeFirstOrThrow();
    expect(JSON.parse(run.error ?? "{}").skipReasons).toEqual([
      { channelId: "C-PUBLIC", reason: "public_channels_disabled" },
      { channelId: "C-PRIVATE", reason: "private_channel_not_member" },
    ]);
    expect(facade.listChannelMembersPage).not.toHaveBeenCalled();
  });

  it("caps users.info lookups and leaves overflow pending for a later run", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({
        items: [channel({ id: "C1" }), channel({ id: "C2" })],
        nextCursor: null,
      })),
      listChannelMembersPage: vi.fn(async (channelId: string) => ({
        items: channelId === "C1" ? ["U1"] : ["U2"],
        nextCursor: null,
      })),
      getUserInfo: vi.fn(async (slackUserId: string) => user({ slackUserId, name: slackUserId })),
    };
    const { sync } = makeSync(facade, undefined, { userInfoCap: 1 });
    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    expect(facade.getUserInfo).toHaveBeenCalledTimes(2);
    await expect(
      db
        ?.selectFrom("slack_user_sync_state")
        .select("profile_json")
        .where("slack_user_id", "=", "U2")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ profile_json: JSON.stringify({ status: "pending", reason: "users.info_cap" }) });
  });

  it("reclaims a stale run at startup and does not rerun a completed backfill", async () => {
    await createDb();
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    await db
      ?.insertInto("slack_sync_runs")
      .values({
        id: "stale-run",
        team_id: "T1",
        run_type: "backfill",
        trigger_key: "backfill",
        pinned_team_id: "T1",
        status: "running",
        stage: "users",
        heartbeat_at: stale,
        users_cursor: null,
        conversations_cursor: null,
        members_cursor: null,
        current_channel_id: null,
        started_at: stale,
        completed_at: null,
        error: null,
        created_at: stale,
        updated_at: stale,
      })
      .execute();
    const facade = emptyFacade();
    const { sync } = makeSync(facade);
    sync.start();
    await vi.waitFor(async () => {
      const run = await db?.selectFrom("slack_sync_runs").select(["status", "error"]).executeTakeFirstOrThrow();
      expect(run).toMatchObject({ status: "completed" });
    });
    expect(facade.listUsersPage).toHaveBeenCalledTimes(2);

    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });
    expect(facade.listUsersPage).toHaveBeenCalledTimes(2);
  });

  it("coalesces same-team work and keeps connection activation fire-and-forget", async () => {
    await createDb();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade = emptyFacade();
    facade.listUsersPage = vi.fn(async () => {
      await blocked;
      return { items: [], nextCursor: null };
    });
    const { sync } = makeSync(facade);
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const first = sync.enqueueBackfill(active);
    const second = sync.enqueueBackfill(active);
    await vi.waitFor(() => expect(facade.listUsersPage).toHaveBeenCalledOnce());
    expect(sync.onConnectionActivated(active)).toBeUndefined();
    release();
    await Promise.all([first, second]);
  });

  it("runs one durable repair sweep immediately after a successful backfill", async () => {
    await createDb();
    const facade = emptyFacade();
    const { sync } = makeSync(facade);
    const active = { botToken: "xoxb-t1", teamId: "T1" };

    await sync.enqueueBackfill(active);

    const runs = await getDb().selectFrom("slack_sync_runs").select(["run_type", "status"]).execute();
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run_type: "backfill", status: "completed" }),
        expect.objectContaining({ run_type: "sweep", status: "completed" }),
      ]),
    );
  });

  it("tombstones an external only after a complete sweep sees it in no roster", async () => {
    await createDb();
    let mode: "present" | "absent" = "present";
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({ items: [channel({ id: "C1" })], nextCursor: null })),
      listChannelMembersPage: vi.fn(async () => ({
        items: mode === "present" ? ["U-EXTERNAL"] : [],
        nextCursor: null,
      })),
      getUserInfo: vi.fn(async () =>
        user({ slackUserId: "U-EXTERNAL", name: "external", isStranger: true, profileTeamId: "T2" }),
      ),
    };
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const { sync } = makeSync(facade, active, { sweepIntervalMs: 1 });

    await sync.enqueueBackfill(active);
    mode = "absent";
    await new Promise((resolve) => setTimeout(resolve, 5));
    sync.start();

    await vi.waitFor(async () => {
      const state = await getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-EXTERNAL")
        .executeTakeFirstOrThrow();
      expect(state.inactive_at).not.toBeNull();
    });
    await sync.stop();
  });

  it("preserves an external when a channel roster page fails during a sweep", async () => {
    await createDb();
    let failRoster = false;
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({ items: [channel({ id: "C1" })], nextCursor: null })),
      listChannelMembersPage: vi.fn(async () => {
        if (failRoster) throw providerError("channel_not_found");
        return { items: ["U-EXTERNAL"], nextCursor: null };
      }),
      getUserInfo: vi.fn(async () =>
        user({ slackUserId: "U-EXTERNAL", name: "external", isStranger: true, profileTeamId: "T2" }),
      ),
    };
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const { sync } = makeSync(facade, active, { sweepIntervalMs: 1 });

    await sync.enqueueBackfill(active);
    failRoster = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    sync.start();

    await vi.waitFor(async () => {
      const sweep = await getDb()
        .selectFrom("slack_sync_runs")
        .select(["status", "error"])
        .where("run_type", "=", "sweep")
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      expect(sweep.status).toBe("completed");
      expect(sweep.error).toContain("channel_not_found");
    });
    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-EXTERNAL")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: null });
    await sync.stop();
  });
});
