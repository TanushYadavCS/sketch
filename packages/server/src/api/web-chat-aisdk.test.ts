import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunAgentParams, type RunAgentResult, runAgent } from "../agent/runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import type { AgentRuntimeProvider } from "../agent/runtime/provider";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { webChatRoutes } from "./web-chat";

/**
 * Drives the real web-chat streaming route (POST /) in-process against the AI
 * SDK runtime (runAgentWithAiSdk). The runner is the actual production
 * `runAgent`, forced onto the aisdk path with a mock LanguageModel injected via
 * the `agentRuntimeProvider` seam — no real provider/network calls. Asserts the
 * SSE body carries the model output and that an aisdk session/messages persist.
 */

const CONFIG_OVERRIDE_KEYS = ["DATA_DIR", "CLAUDE_CONFIG_DIR"] as const;

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
        chunks: [{ type: "error", error: new Error("mock provider blew up mid-stream") }],
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

/** SSE parser: pull `data:` frames, JSON-decode all but the [DONE] sentinel. */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => block.slice("data:".length).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("web-chat route on the AI SDK runtime", () => {
  let db: Kysely<DB>;
  let dataDir: string;
  let claudeConfigDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-web-chat-aisdk-data-"));
    claudeConfigDir = await mkdtemp(join(tmpdir(), "sketch-web-chat-aisdk-claude-"));
    const settings = createSettingsRepository(db);
    await settings.create();
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
    await rm(claudeConfigDir, { recursive: true, force: true });
  });

  async function createUser(): Promise<string> {
    const users = createUserRepository(db);
    const user = await users.create({
      name: "Alice",
      email: "alice@example.com",
      emailVerified: true,
      authRole: "member",
    });
    return user.id;
  }

  /**
   * Mounts the real webChatRoutes on a bare Hono app with an auth stub that sets
   * `sub`/`role` (the same context keys the production auth middleware sets), and
   * a runAgent that always forces the aisdk runtime with the injected model.
   */
  function buildApp(model: LanguageModel, userId: string): Hono {
    const config = createTestConfig(
      Object.fromEntries(CONFIG_OVERRIDE_KEYS.map((key) => [key, key === "DATA_DIR" ? dataDir : claudeConfigDir])) as {
        DATA_DIR: string;
        CLAUDE_CONFIG_DIR: string;
      },
    );
    const logger = createTestLogger();
    const users = createUserRepository(db);
    const settings = createSettingsRepository(db);
    const inboxMessagesRepo = createInboxMessagesRepository(db);
    const provider = mockProvider(model);

    const runAgentAisdk = (params: RunAgentParams): Promise<RunAgentResult> =>
      runAgent({ ...params, agentRuntime: "aisdk", agentRuntimeProvider: provider });

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sub", userId);
      c.set("role", "member");
      await next();
    });
    app.route(
      "/api/web-chat",
      webChatRoutes({ db, config, logger, users, settings, inboxMessagesRepo, runAgent: runAgentAisdk }),
    );
    return app;
  }

  async function postMessage(app: Hono, message: string, conversationId = "default"): Promise<string> {
    const res = await app.request(`/api/web-chat?conversationId=${conversationId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    return res.text();
  }

  it("streams the aisdk model output and persists an aisdk session end-to-end", async () => {
    const userId = await createUser();
    const app = buildApp(textModel("hello from the aisdk runtime"), userId);

    const body = await postMessage(app, "say hi");
    const chunks = parseSse(body);

    const deltas = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    expect(deltas).toContain("hello from the aisdk runtime");
    expect(chunks.some((chunk) => chunk.type === "finish")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);

    const session = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "runtime", "session_id"])
      .where("workspace_key", "=", userId)
      .where("thread_key", "=", "default")
      .where("runtime", "=", "aisdk")
      .executeTakeFirst();
    expect(session?.runtime).toBe("aisdk");
    expect(session?.session_id).toBeTruthy();

    const rows = await createAgentMessagesRepository(db).loadBySession(session?.session_id ?? "");
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const assistant = rows.find((row) => row.role === "assistant");
    expect(JSON.stringify(assistant?.content)).toContain("hello from the aisdk runtime");
  });

  it("resumes the persisted aisdk session on a second turn in the same conversation", async () => {
    const userId = await createUser();
    const app = buildApp(textSequenceModel(["first aisdk turn", "second aisdk turn"]), userId);

    const firstBody = await postMessage(app, "first prompt");
    const firstDeltas = parseSse(firstBody)
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    expect(firstDeltas).toContain("first aisdk turn");

    const secondBody = await postMessage(app, "second prompt");
    const secondDeltas = parseSse(secondBody)
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.delta)
      .join("");
    expect(secondDeltas).toContain("second aisdk turn");

    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["session_id"])
      .where("workspace_key", "=", userId)
      .where("thread_key", "=", "default")
      .where("runtime", "=", "aisdk")
      .execute();
    expect(sessions).toHaveLength(1);

    const rows = await createAgentMessagesRepository(db).loadBySession(sessions[0]?.session_id ?? "");
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("archives the old aisdk session when deleting a conversation and resumes only the new session afterward", async () => {
    const userId = await createUser();
    const app = buildApp(textSequenceModel(["first aisdk turn", "second aisdk turn", "third aisdk turn"]), userId);
    const conversationId = "archive-chat";

    await postMessage(app, "first prompt", conversationId);
    const firstSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", userId)
      .where("thread_key", "=", conversationId)
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    const deleteRes = await app.request(`/api/web-chat/conversations/${conversationId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    await postMessage(app, "second prompt", conversationId);
    const secondSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", userId)
      .where("thread_key", "=", conversationId)
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    await postMessage(app, "third prompt", conversationId);
    const activeSession = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", userId)
      .where("thread_key", "=", conversationId)
      .where("runtime", "=", "aisdk")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();

    expect(secondSession.session_id).not.toBe(firstSession.session_id);
    expect(activeSession).toEqual(secondSession);
    const archived = await db
      .selectFrom("chat_sessions")
      .select("archived_at")
      .where("session_id", "=", firstSession.session_id)
      .executeTakeFirstOrThrow();
    expect(archived.archived_at).toEqual(expect.any(String));
    await expect(createAgentMessagesRepository(db).loadBySession(firstSession.session_id)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(secondSession.session_id)).resolves.toHaveLength(4);
  });

  it("rejects an empty message before touching the runtime", async () => {
    const userId = await createUser();
    const runAgentSpy = vi.fn();
    const config = createTestConfig({ DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: claudeConfigDir });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sub", userId);
      c.set("role", "member");
      await next();
    });
    app.route(
      "/api/web-chat",
      webChatRoutes({
        db,
        config,
        logger: createTestLogger(),
        users: createUserRepository(db),
        settings: createSettingsRepository(db),
        inboxMessagesRepo: createInboxMessagesRepository(db),
        runAgent: runAgentSpy as never,
      }),
    );

    const res = await app.request("/api/web-chat?conversationId=default", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("VALIDATION_ERROR");
    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  it("surfaces an aisdk runtime error as an SSE error frame and persists an error assistant message", async () => {
    const userId = await createUser();
    const app = buildApp(errorModel(), userId);

    const body = await postMessage(app, "please fail");
    const chunks = parseSse(body);

    const errorChunk = chunks.find((chunk) => chunk.type === "error");
    expect(errorChunk).toBeTruthy();
    expect(chunks.some((chunk) => chunk.type === "finish")).toBe(true);

    const messagesRes = await app.request("/api/web-chat/messages?conversationId=default");
    expect(messagesRes.status).toBe(200);
    const messages = (await messagesRes.json()) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    };
    const assistant = messages.messages.find((message) => message.role === "assistant");
    expect(assistant).toBeTruthy();
    const assistantText = (assistant?.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    expect(assistantText.length).toBeGreaterThan(0);
  });
});
