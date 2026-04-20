import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersTable } from "../db/schema";
import {
  UploadCollector,
  createSketchMcpServer,
  handleGetTeamDirectory,
  handleResolveInboxWorkflow,
  handleSearchUsers,
  handleSendMessageToUser,
  handleSendMessageToUsers,
  handleUpdateInboxWorkflow,
} from "./sketch-tools";

function makeUser(overrides: Partial<Selectable<UsersTable>> = {}): Selectable<UsersTable> {
  return {
    id: "user-1",
    name: "Alice",
    email: null,
    email_verified_at: null,
    slack_user_id: "S001",
    whatsapp_number: null,
    description: "Product manager",
    type: "human",
    role: null,
    reports_to: null,
    tool_progress: null,
    reasoning_text: null,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeInboxMessagesRepoMock() {
  return {
    create: vi.fn(),
    listPendingForRecipient: vi.fn(),
    markConsumed: vi.fn(),
    findById: vi.fn(),
    findUnresolvedByRecipientAndKind: vi.fn(),
    updateWorkflow: vi.fn(),
    resolve: vi.fn(),
  };
}

function makeUserRepoMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    list: async () => [],
    findById: async () => undefined,
    findByEmail: async () => undefined,
    findBySlackId: async () => undefined,
    findByExactName: async () => undefined,
    searchByNamePrefix: async () => [],
    searchByNameSubstring: async () => [],
    ...overrides,
  };
}

describe("UploadCollector", () => {
  it("stores file paths via collect()", () => {
    const collector = new UploadCollector();
    collector.collect("/workspace/file1.pdf");
    collector.collect("/workspace/file2.csv");
    expect(collector.drain()).toEqual(["/workspace/file1.pdf", "/workspace/file2.csv"]);
  });

  it("drain() clears the queue", () => {
    const collector = new UploadCollector();
    collector.collect("/workspace/file.txt");
    collector.drain();
    expect(collector.drain()).toEqual([]);
  });
});

describe("createSketchMcpServer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-upload-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a valid MCP server config", () => {
    const collector = new UploadCollector();
    const server = createSketchMcpServer({ uploadCollector: collector, workspaceDir: tmpDir });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("sketch");
    expect(server.instance).toBeDefined();
  });
});

describe("handleGetTeamDirectory", () => {
  it("returns all users except current user", async () => {
    const alice = makeUser({ id: "user-alice", name: "Alice" });
    const bob = makeUser({ id: "user-bob", name: "Bob" });
    const result = await handleGetTeamDirectory({
      userRepo: makeUserRepoMock({
        list: async () => [alice, bob],
        findById: async () => undefined,
      }),
      currentUserId: "user-alice",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "user-bob", name: "Bob" });
  });

  it("returns channels from the recipient's connected accounts", async () => {
    const user = makeUser({ id: "user-bob", slack_user_id: "S999", whatsapp_number: "+1234567890" });
    const result = await handleGetTeamDirectory({
      userRepo: makeUserRepoMock({
        list: async () => [user],
        findById: async () => undefined,
      }),
      currentUserId: "user-alice",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].channels).toEqual(["slack", "whatsapp"]);
  });

  it("returns an error when userRepo is unavailable", async () => {
    const result = await handleGetTeamDirectory({ userRepo: undefined, currentUserId: "user-alice" });
    expect(result.content[0].text).toBe("Team directory not available.");
  });
});

describe("handleSendMessageToUser", () => {
  it("sends a visible DM and stores the same message in inbox", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: "S999" });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    const createInboxMessage = vi.fn().mockResolvedValue({ id: "inbox-1" });

    const result = await handleSendMessageToUser(
      { recipientUserId: "user-bob", message: "Need your latest update." },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage },
        userRepo: makeUserRepoMock({ findById: async (id: string) => (id === "user-bob" ? bob : undefined) }),
        sendDm,
        currentUserId: "user-alice",
      },
    );

    expect(sendDm).toHaveBeenCalledWith({
      userId: "user-bob",
      platform: "slack",
      message: "Need your latest update.",
    });
    expect(createInboxMessage).toHaveBeenCalledWith({
      senderUserId: "user-alice",
      recipientUserId: "user-bob",
      message: "Need your latest update.",
      platform: "slack",
      channelId: "D123",
      messageRef: "1111.0001",
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      inboxMessageId: "inbox-1",
      recipientName: "Bob",
      status: "sent",
    });
  });

  it("rejects sending to self", async () => {
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-alice", message: "hi" },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock(),
        sendDm: vi.fn(),
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toBe("Error: cannot send a message to yourself.");
  });

  it("rejects unknown recipients", async () => {
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-ghost", message: "hi" },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock(),
        sendDm: vi.fn(),
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toBe("Error: user not found.");
  });

  it("rejects recipients with no connected channel", async () => {
    const charlie = makeUser({ id: "user-charlie", name: "Charlie", slack_user_id: null, whatsapp_number: null });
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-charlie", message: "hi" },
      {
        inboxMessagesRepo: makeInboxMessagesRepoMock(),
        userRepo: makeUserRepoMock({ findById: async (id: string) => (id === "user-charlie" ? charlie : undefined) }),
        sendDm: vi.fn(),
        currentUserId: "user-alice",
      },
    );

    expect(result.content[0].text).toContain("no connected channel");
  });

  it("returns an error when messaging deps are missing", async () => {
    const result = await handleSendMessageToUser(
      { recipientUserId: "user-bob", message: "hi" },
      {
        inboxMessagesRepo: undefined,
        userRepo: undefined,
        sendDm: undefined,
        currentUserId: undefined,
      },
    );

    expect(result.content[0].text).toBe("Error: messaging is not available in this context.");
  });
});

