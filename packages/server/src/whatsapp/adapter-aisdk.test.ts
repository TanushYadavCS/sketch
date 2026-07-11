/**
 * WhatsApp adapter -> real runAgent (aisdk runtime) end-to-end wiring test.
 *
 * Unlike adapter.isolated.test.ts (which mocks deps.runAgent), this test injects
 * the REAL runAgent through the adapter's dependency seam and forces the aisdk
 * runtime path via a fake AgentRuntimeProvider backed by a MockLanguageModelV4.
 * No real provider/network call is made. The goal is to prove the whatsapp-handler
 * surface drives an agent run on the aisdk path and delivers the model's reply.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunAgentParams, runAgent } from "../agent/runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import type { AgentRuntimeProvider } from "../agent/runtime/provider";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import { createConversationRepository } from "../db/repositories/conversations";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import { createWhatsAppGroupRepository } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppAdapterDeps } from "./adapter";
import { wireWhatsAppHandlers } from "./adapter";
import type { WhatsAppDmInboundMessage, WhatsAppGroupInboundMessage, WhatsAppInboundMessage } from "./provider";

const PHONE = "+14155550100";
const JID = "14155550100@s.whatsapp.net";
const GROUP_JID = "group@g.us";

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
        chunks: [{ type: "error", error: new Error("aisdk provider blew up") }],
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
 * Minimal WhatsApp runtime mock that captures the onMessage handler and records
 * outbound calls. All delivery methods are spies so the test can assert on the
 * reply the adapter sends after the real agent run resolves.
 */
function createMockWhatsApp() {
  const handler = { fn: null as ((message: WhatsAppInboundMessage) => Promise<void>) | null };
  const sendText = vi.fn(async (_target: unknown, text: string) => ({
    providerMessageId: "sent-1",
    providerConversationId: JID,
    providerTimestamp: null,
    text,
  }));
  return {
    mock: {
      isConnected: true,
      socket: {},
      onMessage: vi.fn().mockImplementation((fn) => {
        handler.fn = fn;
      }),
      onHistoryMessages: vi.fn(),
      sendText,
      editText: vi.fn(),
      sendFile: vi.fn(),
      sendTemplate: vi.fn(),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      startComposing: vi.fn(),
      stopComposing: vi.fn(),
      downloadMedia: vi.fn().mockResolvedValue([]),
      getGroupMetadata: vi.fn().mockResolvedValue(undefined),
      getGroupName: vi.fn().mockResolvedValue(null),
      resolveJidToPhone: vi.fn().mockResolvedValue(null),
    },
    dispatch: async (message: WhatsAppInboundMessage) => {
      if (!handler.fn) throw new Error("handler not wired");
      await handler.fn(message);
    },
  };
}

function makeDmMessage(overrides: Partial<WhatsAppDmInboundMessage> = {}): WhatsAppDmInboundMessage {
  return {
    kind: "dm",
    providerId: "baileys",
    providerMessageId: "wamid.1",
    providerConversationId: JID,
    canonicalConversationId: `dm:${PHONE}`,
    providerTimestamp: "2026-07-01T00:00:00.000Z",
    senderName: "Alice",
    senderProviderId: JID,
    senderPhoneE164: PHONE,
    target: { kind: "dm", phoneE164: PHONE, providerConversationId: JID },
    text: "hello there",
    rawProviderPayload: { key: { remoteJid: JID, id: "wamid.1", fromMe: false } },
    ...overrides,
  };
}

function makeGroupMessage(overrides: Partial<WhatsAppGroupInboundMessage> = {}): WhatsAppGroupInboundMessage {
  return {
    kind: "group",
    providerId: "baileys",
    providerMessageId: "wamid.group.1",
    providerConversationId: GROUP_JID,
    canonicalConversationId: `group:${GROUP_JID}`,
    providerTimestamp: "2026-07-01T00:00:00.000Z",
    senderName: "Alice",
    senderProviderId: JID,
    senderPhoneE164: PHONE,
    target: { kind: "group", groupId: GROUP_JID },
    text: "hello group",
    isMentioned: true,
    rawProviderPayload: { key: { remoteJid: GROUP_JID, id: "wamid.group.1", fromMe: false } },
    ...overrides,
  };
}

