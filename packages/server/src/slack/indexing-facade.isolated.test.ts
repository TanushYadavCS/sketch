import { describe, expect, it, vi } from "vitest";
import { type SlackIndexingUser, createSlackIndexingFacade } from "./indexing-facade";

function user(overrides: Partial<SlackIndexingUser> = {}): SlackIndexingUser {
  return {
    slackUserId: "U1",
    name: "alice",
    realName: "Alice Example",
    displayName: "Alice",
    email: "alice@example.com",
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
