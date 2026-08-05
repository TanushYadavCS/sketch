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

  it("refreshes a human member join through users.info and clears a tombstone", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.getUserInfo = vi.fn(async () => user({ slackUserId: "U-JOIN", name: "joined" }));
    const { sync } = makeSync(facade);

    await sync.handleMemberJoinedChannel({ teamId: "T1", channelId: "C1", slackUserId: "U-JOIN" });
    await getDb()
      .updateTable("slack_user_sync_state")
      .set({ inactive_at: "2026-08-01T00:00:00.000Z" })
      .where("team_id", "=", "T1")
      .where("slack_user_id", "=", "U-JOIN")
      .execute();
    await sync.handleMemberJoinedChannel({ teamId: "T1", channelId: "C1", slackUserId: "U-JOIN" });

    expect(facade.getUserInfo).toHaveBeenNthCalledWith(1, "U-JOIN", { fresh: true });
    expect(facade.getUserInfo).toHaveBeenNthCalledWith(2, "U-JOIN", { fresh: true });
    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-JOIN")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: null });
  });

  it("reactivates an inactive roster member with a fresh profile lookup", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.listChannelsPage = vi.fn(async () => ({ items: [channel({ id: "C1" })], nextCursor: null }));
    facade.listChannelMembersPage = vi.fn(async () => ({ items: ["U-ROSTER"], nextCursor: null }));
    facade.getUserInfo = vi.fn(async () => user({ slackUserId: "U-ROSTER", name: "roster member" }));
    const { sync } = makeSync(facade);

    await sync.handleMemberJoinedChannel({ teamId: "T1", channelId: "C1", slackUserId: "U-ROSTER" });
    await getDb()
      .updateTable("slack_user_sync_state")
      .set({ inactive_at: "2026-08-01T00:00:00.000Z" })
      .where("team_id", "=", "T1")
      .where("slack_user_id", "=", "U-ROSTER")
      .execute();
    await sync.enqueueSweep({ botToken: "xoxb-t1", teamId: "T1" });

    expect(facade.getUserInfo).toHaveBeenLastCalledWith("U-ROSTER", { fresh: true });
    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-ROSTER")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: null });
  });

  it("observes foreign-team Slack Connect senders without crawling channels", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.getUserInfo = vi.fn(async () =>
      user({ slackUserId: "U-FOREIGN", name: "foreign", profileTeamId: "T2", isStranger: true }),
    );
    const { sync, logger } = makeSync(facade);

    await sync.observeMessage({ teamId: "T2", channelId: "D-FOREIGN", slackUserId: "U-FOREIGN" });

    expect(facade.getUserInfo).toHaveBeenCalledWith("U-FOREIGN", { fresh: true });
    expect(facade.listChannelsPage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventTeamId: "T2" }),
      "Dropped Slack entity event from another team",
    );

    await sync.observeMessage({ teamId: "T2", channelId: "mpdm-foreign", slackUserId: "U-FOREIGN" });
    expect(facade.getUserInfo).toHaveBeenCalledTimes(1);
  });

  it("reuses the pinned facade for inactive observed senders", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.getUserInfo = vi.fn(async () => user({ slackUserId: "U-OBSERVED", name: "observed" }));
    const createFacade = vi.fn(() => facade);
    const { sync } = makeSync(facade, undefined, { createFacade });

    await sync.observeMessage({ channelId: "D-OBSERVED", slackUserId: "U-OBSERVED" });
    await getDb()
      .updateTable("slack_user_sync_state")
      .set({ inactive_at: "2026-08-01T00:00:00.000Z" })
      .where("team_id", "=", "T1")
      .where("slack_user_id", "=", "U-OBSERVED")
      .execute();
    await sync.observeMessage({ channelId: "mpdm-OBSERVED", slackUserId: "U-OBSERVED" });

    expect(createFacade).toHaveBeenCalledOnce();
    expect(facade.getUserInfo).toHaveBeenCalledTimes(2);
  });

  it("reactivates an inactive observed sender with a fresh profile lookup", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.listChannelsPage = vi.fn(async () => ({ items: [channel({ id: "C1" })], nextCursor: null }));
    facade.getUserInfo = vi.fn(async () => user({ slackUserId: "U-OBSERVED", name: "observed" }));
    const { sync } = makeSync(facade);

    await sync.observeMessage({ channelId: "C1", slackUserId: "U-OBSERVED" });
    await getDb()
      .updateTable("slack_user_sync_state")
      .set({ inactive_at: "2026-08-01T00:00:00.000Z" })
      .where("team_id", "=", "T1")
      .where("slack_user_id", "=", "U-OBSERVED")
      .execute();
    await sync.observeMessage({ channelId: "C1", slackUserId: "U-OBSERVED" });

    expect(facade.getUserInfo).toHaveBeenLastCalledWith("U-OBSERVED", { fresh: true });
    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-OBSERVED")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: null });
  });

  it("repairs a pending observed sender with a fresh profile lookup", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.listChannelsPage = vi.fn(async () => ({ items: [channel({ id: "C-PENDING" })], nextCursor: null }));
    facade.getUserInfo = vi.fn(async () => user({ slackUserId: "U-PENDING", name: "pending repair" }));
    await getDb()
      .insertInto("slack_user_sync_state")
      .values({
        team_id: "T1",
        slack_user_id: "U-PENDING",
        name: null,
        real_name: null,
        display_name: null,
        email: null,
        profile_team_id: null,
        profile_json: JSON.stringify({ status: "pending", reason: "users.info_cap" }),
        is_bot: 0,
        is_guest: 0,
        is_stranger: 0,
        is_restricted: 0,
        is_ultra_restricted: 0,
        deleted: 0,
        classification: null,
        classification_source: null,
        provider_updated_at: null,
        fetched_at: "2026-08-01T00:00:00.000Z",
        entity_id: null,
        inactive_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      })
      .execute();
    const { sync } = makeSync(facade);

    await sync.observeMessage({ channelId: "C-PENDING", slackUserId: "U-PENDING" });

    expect(facade.getUserInfo).toHaveBeenCalledWith("U-PENDING", { fresh: true });
    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("profile_json")
        .where("slack_user_id", "=", "U-PENDING")
        .executeTakeFirstOrThrow(),
    ).resolves.not.toMatchObject({ profile_json: JSON.stringify({ status: "pending", reason: "users.info_cap" }) });
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
    expect(run.error).toBeNull();
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
    expect(run.error).toBeNull();
    expect(facade.listChannelMembersPage).not.toHaveBeenCalled();
  });

  it("caps users.info lookups and lets the durable repair sweep consume overflow", async () => {
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
    ).resolves.toMatchObject({ profile_json: null });
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

  it("queues a bot-join roster refresh behind an in-flight team run", async () => {
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
    facade.listChannelMembersPage = vi.fn(async () => ({ items: [], nextCursor: null }));
    const { sync } = makeSync(facade);
    const active = { botToken: "xoxb-t1", teamId: "T1" };

    const run = sync.enqueueBackfill(active);
    const join = sync.handleBotJoinedChannel({ teamId: "T1", channelId: "C1" });
    await vi.waitFor(() => expect(facade.listUsersPage).toHaveBeenCalledOnce());
    expect(facade.listChannelMembersPage).not.toHaveBeenCalled();
    release();
    await Promise.all([run, join]);

    expect(facade.listChannelMembersPage).toHaveBeenCalledWith("C1", undefined);
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

  it("drains the oldest queued run when backfill and sweep enqueue concurrently", async () => {
    await createDb();
    const stale = new Date(Date.now() - 60_000).toISOString();
    await getDb()
      .insertInto("slack_sync_runs")
      .values({
        id: "queued-sweep",
        team_id: "T1",
        run_type: "sweep",
        trigger_key: "sweep",
        pinned_team_id: "T1",
        status: "queued",
        stage: "users",
        heartbeat_at: null,
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
    const { sync } = makeSync(emptyFacade());

    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    const runs = await getDb()
      .selectFrom("slack_sync_runs")
      .select(["run_type", "status"])
      .orderBy("created_at", "asc")
      .execute();
    expect(runs).toEqual([
      { run_type: "sweep", status: "completed" },
      { run_type: "backfill", status: "completed" },
      { run_type: "sweep", status: "completed" },
    ]);
  });

  it("does not claim a queued run while another team run has a live heartbeat", async () => {
    await createDb();
    const live = new Date().toISOString();
    await getDb()
      .insertInto("slack_sync_runs")
      .values({
        id: "live-run",
        team_id: "T1",
        run_type: "sweep",
        trigger_key: "live-sweep",
        pinned_team_id: "T1",
        status: "running",
        stage: "users",
        heartbeat_at: live,
        users_cursor: null,
        conversations_cursor: null,
        members_cursor: null,
        current_channel_id: null,
        started_at: live,
        completed_at: null,
        error: null,
        created_at: live,
        updated_at: live,
      })
      .execute();
    const facade = emptyFacade();
    const { sync } = makeSync(facade);

    await sync.enqueueBackfill({ botToken: "xoxb-t1", teamId: "T1" });

    expect(facade.listUsersPage).not.toHaveBeenCalled();
    await expect(
      getDb()
        .selectFrom("slack_sync_runs")
        .select(["run_type", "status"])
        .where("run_type", "=", "backfill")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ run_type: "backfill", status: "queued" });
  });

  it("prioritizes users.info spillover before known roster members on later sweeps", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({
        items: [channel({ id: "C1" }), channel({ id: "C2" })],
        nextCursor: null,
      })),
      listChannelMembersPage: vi.fn(async (channelId: string) => ({
        items: [channelId === "C1" ? "U-KNOWN" : "U-SPILLOVER"],
        nextCursor: null,
      })),
      getUserInfo: vi.fn(async (slackUserId: string) => user({ slackUserId, name: slackUserId })),
    };
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const { sync } = makeSync(facade, active, { userInfoCap: 1 });

    await sync.enqueueSweep(active);
    await sync.enqueueSweep(active);

    expect(facade.getUserInfo).toHaveBeenCalledWith("U-SPILLOVER", { fresh: true });
    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("profile_json")
        .where("slack_user_id", "=", "U-SPILLOVER")
        .executeTakeFirstOrThrow(),
    ).resolves.not.toMatchObject({ profile_json: JSON.stringify({ status: "pending", reason: "users.info_cap" }) });
  });

  it("does not tombstone externals when a configured-disabled channel is skipped", async () => {
    await createDb();
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({ items: [channel({ id: "C-PUBLIC" })], nextCursor: null })),
      listChannelMembersPage: vi.fn(async () => ({ items: ["U-EXTERNAL"], nextCursor: null })),
      getUserInfo: vi.fn(async () =>
        user({ slackUserId: "U-EXTERNAL", name: "external", isStranger: true, profileTeamId: "T2" }),
      ),
    };
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const { sync } = makeSync(facade, active, { publicChannelsEnabled: true });
    await sync.enqueueBackfill(active);

    const disabledSync = makeSync(facade, active, { publicChannelsEnabled: false }).sync;
    await disabledSync.enqueueSweep(active);

    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-EXTERNAL")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: null });
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
    await sync.enqueueSweep(active);

    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-EXTERNAL")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: expect.any(String) });
  });

  it("does not tombstone an external when one of its participant channels was not crawled", async () => {
    await createDb();
    let failChannel = false;
    const facade: SlackEntitySyncFacade = {
      listUsersPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listChannelsPage: vi.fn(async () => ({
        items: [channel({ id: "C1" }), channel({ id: "C2" })],
        nextCursor: null,
      })),
      listChannelMembersPage: vi.fn(async (channelId: string) => {
        if (failChannel && channelId === "C2") throw providerError("channel_not_found");
        return { items: ["U-EXTERNAL"], nextCursor: null };
      }),
      getUserInfo: vi.fn(async () =>
        user({ slackUserId: "U-EXTERNAL", name: "external", isStranger: true, profileTeamId: "T2" }),
      ),
    };
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const { sync } = makeSync(facade, active);

    await sync.enqueueBackfill(active);
    failChannel = true;
    await sync.enqueueSweep(active);

    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-EXTERNAL")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: null });
  });

  it("tombstones an external after a clean member leave without fixture rows", async () => {
    await createDb();
    const facade = emptyFacade();
    facade.getUserInfo = vi.fn(async () =>
      user({ slackUserId: "U-LEAVER", name: "leaver", isStranger: true, profileTeamId: "T2" }),
    );
    const { sync } = makeSync(facade);

    await sync.handleMemberJoinedChannel({ teamId: "T1", channelId: "C1", slackUserId: "U-LEAVER" });
    await sync.handleMemberLeftChannel({ teamId: "T1", channelId: "C1", slackUserId: "U-LEAVER" });

    await expect(
      getDb()
        .selectFrom("slack_user_sync_state")
        .select("inactive_at")
        .where("slack_user_id", "=", "U-LEAVER")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ inactive_at: expect.any(String) });
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
      expect(sweep.error).toBeNull();
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

  it("backs off scheduled retries for failed runs", async () => {
    vi.useFakeTimers();
    await createDb();
    const facade = emptyFacade();
    facade.listUsersPage = vi.fn(async () => {
      throw providerError("unavailable");
    });
    const active = { botToken: "xoxb-t1", teamId: "T1" };
    const { sync } = makeSync(facade, active, { sweepIntervalMs: 1 });

    await sync.enqueueBackfill(active);
    const failed = await getDb()
      .selectFrom("slack_sync_runs")
      .select("error")
      .where("run_type", "=", "backfill")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(failed.error ?? "{}")).toMatchObject({ retryCount: 1 });
    expect(facade.listUsersPage).toHaveBeenCalledOnce();

    await sync.enqueueScheduledSweep(active);
    expect(facade.listUsersPage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    await sync.enqueueScheduledSweep(active);
    expect(facade.listUsersPage).toHaveBeenCalledTimes(2);
    const retried = await getDb()
      .selectFrom("slack_sync_runs")
      .select("error")
      .where("run_type", "=", "backfill")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(retried.error ?? "{}")).toMatchObject({ retryCount: 2 });
  });
});
