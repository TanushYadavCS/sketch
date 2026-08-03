import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAgentParams } from "../agent/runner";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { SlackBot } from "../slack/bot";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppSocketFacade } from "../whatsapp/facade-contract";

const API_KEY = "sk_live_test_key";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionMessages: vi
    .fn()
    .mockResolvedValue([{ type: "assistant", uuid: "msg-1", session_id: "sess-1", message: {} }]),
}));

async function readSse(res: Response) {
  return res.text();
}

function sseData(text: string, event: string) {
  const block = text.split("\n\n").find((entry) => entry.split("\n").some((line) => line === `event: ${event}`));
  if (!block) return undefined;
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return data ? JSON.parse(data) : undefined;
}

function makeAgentResult(overrides: Record<string, unknown> = {}) {
  return {
    messageSent: true,
    sessionId: "sess-1",
    costUsd: 0.01,
    pendingUploads: [],
    pendingIntegrationConnections: [],
    trace: { progressEvents: [], finalText: "agent response" },
    rawUsage: {
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      durationMs: 0,
      durationApiMs: 0,
      numTurns: 0,
      stopReason: null,
      errorSubtype: null,
      isResumedSession: false,
      totalAttachments: 0,
      imageCount: 0,
      nonImageCount: 0,
      mimeTypes: [],
      fileSizes: [],
      promptMode: "text" as const,
      toolCalls: [],
      sdkCostUsd: 0.01,
    },
    ...overrides,
  };
}

async function seedTenant(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword("testpassword123");
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString(), sketchApiKey: API_KEY });
  await users.create({
    name: "Admin",
    email: "admin@test.com",
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
    slackUserId: "SADMIN",
  });
  const requester = await users.create({
    name: "Requester",
    email: "requester@test.com",
    emailVerified: true,
    slackUserId: "SREQ",
    whatsappNumber: "+15550001111",
  });
  const target = await users.create({
    name: "Target",
    email: "target@test.com",
    emailVerified: true,
    slackUserId: "STARGET",
  });
  return { requester, target };
}

async function createSessionCookie(db: Kysely<DB>, userId: string, role: "admin" | "member" = "member") {
  const settings = await createSettingsRepository(db).get();
  if (!settings?.jwt_secret) throw new Error("Missing jwt_secret");
  const token = await signJwt(userId, role, settings.jwt_secret);
  return `sketch_session=${token}`;
}