describe("handleSearchUsers", () => {
  it("returns ranked matches across Slack ID, email, exact name, prefix, and substring", async () => {
    const alice = makeUser({
      id: "user-alice",
      name: "Alice Johnson",
      email: "alice@acme.com",
      slack_user_id: "U12345",
    });
    const result = await handleSearchUsers(
      { queries: ["<@U12345>", "alice@acme.com", "Alice Johnson", "Alice", "john"] },
      {
        userRepo: makeUserRepoMock({
          findBySlackId: async (slackUserId: string) => (slackUserId === "U12345" ? alice : undefined),
          findByEmail: async (email: string) => (email === "alice@acme.com" ? alice : undefined),
          findByExactName: async (name: string) => (name === "Alice Johnson" ? alice : undefined),
          searchByNamePrefix: async (query: string) => (query === "Alice" ? [alice] : []),
          searchByNameSubstring: async (query: string) => (query === "john" ? [alice] : []),
        }),
        currentUserId: "user-admin",
      },
    );

    expect(JSON.parse(result.content[0].text)).toEqual({
      results: [
        { query: "<@U12345>", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "slack_user_id" })] },
        { query: "alice@acme.com", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "exact_email" })] },
        { query: "Alice Johnson", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "exact_name" })] },
        { query: "Alice", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "prefix_name" })] },
        { query: "john", matches: [expect.objectContaining({ id: "user-alice", matchedBy: "substring_name" })] },
      ],
    });
  });
});

describe("handleSendMessageToUsers", () => {
  it("sends the same message to multiple recipients and reports per-user results", async () => {
    const bob = makeUser({ id: "user-bob", name: "Bob", slack_user_id: "U111" });
    const charlie = makeUser({ id: "user-charlie", name: "Charlie", slack_user_id: null, whatsapp_number: null });
    const sendDm = vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" });
    const createInboxMessage = vi
      .fn()
      .mockResolvedValueOnce({ id: "inbox-1" })
      .mockResolvedValueOnce({ id: "inbox-2" });

    const result = await handleSendMessageToUsers(
      { recipientUserIds: ["user-bob", "user-bob", "user-charlie"], message: "Hello team", storeInInbox: true },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), create: createInboxMessage },
        userRepo: makeUserRepoMock({
          findById: async (id: string) => {
            if (id === "user-bob") return bob;
            if (id === "user-charlie") return charlie;
            return undefined;
          },
        }),
        sendDm,
        currentUserId: "user-admin",
      },
    );

    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual({
      results: [
        {
          recipientUserId: "user-bob",
          recipientName: "Bob",
          status: "sent",
          platform: "slack",
          inboxMessageId: "inbox-1",
        },
        {
          recipientUserId: "user-bob",
          status: "skipped",
          error: "Duplicate recipient in request",
        },
        {
          recipientUserId: "user-charlie",
          recipientName: "Charlie",
          status: "failed",
          error: "Charlie has no connected channel (Slack or WhatsApp).",
        },
      ],
    });
  });
});

describe("handleUpdateInboxWorkflow", () => {
  it("updates explicit inbox workflows for the current user", async () => {
    const findById = vi.fn().mockResolvedValue({
      id: "inbox-1",
      recipient_user_id: "user-alice",
      resolution_mode: "explicit",
      resolved_at: null,
    });
    const updateWorkflow = vi.fn().mockResolvedValue({
      id: "inbox-1",
      metadata: JSON.stringify({ stage: "awaiting_confirmation" }),
    });

    const result = await handleUpdateInboxWorkflow(
      { inboxMessageId: "inbox-1", metadata: { stage: "awaiting_confirmation" } },
      {
        inboxMessagesRepo: { ...makeInboxMessagesRepoMock(), findById, updateWorkflow },
        currentUserId: "user-alice",
      },
    );

    expect(updateWorkflow).toHaveBeenCalledWith("inbox-1", { stage: "awaiting_confirmation" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      inboxMessageId: "inbox-1",
      status: "updated",
      metadata: { stage: "awaiting_confirmation" },
    });
  });
});

describe("handleResolveInboxWorkflow", () => {
  it("resolves explicit inbox workflows for the current user", async () => {
    const resolve = vi.fn().mockResolvedValue({
      id: "inbox-1",
      resolved_at: "2026-04-20T10:00:00.000Z",
    });

    const result = await handleResolveInboxWorkflow(
      { inboxMessageId: "inbox-1" },
      {
        inboxMessagesRepo: {
          ...makeInboxMessagesRepoMock(),
          findById: vi.fn().mockResolvedValue({
            id: "inbox-1",
            recipient_user_id: "user-alice",
            resolution_mode: "explicit",
            resolved_at: null,
          }),
          resolve,
        },
        currentUserId: "user-alice",
      },
    );

    expect(resolve).toHaveBeenCalledWith("inbox-1");
    expect(JSON.parse(result.content[0].text)).toEqual({
      inboxMessageId: "inbox-1",
      status: "resolved",
    });
  });
});
