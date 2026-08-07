import { describe, expect, it, vi } from "vitest";
import { type SlackIndexingUser, createSlackIndexingFacade } from "./indexing-facade";

function user(overrides: Partial<SlackIndexingUser> = {}): SlackIndexingUser {
  return {
    slackUserId: "U1",
    name: "alice",
    realName: "Alice Example",
    displayName: "Alice",
    email: "alice@example.com",
    phone: null,
    profileTeamId: "T123",
    isBot: false,
    isGuest: false,
    isStranger: false,
    isRestricted: false,
    isUltraRestricted: false,
    deleted: false,
    providerUpdatedAt: "00000000000000000100",
    ...overrides,
  };
}

describe("Slack indexing facade", () => {
  async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
    const values: T[] = [];
    for await (const item of items) values.push(item);
    return values;
  }

  it("paginates users and channel members at Slack's bounded page size", async () => {
    const usersList = vi
      .fn()
      .mockResolvedValueOnce({ members: [user()], response_metadata: { next_cursor: "users-2" } })
      .mockResolvedValueOnce({ members: [user({ slackUserId: "U2", name: "bob" })], response_metadata: {} });
    const members = vi
      .fn()
      .mockResolvedValueOnce({ members: ["U1"], response_metadata: { next_cursor: "members-2" } })
      .mockResolvedValueOnce({ members: ["U2"], response_metadata: {} });
    const client = {
      users: { list: usersList, info: vi.fn() },
      conversations: { list: vi.fn(), members },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-test",
      clientFactory: () => client as never,
    });

    await expect(collect(facade.iterateUsers())).resolves.toHaveLength(2);
    await expect(collect(facade.iterateChannelMembers("C1"))).resolves.toEqual(["U1", "U2"]);
    expect(usersList).toHaveBeenNthCalledWith(1, { limit: 200 });
    expect(members).toHaveBeenNthCalledWith(1, { channel: "C1", limit: 200 });
  });

  it("extracts phone numbers from users.list and users.info", async () => {
    const usersList = vi.fn().mockResolvedValue({
      members: [
        {
          id: "U-LIST-PHONE",
          name: "list-phone",
          real_name: "List Phone",
          team_id: "T123",
          profile: { email: null, phone: "+1 415 555 1234" },
        },
      ],
      response_metadata: {},
    });
    const info = vi.fn().mockResolvedValue({
      user: {
        id: "U-INFO-PHONE",
        name: "info-phone",
        real_name: "Info Phone",
        team_id: "T123",
        profile: { email: null, phone: "+1 212 555 1234" },
      },
    });
    const client = {
      users: { list: usersList, info },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-phone",
      clientFactory: () => client as never,
    });

    await expect(facade.listUsers()).resolves.toMatchObject([
      { slackUserId: "U-LIST-PHONE", phone: "+1 415 555 1234" },
    ]);
    await expect(facade.getUserInfo("U-INFO-PHONE")).resolves.toMatchObject({
      slackUserId: "U-INFO-PHONE",
      phone: "+1 212 555 1234",
    });
  });

  it("treats Slack app users, USLACKBOT, and is_bot users as bots", async () => {
    const usersList = vi.fn().mockResolvedValue({
      members: [
        { id: "U-APP", name: "app", real_name: "App", profile: {}, is_app_user: true },
        { id: "USLACKBOT", name: "slackbot", real_name: "Slackbot", profile: {} },
        { id: "U-BOT", name: "bot", real_name: "Bot", profile: {}, is_bot: true },
      ],
      response_metadata: {},
    });
    const client = {
      users: { list: usersList, info: vi.fn() },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-bot-flags",
      clientFactory: () => client as never,
    });

    await expect(facade.listUsers()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slackUserId: "U-APP", isBot: true }),
        expect.objectContaining({ slackUserId: "USLACKBOT", isBot: true }),
        expect.objectContaining({ slackUserId: "U-BOT", isBot: true }),
      ]),
    );
  });

  it("captures OAuth scopes once from the users.list connection", async () => {
    const onOAuthScopes = vi.fn();
    const usersList = vi
      .fn()
      .mockResolvedValueOnce({
        members: [user()],
        response_metadata: { next_cursor: "users-2", scopes: ["users:read"] },
      })
      .mockResolvedValueOnce({ members: [], response_metadata: { scopes: ["users:read", "users:read.email"] } });
    const client = {
      users: { list: usersList, info: vi.fn() },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-scopes",
      clientFactory: () => client as never,
      onOAuthScopes,
    });

    await expect(collect(facade.iterateUsers())).resolves.toHaveLength(1);

    expect(onOAuthScopes).toHaveBeenCalledOnce();
    expect(onOAuthScopes).toHaveBeenCalledWith(["users:read"]);
  });

  it("captures OAuth scopes on an isolated lifecycle connection", async () => {
    const onOAuthScopes = vi.fn();
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [user()],
          response_metadata: { scopes: ["users:read"] },
        }),
        info: vi.fn(),
      },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-root",
      clientFactory: () => client as never,
      onOAuthScopes,
    });
    const isolated = facade.withToken?.("xoxb-lifecycle", { isolatedLimiter: true });

    await isolated?.listUsersPage?.();

    expect(onOAuthScopes).toHaveBeenCalledOnce();
    expect(onOAuthScopes).toHaveBeenCalledWith(["users:read"]);
  });

  it("keeps observing OAuth scopes until Slack returns metadata", async () => {
    const onOAuthScopes = vi.fn();
    const client = {
      users: {
        list: vi
          .fn()
          .mockResolvedValueOnce({ members: [], response_metadata: undefined })
          .mockResolvedValueOnce({ members: [], response_metadata: { scopes: ["users:read"] } }),
        info: vi.fn(),
      },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-missing-scopes",
      clientFactory: () => client as never,
      onOAuthScopes,
    });

    await facade.listUsersPage?.();
    await facade.listUsersPage?.();

    expect(onOAuthScopes).toHaveBeenCalledOnce();
    expect(onOAuthScopes).toHaveBeenCalledWith(["users:read"]);
  });

  it("deduplicates concurrent users.info calls and serves them from the TTL cache", async () => {
    const info = vi.fn().mockResolvedValue({
      user: {
        id: "U1",
        name: "alice",
        real_name: "Alice Example",
        team_id: "T123",
        profile: { display_name: "Alice", email: "alice@example.com" },
        is_bot: false,
        is_restricted: false,
        is_ultra_restricted: false,
        is_stranger: false,
        deleted: false,
        updated: "00000000000000000100",
      },
    });
    const client = {
      users: { list: vi.fn(), info },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-test",
      clientFactory: () => client as never,
      userInfoCacheTtlMs: 60_000,
    });

    await expect(Promise.all([facade.getUserInfo("U1"), facade.getUserInfo("U1")])).resolves.toMatchObject([
      { providerUpdatedAt: "00000000000000000100" },
      { providerUpdatedAt: "00000000000000000100" },
    ]);
    await facade.getUserInfo("U1");

    expect(info).toHaveBeenCalledOnce();
  });

  it("bypasses the hot-path cache for lifecycle refreshes", async () => {
    const info = vi
      .fn()
      .mockResolvedValueOnce({
        user: {
          id: "U1",
          name: "alice",
          real_name: "Alice Example",
          team_id: "T123",
          profile: { display_name: "Alice", email: "old@example.com" },
          is_bot: false,
          updated: "100",
        },
      })
      .mockResolvedValueOnce({
        user: {
          id: "U1",
          name: "alice",
          real_name: "Alice Example",
          team_id: "T123",
          profile: { display_name: "Alice", email: "new@example.com" },
          is_bot: false,
          updated: "101",
        },
      });
    const client = {
      users: { list: vi.fn(), info },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-fresh",
      clientFactory: () => client as never,
    });

    await expect(facade.getUserInfo("U1")).resolves.toMatchObject({ email: "old@example.com" });
    await expect(facade.getUserInfo("U1", { fresh: true })).resolves.toMatchObject({ email: "new@example.com" });

    expect(info).toHaveBeenCalledTimes(2);
  });

  it("shares the Slack client across facades for the same token", async () => {
    const client = {
      users: { list: vi.fn().mockResolvedValue({ members: [], response_metadata: {} }), info: vi.fn() },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const clientFactory = vi.fn(() => client as never);
    const first = createSlackIndexingFacade({ getBotToken: async () => "xoxb-shared", clientFactory });
    const second = createSlackIndexingFacade({ getBotToken: async () => "xoxb-shared", clientFactory });

    await first.listUsers();
    await second.listUsers();

    expect(clientFactory).toHaveBeenCalledOnce();
    expect(client.users.list).toHaveBeenCalledTimes(2);
  });

  it("evicts a rotated shared token and gives lifecycle work an isolated lane", async () => {
    let token = "xoxb-old";
    const clients = new Map<
      string,
      {
        users: { list: ReturnType<typeof vi.fn> };
        conversations: { list: ReturnType<typeof vi.fn>; members: ReturnType<typeof vi.fn> };
      }
    >();
    const clientFactory = vi.fn((createdToken: string) => {
      const client = {
        users: { list: vi.fn().mockResolvedValue({ members: [], response_metadata: {} }) },
        conversations: { list: vi.fn(), members: vi.fn() },
      };
      clients.set(createdToken, client);
      return client as never;
    });
    const facade = createSlackIndexingFacade({
      getBotToken: async () => token,
      clientFactory,
    });

    await facade.listUsers();
    token = "xoxb-new";
    await facade.listUsers();
    token = "xoxb-old";
    await facade.listUsers();

    expect(clientFactory).toHaveBeenCalledTimes(3);
    const isolated = facade.withToken?.("xoxb-lifecycle", { isolatedLimiter: true });
    await isolated?.listUsers();
    expect(clientFactory).toHaveBeenCalledTimes(4);
    expect(clients.get("xoxb-lifecycle")?.users.list).toHaveBeenCalledOnce();
  });

  it("prefers a display name when Slack omits real_name", async () => {
    const client = {
      users: {
        list: vi.fn(),
        info: vi.fn().mockResolvedValue({
          user: {
            id: "U-DISPLAY",
            name: "legacy.handle",
            team_id: "T123",
            profile: { display_name: "Display Name", email: null },
          },
        }),
      },
      conversations: { list: vi.fn(), members: vi.fn() },
    };
    const facade = createSlackIndexingFacade({
      getBotToken: async () => "xoxb-display",
      clientFactory: () => client as never,
    });

    await expect(facade.getUserInfo("U-DISPLAY")).resolves.toMatchObject({
      name: "legacy.handle",
      realName: "Display Name",
      displayName: "Display Name",
    });
  });
});
