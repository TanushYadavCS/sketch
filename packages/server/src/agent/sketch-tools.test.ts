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
  handleSendMessageToUser,
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
    created_at: "2024-01-01T00:00:00.000Z",
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
      userRepo: {
        list: async () => [alice, bob],
        findById: async () => undefined,
      },
      currentUserId: "user-alice",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "user-bob", name: "Bob" });
  });

  it("returns channels from the recipient's connected accounts", async () => {
    const user = makeUser({ id: "user-bob", slack_user_id: "S999", whatsapp_number: "+1234567890" });
    const result = await handleGetTeamDirectory({
      userRepo: {
        list: async () => [user],
        findById: async () => undefined,
      },
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
        inboxMessagesRepo: { create: createInboxMessage, listPendingForRecipient: vi.fn(), markConsumed: vi.fn() },
        userRepo: { list: async () => [], findById: async (id) => (id === "user-bob" ? bob : undefined) },
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
        inboxMessagesRepo: { create: vi.fn(), listPendingForRecipient: vi.fn(), markConsumed: vi.fn() },
        userRepo: { list: async () => [], findById: async () => undefined },
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
        inboxMessagesRepo: { create: vi.fn(), listPendingForRecipient: vi.fn(), markConsumed: vi.fn() },
        userRepo: { list: async () => [], findById: async () => undefined },
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
        inboxMessagesRepo: { create: vi.fn(), listPendingForRecipient: vi.fn(), markConsumed: vi.fn() },
        userRepo: { list: async () => [], findById: async (id) => (id === "user-charlie" ? charlie : undefined) },
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
