/**
 * Surface wiring test for the Slack DM handler on the AI SDK runtime path.
 *
 * Proves the slack-handler surface drives an agent run end-to-end on the aisdk
 * path: a synthetic SlackMessage flows through createConfiguredSlackBot's DM
 * handler into the REAL runAgent (with a mock LanguageModelV2 provider injected
 * through params.agentRuntimeProvider), the run executes on runtime "aisdk", the
 * model output is formatted and posted back to Slack, and the session persists
 * in the DB tagged with runtime "aisdk".
 *
 * Only the SlackBot transport is mocked (to avoid a real Bolt/Socket Mode
 * connection); runAgent, the DB, and the workspace filesystem are real.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams, RunAgentResult } from "../agent/runner";
import { runAgent } from "../agent/runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import type { AgentRuntimeProvider } from "../agent/runtime/provider";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { SlackAdapterDeps } from "./adapter";
import { createConfiguredSlackBot } from "./adapter";
import type { SlackMessage } from "./bot";

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: text },
          { type: "text-end", id: "text-1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(10, 2) },
        ],
      }),
    },
  });
}

function textSequenceModel(texts: readonly string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: texts.map((text, index) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: `text-${index + 1}` },
          { type: "text-delta", id: `text-${index + 1}`, delta: text },
          { type: "text-end", id: `text-${index + 1}` },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(10, 2) },
        ],
      }),
    })),
  });
}

function errorModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: {
      stream: simulateReadableStream({
        chunks: [{ type: "error", error: new Error("model exploded mid-stream") }],
      }),
    },
  });
}

function mockProvider(model: LanguageModel): AgentRuntimeProvider {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    model,
    costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    preparePrompt: (input) => ({
      instructions: input.systemPrompt,
      messages: input.messages ?? [{ role: "user", content: input.prompt }],
    }),
  };
}

/**
 * Mock SlackBot transport captured through vi.mock. The real class builds a
 * Bolt App (Socket Mode) in its constructor, which we must not do in a test.
 */
let mockBotInstance: Record<string, ReturnType<typeof vi.fn>> = {};

function freshMockBot() {
  return {
    onMessage: vi.fn(),
    onChannelMessage: vi.fn(),
    onChannelRenamed: vi.fn(),
    onMemberJoinedChannel: vi.fn(),
    onMemberLeftChannel: vi.fn(),
    onThreadMessage: vi.fn(),
    onChannelMention: vi.fn(),
    onAppHomeOpened: vi.fn(),
    onHomeAction: vi.fn(),
    publishHomeView: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn().mockResolvedValue("posted-ts"),
    postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    getUserInfo: vi.fn().mockResolvedValue({ name: "alice", realName: "Alice", email: "alice@test.com" }),
    getChannelInfo: vi.fn().mockResolvedValue({ name: "general", type: "channel" }),
    getChannelHistory: vi.fn().mockResolvedValue([]),
    getThreadReplies: vi.fn().mockResolvedValue([]),
    uploadFile: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock("./bot", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SlackBot: class MockSlackBot {
      constructor() {
        Object.assign(this, mockBotInstance);
      }
    },
  };
});

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-U1",
    name: "Alice",
    email: "alice@test.com",
    slack_user_id: "S1",
    whatsapp_number: null,
    auth_role: "member",
    type: "human",
    role: null,
    reports_to: null,
    tool_progress: null,
    reasoning_text: null,
    allowed_tools: null,
    timezone: "America/New_York",
    description: null,
    created_at: "2025-01-01",
    ...overrides,
  };
}

function makeConversation() {
  return {
    id: 1,
    platform: "slack",
    kind: "dm",
    provider_conversation_id: "D1",
    display_name: "Alice",
    last_seen_message_id: null,
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
  };
}