describe("agent invoke API", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-agent-runs-"));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("allows API-key callers to list safe user records", async () => {
    await seedTenant(db);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger: createTestLogger() });

    const res = await app.request("/api/users", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.users[0].password_hash).toBeUndefined();
    expect(body.users[0].slack_user_id).toBeUndefined();
    expect(typeof body.users[0].hasSlackIdentity).toBe("boolean");
  });

  it("allows API-key callers to discover Slack channels and WhatsApp groups", async () => {
    await seedTenant(db);
    await db
      .insertInto("whatsapp_groups")
      .values({ jid: "123@g.us", name: "Ops", description: "Ops group", updated_at: new Date().toISOString() })
      .execute();
    const slack = {
      listChannels: vi
        .fn()
        .mockResolvedValue([{ id: "C123", name: "general", type: "public_channel", isMember: true }]),
    } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
    });

    const slackRes = await app.request("/api/channels/slack", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(slackRes.status).toBe(200);
    await expect(slackRes.json()).resolves.toEqual({
      channels: [{ id: "C123", name: "general", type: "public_channel", isMember: true }],
    });

    const groupsRes = await app.request("/api/channels/whatsapp/groups", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(groupsRes.status).toBe(200);
    const body = await groupsRes.json();
    expect(body.groups[0].jid).toBe("123@g.us");
  });

  it("rejects invoke requests without the Sketch API key", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "hello",
        target: { type: "user", userId: target.id },
      }),
    });
    expect(res.status).toBe(401);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects invoke requests authenticated only by a local session cookie", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
    });
    const cookie = await createSessionCookie(db, requester.id);

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Cookie: cookie },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "hello",
        target: { type: "user", userId: target.id },
      }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Valid Sketch API key required" },
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("streams a target user run in the target user's workspace using requester identity", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockImplementation(async (params: RunAgentParams) => {
      await params.onSessionId?.("sess-1");
      await params.onProgressEvent({ kind: "tool_use", toolName: "Read", input: { file_path: "x" } });
      return makeAgentResult();
    });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "run in target workspace",
        target: { type: "user", userId: target.id },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSse(res);
    expect(sseData(text, "session")).toEqual({ sessionId: "sess-1" });
    expect(sseData(text, "progress")).toEqual({ kind: "tool_use", toolName: "Read", input: { file_path: "x" } });
    const completed = sseData(text, "completed");
    expect(completed.finalText).toBe("agent response");
    expect(completed.displayText).toBe("agent response");
    expect(completed.pendingIntegrationConnections).toEqual([]);
    expect(completed.delivery).toEqual({ mode: "silent", platform: "slack" });

    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.workspaceKey).toBe(target.id);
    expect(call.currentUserId).toBe(requester.id);
    expect(call.sessionMode).toBe("fresh");
    expect(call.persistSession).toBe(false);
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.userMessage).toContain("Requester");
    expect(call.userMessage).toContain("run in target workspace");
    expect(call.taskContext).toEqual({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "STARGET",
      createdBy: requester.id,
      canManageAnyTask: false,
      creatorTimezone: null,
    });
  });

  it("resumes an explicit API sessionId without persisting it to workspace chat state", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        sessionId: "external-session-1",
        message: "resume target workspace",
        target: { type: "user", userId: target.id },
      }),
    });
    expect(res.status).toBe(200);
    await readSse(res);

    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.sessionMode).toBe("persistent");
    expect(call.persistSession).toBe(false);
    expect(call.resumeSessionId).toBe("external-session-1");
  });

  it("delivers a target user run to Slack DM when deliveryMode is target", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const sendDm = vi
      .fn()
      .mockResolvedValueOnce({ channelId: "D123", messageRef: "request-ts" })
      .mockResolvedValueOnce({ channelId: "D123", messageRef: "response-ts" });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      sendDm,
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "run in target workspace",
        target: { type: "user", userId: target.id, platform: "slack" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    expect(completed.delivery).toEqual({
      mode: "target",
      platform: "slack",
      request: { channelId: "D123", messageRef: "request-ts" },
      response: { channelId: "D123", messageRef: "response-ts" },
    });
    expect(sendDm).toHaveBeenNthCalledWith(1, {
      userId: target.id,
      platform: "slack",
      message: "run in target workspace",
    });
    expect(sendDm).toHaveBeenNthCalledWith(2, {
      userId: target.id,
      platform: "slack",
      message: "agent response",
    });
  });

  it("appends an integration connection link to delivered target user runs", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(
      makeAgentResult({
        trace: { progressEvents: [], finalText: "GitHub needs connection" },
        pendingIntegrationConnections: [
          {
            requestId: "req-1",
            appId: "github",
            appName: "GitHub",
            state: "connect",
            connectUrl: "https://canvas.example.com/connect/secrets?token=github",
          },
        ],
      }),
    );
    const sendDm = vi
      .fn()
      .mockResolvedValueOnce({ channelId: "D123", messageRef: "request-ts" })
      .mockResolvedValueOnce({ channelId: "D123", messageRef: "response-ts" });
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, BASE_URL: "https://sketch.test" }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      sendDm,
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "run in target workspace",
        target: { type: "user", userId: target.id, platform: "slack" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    expect(completed.finalText).toBe("GitHub needs connection");
    expect(completed.displayText).toBe(
      "GitHub needs connection\n\nTo continue: <https://sketch.test/integrations?connect=github|Connect GitHub>",
    );
    expect(completed.pendingIntegrationConnections).toMatchObject([{ appId: "github", state: "connect" }]);

    expect(sendDm).toHaveBeenNthCalledWith(2, {
      userId: target.id,
      platform: "slack",
      message:
        "GitHub needs connection\n\nTo continue: <https://sketch.test/integrations?connect=github|Connect GitHub>",
    });
  });

  it("exposes display text and connection cards for silent runs", async () => {
    const { requester, target } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(
      makeAgentResult({
        trace: { progressEvents: [], finalText: "GitHub needs connection" },
        pendingIntegrationConnections: [
          {
            requestId: "req-1",
            appId: "github",
            appName: "GitHub",
            state: "connect",
          },
        ],
      }),
    );
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, BASE_URL: "https://sketch.test" }), {
      logger: createTestLogger(),
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "run in target workspace",
        target: { type: "user", userId: target.id, platform: "slack" },
      }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");

    expect(completed.finalText).toBe("GitHub needs connection");
    expect(completed.displayText).toBe(
      "GitHub needs connection\n\nTo continue: <https://sketch.test/integrations?connect=github|Connect GitHub>",
    );
    expect(completed.pendingIntegrationConnections).toMatchObject([{ appId: "github", state: "connect" }]);
  });

  it("creates a Slack thread when no threadId is provided", async () => {
    const { requester } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const slack = {
      getChannelInfo: vi.fn().mockResolvedValue({ name: "general", type: "public_channel" }),
      getChannelHistory: vi.fn().mockResolvedValue([]),
      getThreadReplies: vi.fn().mockResolvedValue([]),
      postMessage: vi.fn().mockResolvedValue("1712345678.000000"),
      postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
      uploadFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "start channel run",
        target: { type: "slack_channel", channelId: "C123" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    expect(completed.delivery.threadId).toBe("1712345678.000000");

    expect(slack.postMessage).toHaveBeenCalledWith("C123", "start channel run");
    expect(slack.postThreadReply).toHaveBeenCalledWith("C123", "1712345678.000000", "agent response");
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.workspaceKey).toBe("channel-C123");
    expect(call.threadTs).toBe("1712345678.000000");
  });

  it("appends an integration connection link to delivered Slack channel runs", async () => {
    const { requester } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(
      makeAgentResult({
        trace: { progressEvents: [], finalText: "GitHub needs connection" },
        pendingIntegrationConnections: [
          {
            requestId: "req-1",
            appId: "github",
            appName: "GitHub",
            state: "connect",
            connectUrl: "https://canvas.example.com/connect/secrets?token=github",
          },
        ],
      }),
    );
    const slack = {
      getChannelInfo: vi.fn().mockResolvedValue({ name: "general", type: "public_channel" }),
      getChannelHistory: vi.fn().mockResolvedValue([]),
      getThreadReplies: vi.fn().mockResolvedValue([]),
      postMessage: vi.fn().mockResolvedValue("1712345678.000000"),
      postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
      uploadFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, BASE_URL: "https://sketch.test" }), {
      logger: createTestLogger(),
      getSlack: () => slack,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "start channel run",
        target: { type: "slack_channel", channelId: "C123" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    await readSse(res);

    expect(slack.postThreadReply).toHaveBeenCalledWith(
      "C123",
      "1712345678.000000",
      "GitHub needs connection\n\nTo continue: <https://sketch.test/integrations?connect=github|Connect GitHub>",
    );
  });

  it("reuses a provided Slack threadId", async () => {
    const { requester } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const slack = {
      getChannelInfo: vi.fn().mockResolvedValue({ name: "general", type: "public_channel" }),
      getChannelHistory: vi.fn().mockResolvedValue([]),
      getThreadReplies: vi.fn().mockResolvedValue([]),
      postMessage: vi.fn().mockResolvedValue("new-thread"),
      postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
      uploadFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "continue channel run",
        target: { type: "slack_channel", channelId: "C123", threadId: "111.222" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    await readSse(res);
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.postThreadReply).toHaveBeenCalledWith("C123", "111.222", "continue channel run");
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.threadTs).toBe("111.222");
  });

  it("invokes the agent for a WhatsApp group", async () => {
    const { requester } = await seedTenant(db);
    await db
      .insertInto("whatsapp_groups")
      .values({ jid: "123@g.us", name: "Ops", description: null, updated_at: new Date().toISOString() })
      .execute();
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const whatsapp = {
      pairing: { status: vi.fn().mockResolvedValue({ connected: true, phoneNumber: "+15550001111" }) },
      send: vi.fn().mockResolvedValue(null),
      groupMetadata: vi.fn().mockResolvedValue({ subject: "Ops" }),
    } as unknown as WhatsAppSocketFacade;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      whatsapp,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "group run",
        target: { type: "whatsapp_group", groupJid: "123@g.us" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    await readSse(res);
    expect(whatsapp.send).toHaveBeenCalledWith(
      "123@g.us",
      { kind: "text", text: "group run" },
      { idempotencyKey: expect.any(String) },
    );
    expect(whatsapp.send).toHaveBeenCalledWith(
      "123@g.us",
      { kind: "text", text: "agent response" },
      { idempotencyKey: expect.any(String) },
    );
    const call = runAgent.mock.calls[0][0] as RunAgentParams;
    expect(call.workspaceKey).toBe("wa-group-123@g.us");
    expect(call.platform).toBe("whatsapp");
  });

  it("appends an integration connection link to delivered WhatsApp group runs", async () => {
    const { requester } = await seedTenant(db);
    await db
      .insertInto("whatsapp_groups")
      .values({ jid: "123@g.us", name: "Ops", description: null, updated_at: new Date().toISOString() })
      .execute();
    const runAgent = vi.fn().mockResolvedValue(
      makeAgentResult({
        trace: { progressEvents: [], finalText: "GitHub needs connection" },
        pendingIntegrationConnections: [
          {
            requestId: "req-1",
            appId: "github",
            appName: "GitHub",
            state: "connect",
            connectUrl: "https://canvas.example.com/connect/secrets?token=github",
          },
        ],
      }),
    );
    const whatsapp = {
      pairing: { status: vi.fn().mockResolvedValue({ connected: true, phoneNumber: "+15550001111" }) },
      send: vi.fn().mockResolvedValue(null),
      groupMetadata: vi.fn().mockResolvedValue({ subject: "Ops" }),
    } as unknown as WhatsAppSocketFacade;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir, BASE_URL: "https://sketch.test" }), {
      logger: createTestLogger(),
      whatsapp,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "group run",
        target: { type: "whatsapp_group", groupJid: "123@g.us" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    await readSse(res);

    expect(whatsapp.send).toHaveBeenCalledWith(
      "123@g.us",
      {
        kind: "text",
        text: "GitHub needs connection\n\nTo continue, connect GitHub: https://sketch.test/integrations?connect=github",
      },
      { idempotencyKey: expect.any(String) },
    );
  });

  it("rejects WhatsApp group runs for groups that were not discovered", async () => {
    const { requester } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const whatsapp = {
      pairing: { status: vi.fn().mockResolvedValue({ connected: true, phoneNumber: "+15550001111" }) },
      send: vi.fn().mockResolvedValue(null),
      groupMetadata: vi.fn().mockResolvedValue({ subject: "Outside" }),
    } as unknown as WhatsAppSocketFacade;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      whatsapp,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "group run",
        target: { type: "whatsapp_group", groupJid: "../../outside@g.us" },
        deliveryMode: "target",
      }),
    });
    expect(res.status).toBe(200);
    const error = sseData(await readSse(res), "error");
    expect(error).toEqual({ error: { code: "TARGET_NOT_FOUND", message: "WhatsApp group not found" } });
    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(whatsapp.groupMetadata).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not deliver Slack channel messages in silent mode", async () => {
    const { requester } = await seedTenant(db);
    const runAgent = vi.fn().mockResolvedValue(makeAgentResult());
    const slack = {
      getChannelInfo: vi.fn().mockResolvedValue({ name: "general", type: "public_channel" }),
      getChannelHistory: vi.fn().mockResolvedValue([]),
      postMessage: vi.fn().mockResolvedValue("1712345678.000000"),
      postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
      uploadFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as SlackBot;
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      getSlack: () => slack,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "silent channel run",
        target: { type: "slack_channel", channelId: "C123" },
      }),
    });
    expect(res.status).toBe(200);
    const completed = sseData(await readSse(res), "completed");
    expect(completed.delivery).toEqual({ mode: "silent", platform: "slack" });
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.postThreadReply).not.toHaveBeenCalled();
  });

  it("allows API-key callers to read session transcript messages by sessionId", async () => {
    await seedTenant(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "sdk", session_id: "sess-1" })
      .execute();
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });

    const res = await app.request("/api/agent-sessions/sess-1/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      version: 1,
      runtime: "sdk",
      sessionId: "sess-1",
      messages: [{ type: "assistant", uuid: "msg-1", session_id: "sess-1", message: {} }],
    });
  });

  it("returns an empty message list for an existing SDK session with no replayable messages", async () => {
    await seedTenant(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "sdk", session_id: "sess-empty" })
      .execute();
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(getSessionMessages).mockResolvedValueOnce([]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });

    const res = await app.request("/api/agent-sessions/sess-empty/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      version: 1,
      runtime: "sdk",
      sessionId: "sess-empty",
      messages: [],
    });
  });

  it("logs SDK transcript read failures and returns a retryable server error", async () => {
    await seedTenant(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "sdk", session_id: "sess-fails" })
      .execute();
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(getSessionMessages).mockRejectedValueOnce(new Error("disk read failed"));
    const logger = createTestLogger();
    const warnSpy = vi.spyOn(logger, "warn");
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), { logger });

    const res = await app.request("/api/agent-sessions/sess-fails/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: { code: "SESSION_READ_FAILED", message: "Failed to read session messages" },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), sessionId: "sess-fails", runtime: "sdk" }),
      "Failed to read Claude SDK session transcript",
    );
  });

  it("falls back to Claude Agent SDK for session ids missing from chat_sessions", async () => {
    await seedTenant(db);
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: "assistant",
        uuid: "msg-external",
        session_id: "external-session-1",
        parent_tool_use_id: null,
        message: {},
      },
    ]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });

    const res = await app.request("/api/agent-sessions/external-session-1/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      version: 1,
      runtime: "sdk",
      sessionId: "external-session-1",
      messages: [
        {
          type: "assistant",
          uuid: "msg-external",
          session_id: "external-session-1",
          parent_tool_use_id: null,
          message: {},
        },
      ],
    });
  });

  it("returns not found when neither chat_sessions nor Claude Agent SDK can resolve a session id", async () => {
    await seedTenant(db);
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(getSessionMessages).mockResolvedValueOnce([]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });

    const res = await app.request("/api/agent-sessions/missing-session/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
    });
  });

  it("reads AI SDK transcript messages from agent_messages", async () => {
    await seedTenant(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
      .execute();
    await createAgentMessagesRepository(db).appendBatch([
      { sessionId: "sess-ai", seq: 1, role: "user", content: { role: "user", content: "hello" } },
      { sessionId: "sess-ai", seq: 2, role: "assistant", content: { role: "assistant", content: "hi" } },
    ]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });

    const res = await app.request("/api/agent-sessions/sess-ai/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      version: 1,
      runtime: "aisdk",
      sessionId: "sess-ai",
      messages: [
        { seq: 1, role: "user", content: { role: "user", content: "hello" } },
        { seq: 2, role: "assistant", content: { role: "assistant", content: "hi" } },
      ],
    });
    expect(body.messages[0].createdAt).toEqual(expect.any(String));
  });

  it("treats AI SDK transcript reads as API-key-only admin reads across workspaces", async () => {
    await seedTenant(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-other-workspace", thread_key: "", runtime: "aisdk", session_id: "sess-ai-admin" })
      .execute();
    await createAgentMessagesRepository(db).appendBatch([
      { sessionId: "sess-ai-admin", seq: 1, role: "user", content: { role: "user", content: "admin read" } },
    ]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });

    const res = await app.request("/api/agent-sessions/sess-ai-admin/messages", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      version: 1,
      runtime: "aisdk",
      sessionId: "sess-ai-admin",
      messages: [{ seq: 1, role: "user", content: { role: "user", content: "admin read" } }],
    });
  });

  it("rejects transcript requests authenticated only by a local session cookie", async () => {
    const { requester } = await seedTenant(db);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
    });
    const cookie = await createSessionCookie(db, requester.id);

    const res = await app.request("/api/agent-sessions/sess-1/messages", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Valid Sketch API key required" },
    });
  });
});