describe("whatsapp adapter -> real runAgent (aisdk runtime)", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-wa-aisdk-"));
    await mkdir(join(dataDir, "workspaces"), { recursive: true });
    const users = createUserRepository(db);
    await users.create({ name: "Alice", whatsappNumber: PHONE, email: "alice@test.com" });
    const settings = createSettingsRepository(db);
    await settings.create({ orgName: "TestOrg", botName: "Sketch" });
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeDeps(model: LanguageModel): WhatsAppAdapterDeps {
    const provider = mockProvider(model);
    return {
      db,
      config: createTestConfig({ DATA_DIR: dataDir, PORT: 0, LOG_LEVEL: "error" }),
      logger: createTestLogger(),
      repos: {
        users: createUserRepository(db),
        settings: createSettingsRepository(db),
        whatsappGroups: createWhatsAppGroupRepository(db),
        conversations: createConversationRepository(db),
      },
      queue: new QueueManager(),
      /**
       * Inject the REAL runAgent but force the aisdk runtime + fake provider so
       * the run executes without any network/provider call.
       */
      runAgent: (params: RunAgentParams) =>
        runAgent({ ...params, agentRuntime: "aisdk", agentRuntimeProvider: provider }),
      buildMcpServers: vi.fn().mockResolvedValue({}),
      loadIntegrationProvider: vi.fn().mockResolvedValue(null),
      sendDm: vi.fn().mockResolvedValue({ channelId: JID, messageRef: "" }),
    };
  }

  it("drives an aisdk agent run for an inbound DM and delivers the model reply", async () => {
    const { mock, dispatch } = createMockWhatsApp();
    const deps = makeDeps(textModel("aisdk reply for whatsapp"));
    wireWhatsAppHandlers(mock as never, deps);

    await dispatch(makeDmMessage({ text: "what is up" }));

    await vi.waitFor(() => {
      expect(mock.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "dm", phoneE164: PHONE }),
        "aisdk reply for whatsapp",
      );
    });

    // The run truly executed on the aisdk path: a chat_sessions row was persisted
    // for the DM workspace key under the aisdk runtime, and messages were stored.
    const session = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "runtime", "session_id"])
      .where("runtime", "=", "aisdk")
      .executeTakeFirst();
    expect(session).toBeDefined();
    expect(session?.runtime).toBe("aisdk");

    const rows = await createAgentMessagesRepository(db).loadBySession(session?.session_id ?? "");
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("resumes the aisdk DM session across two inbound messages", async () => {
    const { mock, dispatch } = createMockWhatsApp();
    const deps = makeDeps(textSequenceModel(["first turn reply", "second turn reply"]));
    wireWhatsAppHandlers(mock as never, deps);

    await dispatch(makeDmMessage({ providerMessageId: "wamid.a", text: "first" }));
    await vi.waitFor(() => expect(mock.sendText).toHaveBeenCalledTimes(1));
    await dispatch(makeDmMessage({ providerMessageId: "wamid.b", text: "second" }));
    await vi.waitFor(() => expect(mock.sendText).toHaveBeenCalledTimes(2));

    expect(mock.sendText).toHaveBeenNthCalledWith(1, expect.anything(), "first turn reply");
    expect(mock.sendText).toHaveBeenNthCalledWith(2, expect.anything(), "second turn reply");

    // A single aisdk session row is reused across both turns.
    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "runtime"])
      .where("runtime", "=", "aisdk")
      .execute();
    expect(sessions).toHaveLength(1);

    const rows = await createAgentMessagesRepository(db).loadBySession(sessions[0].session_id);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("archives the old aisdk DM session on /new and resumes only the new session afterward", async () => {
    const { mock, dispatch } = createMockWhatsApp();
    const deps = makeDeps(textSequenceModel(["first turn reply", "second turn reply", "third turn reply"]));
    wireWhatsAppHandlers(mock as never, deps);

    await dispatch(makeDmMessage({ providerMessageId: "wamid.a", text: "first" }));
    await vi.waitFor(() => expect(mock.sendText).toHaveBeenCalledWith(expect.anything(), "first turn reply"));

    const firstSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    await dispatch(makeDmMessage({ providerMessageId: "wamid.new", text: "/new" }));
    await vi.waitFor(async () => {
      const archived = await db
        .selectFrom("chat_sessions")
        .select("archived_at")
        .where("session_id", "=", firstSession.session_id)
        .executeTakeFirstOrThrow();
      expect(archived.archived_at).toEqual(expect.any(String));
    });

    await dispatch(makeDmMessage({ providerMessageId: "wamid.b", text: "second" }));
    await vi.waitFor(() => expect(mock.sendText).toHaveBeenCalledWith(expect.anything(), "second turn reply"));
    const secondSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    await dispatch(makeDmMessage({ providerMessageId: "wamid.c", text: "third" }));
    await vi.waitFor(() => expect(mock.sendText).toHaveBeenCalledWith(expect.anything(), "third turn reply"));
    const activeSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    expect(secondSession.session_id).not.toBe(firstSession.session_id);
    expect(activeSession).toEqual(secondSession);
    await expect(createAgentMessagesRepository(db).loadBySession(firstSession.session_id)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(secondSession.session_id)).resolves.toHaveLength(4);
  });

  it("archives the old aisdk group session on /new and resumes only the new session afterward", async () => {
    const { mock, dispatch } = createMockWhatsApp();
    const deps = makeDeps(textSequenceModel(["first group reply", "second group reply", "third group reply"]));
    wireWhatsAppHandlers(mock as never, deps);

    await dispatch(makeGroupMessage({ providerMessageId: "wamid.group.a", text: "first" }));
    await vi.waitFor(() =>
      expect(mock.sendText).toHaveBeenCalledWith(expect.objectContaining({ kind: "group" }), "first group reply", {
        quotedMessage: expect.objectContaining({ providerMessageId: "wamid.group.a" }),
      }),
    );

    const firstSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", `wa-group-${GROUP_JID}`)
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    await dispatch(makeGroupMessage({ providerMessageId: "wamid.group.new", text: "/new" }));
    await vi.waitFor(async () => {
      const archived = await db
        .selectFrom("chat_sessions")
        .select("archived_at")
        .where("session_id", "=", firstSession.session_id)
        .executeTakeFirstOrThrow();
      expect(archived.archived_at).toEqual(expect.any(String));
    });

    await dispatch(makeGroupMessage({ providerMessageId: "wamid.group.b", text: "second" }));
    await vi.waitFor(() =>
      expect(mock.sendText).toHaveBeenCalledWith(expect.objectContaining({ kind: "group" }), "second group reply", {
        quotedMessage: expect.objectContaining({ providerMessageId: "wamid.group.b" }),
      }),
    );
    const secondSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", `wa-group-${GROUP_JID}`)
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    await dispatch(makeGroupMessage({ providerMessageId: "wamid.group.c", text: "third" }));
    await vi.waitFor(() =>
      expect(mock.sendText).toHaveBeenCalledWith(expect.objectContaining({ kind: "group" }), "third group reply", {
        quotedMessage: expect.objectContaining({ providerMessageId: "wamid.group.c" }),
      }),
    );
    const activeSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", `wa-group-${GROUP_JID}`)
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    expect(secondSession.session_id).not.toBe(firstSession.session_id);
    expect(activeSession).toEqual(secondSession);
    await expect(createAgentMessagesRepository(db).loadBySession(firstSession.session_id)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(secondSession.session_id)).resolves.toHaveLength(4);
  });

  it("sends the WhatsApp failure reply when the aisdk run errors", async () => {
    const { mock, dispatch } = createMockWhatsApp();
    const deps = makeDeps(errorModel());
    wireWhatsAppHandlers(mock as never, deps);

    await dispatch(makeDmMessage({ text: "trigger failure" }));

    await vi.waitFor(() => {
      expect(mock.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "dm", phoneE164: PHONE }),
        "Something went wrong, try again.",
      );
    });
    // 👀 reaction added then removed; no ✅ on failure.
    expect(mock.addReaction).toHaveBeenCalledWith(expect.anything(), "👀");
    expect(mock.addReaction).not.toHaveBeenCalledWith(expect.anything(), "✅");
  });
});