function makeConversationsRepo() {
  const conversation = makeConversation();
  return {
    getOrCreate: vi.fn().mockResolvedValue(conversation),
    find: vi.fn().mockResolvedValue(conversation),
    insertMessage: vi.fn().mockImplementation(async (data) => ({
      row: {
        id: data.providerMessageId === "posted-ts" ? 2 : 1,
        conversationId: data.conversationId,
        providerMessageId: data.providerMessageId,
        senderName: data.senderName,
        text: data.text ?? "",
        attachments: data.attachments ?? [],
      },
      inserted: true,
    })),
    listBacklog: vi.fn().mockResolvedValue({ messages: [], hasMore: false, nextCursor: undefined }),
    getCursor: vi.fn().mockResolvedValue(null),
    updateCursor: vi.fn().mockResolvedValue(undefined),
    updateWatermark: vi.fn().mockResolvedValue(conversation),
    advanceWatermarkToCurrentMax: vi.fn().mockResolvedValue(conversation),
    advanceCursorToCurrentMax: vi.fn().mockResolvedValue(undefined),
  };
}

describe("slack DM handler drives runAgent on the AI SDK runtime", () => {
  let db: Kysely<DB>;
  let dataDir: string;
  let claudeConfigDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-slack-aisdk-data-"));
    claudeConfigDir = await mkdtemp(join(tmpdir(), "sketch-slack-aisdk-claude-"));
    mockBotInstance = freshMockBot();
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
    await rm(claudeConfigDir, { recursive: true, force: true });
  });

  /**
   * Wrap the real runAgent so the surface's constructed params run on the aisdk
   * path with an injected mock provider. This is the seam runner.ts exposes;
   * the surface itself never sets agentRuntime, matching production wiring where
   * the runtime + provider are decided by the bootstrap layer.
   */
  function runAgentOnAiSdk(model: LanguageModel) {
    const runs: RunAgentParams[] = [];
    const fn = vi.fn(async (params: RunAgentParams): Promise<RunAgentResult> => {
      runs.push(params);
      return runAgent({
        ...params,
        agentRuntime: "aisdk",
        agentRuntimeProvider: mockProvider(model),
      });
    });
    return { fn, runs };
  }

  function makeDeps(runAgentImpl: (params: RunAgentParams) => Promise<RunAgentResult>): SlackAdapterDeps {
    const conversations = makeConversationsRepo();
    return {
      db,
      config: createTestConfig({ DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeConfigDir, PORT: 0, LOG_LEVEL: "error" }),
      logger: createTestLogger(),
      repos: {
        users: {
          findBySlackId: vi.fn().mockResolvedValue(makeUser()),
          findById: vi.fn().mockImplementation(async (id: string) => makeUser({ id })),
          findByEmail: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
          update: vi
            .fn()
            .mockImplementation(async (id: string, data: Record<string, unknown>) => makeUser({ id, ...data })),
        } as unknown as SlackAdapterDeps["repos"]["users"],
        channels: {
          findBySlackChannelId: vi.fn().mockResolvedValue({
            id: "ch1",
            name: "general",
            slack_channel_id: "C1",
            type: "channel",
            tool_progress: null,
            reasoning_text: null,
            agent_user_id: null,
            created_at: "2025-01-01",
          }),
          findById: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
          update: vi.fn(),
        } as unknown as SlackAdapterDeps["repos"]["channels"],
        settings: {
          get: vi.fn().mockResolvedValue({
            slack_bot_token: "xoxb-test",
            org_name: "TestOrg",
            bot_name: "TestBot",
            org_context: null,
          }),
        } as unknown as SlackAdapterDeps["repos"]["settings"],
        conversations: conversations as unknown as SlackAdapterDeps["repos"]["conversations"],
      },
      queue: new QueueManager(),
      slack: {
        userCache: {
          resolve: vi
            .fn()
            .mockImplementation(async (id: string, fetcher: (uid: string) => Promise<unknown>) => fetcher(id)),
        } as unknown as SlackAdapterDeps["slack"]["userCache"],
      },
      runAgent: runAgentImpl,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      loadIntegrationProvider: vi.fn().mockResolvedValue(null),
      inboxMessagesRepo: {
        listPendingForRecipient: vi.fn().mockResolvedValue([]),
        markConsumed: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
      } as unknown as SlackAdapterDeps["inboxMessagesRepo"],
      sendDm: vi.fn().mockResolvedValue({ channelId: "D1", messageRef: "ref" }),
    };
  }

  function getDmHandler(): (msg: SlackMessage) => Promise<void> {
    return mockBotInstance.onMessage.mock.calls[0]?.[0] as (msg: SlackMessage) => Promise<void>;
  }

  function getMentionHandler(): (msg: SlackMessage) => Promise<void> {
    return mockBotInstance.onChannelMention.mock.calls[0]?.[0] as (msg: SlackMessage) => Promise<void>;
  }

  function dmMessage(overrides: Partial<SlackMessage> = {}): SlackMessage {
    return { text: "hello sketch", userId: "S1", channelId: "D1", ts: "1", type: "dm", ...overrides };
  }

  function mentionMessage(overrides: Partial<SlackMessage> = {}): SlackMessage {
    return {
      text: "hello sketch",
      userId: "S1",
      channelId: "C1",
      ts: "10",
      threadTs: "10",
      type: "channel_mention",
      ...overrides,
    };
  }

  it("runs the agent on aisdk and posts the formatted model reply, persisting the session", async () => {
    const { fn, runs } = runAgentOnAiSdk(textModel("hi from aisdk"));
    const deps = makeDeps(fn);
    createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
    const dm = getDmHandler();

    await dm(dmMessage());
    await vi.waitFor(() => expect(fn).toHaveBeenCalledOnce());

    // Surface handed a real run to the aisdk path with no runtime pre-set.
    expect(runs[0]?.agentRuntime).toBeUndefined();
    expect(runs[0]?.platform).toBe("slack");
    expect(runs[0]?.workspaceKey).toBe("user-U1");
    expect(runs[0]?.userMessage).toContain("hello sketch");

    const result = await fn.mock.results[0]?.value;
    expect(result.trace.finalText).toBe("hi from aisdk");

    // Formatted reply delivered to Slack (top-level DM => postMessage).
    await vi.waitFor(() => expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "hi from aisdk"));

    // Session persisted under the aisdk runtime for this workspace.
    const session = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "runtime", "session_id"])
      .where("workspace_key", "=", "user-U1")
      .where("runtime", "=", "aisdk")
      .executeTakeFirst();
    expect(session).toMatchObject({ workspace_key: "user-U1", runtime: "aisdk", session_id: result.sessionId });

    const rows = await createAgentMessagesRepository(db).loadBySession(result.sessionId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("resumes the same aisdk session on a second DM turn", async () => {
    const first = runAgentOnAiSdk(textModel("turn one"));
    const deps1 = makeDeps(first.fn);
    createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps1);
    const dm1 = getDmHandler();
    await dm1(dmMessage({ text: "first" }));
    await vi.waitFor(() => expect(first.fn).toHaveBeenCalledOnce());
    const turn1 = await first.fn.mock.results[0]?.value;

    mockBotInstance = freshMockBot();
    const second = runAgentOnAiSdk(textModel("turn two"));
    const deps2 = makeDeps(second.fn);
    createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps2);
    const dm2 = getDmHandler();
    await dm2(dmMessage({ text: "second" }));
    await vi.waitFor(() => expect(second.fn).toHaveBeenCalledOnce());
    const turn2 = await second.fn.mock.results[0]?.value;

    expect(turn2.sessionId).toBe(turn1.sessionId);
    expect(turn2.rawUsage.isResumedSession).toBe(true);
    await vi.waitFor(() => expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "turn two"));
  });

  it("archives the old aisdk DM session on /new and resumes only the new session afterward", async () => {
    const { fn } = runAgentOnAiSdk(textSequenceModel(["turn one", "turn two", "turn three"]));
    const deps = makeDeps(fn);
    createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
    const dm = getDmHandler();

    await dm(dmMessage({ text: "first" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    const turn1 = await fn.mock.results[0]?.value;

    await dm(dmMessage({ text: "/new", ts: "2" }));
    await vi.waitFor(() => expect(deps.repos.conversations.advanceWatermarkToCurrentMax).toHaveBeenCalledWith(1));
    expect(fn).toHaveBeenCalledTimes(1);

    await dm(dmMessage({ text: "second", ts: "3" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    const turn2 = await fn.mock.results[1]?.value;

    await dm(dmMessage({ text: "third", ts: "4" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));
    const turn3 = await fn.mock.results[2]?.value;

    expect(turn2.sessionId).not.toBe(turn1.sessionId);
    expect(turn2.rawUsage.isResumedSession).toBe(false);
    expect(turn3.sessionId).toBe(turn2.sessionId);
    expect(turn3.rawUsage.isResumedSession).toBe(true);

    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", "user-U1")
      .where("thread_key", "=", "")
      .where("runtime", "=", "aisdk")
      .orderBy("id", "asc")
      .execute();
    expect(sessions).toEqual([
      { session_id: turn1.sessionId, archived_at: expect.any(String) },
      { session_id: turn2.sessionId, archived_at: null },
    ]);

    await expect(createAgentMessagesRepository(db).loadBySession(turn1.sessionId)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(turn2.sessionId)).resolves.toHaveLength(4);
  });

  it("archives the old aisdk channel-thread session on /new and resumes only the new session afterward", async () => {
    const { fn } = runAgentOnAiSdk(textSequenceModel(["thread one", "thread two", "thread three"]));
    const deps = makeDeps(fn);
    createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
    const mention = getMentionHandler();

    await mention(mentionMessage({ text: "first" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    const turn1 = await fn.mock.results[0]?.value;

    await mention(mentionMessage({ text: "/new", ts: "11" }));
    await vi.waitFor(() => expect(deps.repos.conversations.advanceCursorToCurrentMax).toHaveBeenCalled());
    expect(fn).toHaveBeenCalledTimes(1);

    await mention(mentionMessage({ text: "second", ts: "12" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    const turn2 = await fn.mock.results[1]?.value;

    await mention(mentionMessage({ text: "third", ts: "13" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));
    const turn3 = await fn.mock.results[2]?.value;

    expect(turn2.sessionId).not.toBe(turn1.sessionId);
    expect(turn2.rawUsage.isResumedSession).toBe(false);
    expect(turn3.sessionId).toBe(turn2.sessionId);
    expect(turn3.rawUsage.isResumedSession).toBe(true);

    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", "channel-C1")
      .where("thread_key", "=", "10")
      .where("runtime", "=", "aisdk")
      .orderBy("id", "asc")
      .execute();
    expect(sessions).toEqual([
      { session_id: turn1.sessionId, archived_at: expect.any(String) },
      { session_id: turn2.sessionId, archived_at: null },
    ]);

    await expect(createAgentMessagesRepository(db).loadBySession(turn1.sessionId)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(turn2.sessionId)).resolves.toHaveLength(4);
  });

  it("posts an error reply and clears the shimmer when the aisdk run fails mid-stream", async () => {
    const { fn } = runAgentOnAiSdk(errorModel());
    const deps = makeDeps(fn);
    createConfiguredSlackBot({ botToken: "xoxb-test", appToken: "xapp-test" }, deps);
    const dm = getDmHandler();

    await dm(dmMessage({ text: "cause an error" }));
    await vi.waitFor(() => expect(fn).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(mockBotInstance.postMessage).toHaveBeenCalledWith("D1", "_Something went wrong, try again_"),
    );

    // Shimmer cleared (last assistant-status write blanks the line).
    expect(mockBotInstance.setAssistantStatus).toHaveBeenLastCalledWith("D1", "1", "");
    // The formatted model reply was never posted to Slack.
    expect(mockBotInstance.postMessage).not.toHaveBeenCalledWith("D1", "hi from aisdk");

    // The run failed mid-stream, so no assistant turn was persisted for the
    // session — only the seeded user message (if any) exists, never an assistant row.
    const session = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "runtime"])
      .where("workspace_key", "=", "user-U1")
      .where("runtime", "=", "aisdk")
      .executeTakeFirst();
    if (session) {
      const rows = await createAgentMessagesRepository(db).loadBySession(session.session_id);
      expect(rows.some((row) => row.role === "assistant")).toBe(false);
    }
  });
});
