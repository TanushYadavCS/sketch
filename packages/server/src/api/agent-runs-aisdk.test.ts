import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunAgentParams, runAgent } from "../agent/runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import type { AgentRuntimeProvider } from "../agent/runtime/provider";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

/**
 * Proves the invoke API surface (POST /api/agent-runs) drives a real agent run
 * end-to-end on the aisdk runtime path. The runtime is exercised for real via
 * runner.ts; only the model provider is faked, injected through the existing
 * runAgent seam so no real Bedrock/OpenRouter/network call happens.
 *
 * The invoke route passes persistSession:false. For a fresh run that means no
 * transcript persistence; for an explicit-sessionId resume the runner persists
 * the transcript anyway (persistTranscript = shouldPersist || resumeSessionId).
 * This test covers both, plus the PR fix: turn-2 of an explicit session sees
 * turn-1 history and agent_messages are written.
 */

const API_KEY = "sk_live_aisdk_invoke_test";

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
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
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: usage(10, 2),
          },
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
 * Real runAgent, but pinned to the aisdk runtime with the injected fake model.
 * This is the seam the orchestrator points us at: it drives the true wiring
 * (invoke route -> runAgent -> aisdk runtime -> response/session/transcript)
 * without touching a provider.
 */
function makeAiSdkRunAgent(model: LanguageModel) {
  return (params: RunAgentParams) =>
    runAgent({
      ...params,
      agentRuntime: "aisdk",
      agentRuntimeProvider: mockProvider(model),
    });
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

async function seedTenant(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await settings.update({ onboardingCompletedAt: new Date().toISOString(), sketchApiKey: API_KEY });
  const requester = await users.create({
    name: "Requester",
    email: "requester@test.com",
    emailVerified: true,
    slackUserId: "SREQ",
  });
  const target = await users.create({
    name: "Target",
    email: "target@test.com",
    emailVerified: true,
    slackUserId: "STARGET",
  });
  return { requester, target };
}

describe("agent invoke API on the aisdk runtime", () => {
  let db: Kysely<DB>;
  let dataDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-agent-runs-aisdk-"));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("drives a fresh aisdk run end-to-end and streams the real model output", async () => {
    const { requester, target } = await seedTenant(db);
    const model = textSequenceModel(["hello from the model"]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(model),
      buildMcpServers: async () => ({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        message: "say hello",
        target: { type: "user", userId: target.id },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    const session = sseData(text, "session");
    expect(session?.sessionId).toEqual(expect.any(String));

    const completed = sseData(text, "completed");
    expect(completed.ok).toBe(true);
    expect(completed.status).toBe("completed");
    expect(completed.finalText).toBe("hello from the model");
    expect(completed.displayText).toBe("hello from the model");
    expect(completed.usage.model).toBe("claude-sonnet-4-6");
    expect(completed.sessionId).toBe(session.sessionId);

    // The model actually streamed: one doStream call, correct system + user prompt.
    expect(model.doStreamCalls.length).toBe(1);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("say hello");

    // Fresh invoke run: persistSession=false and no resume => nothing persisted.
    await expect(createAgentMessagesRepository(db).loadBySession(session.sessionId)).resolves.toEqual([]);
    await expect(
      db
        .selectFrom("chat_sessions")
        .select("session_id")
        .where("session_id", "=", session.sessionId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("resumes an explicit sessionId: turn-2 sees turn-1 history and agent_messages persist", async () => {
    const { requester, target } = await seedTenant(db);
    const explicitSessionId = "invoke-explicit-resume-1";
    const model = textSequenceModel(["first turn answer", "second turn answer"]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(model),
      buildMcpServers: async () => ({}),
    });

    async function invoke(message: string) {
      const res = await app.request("/api/agent-runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          requesterUserId: requester.id,
          sessionId: explicitSessionId,
          message,
          target: { type: "user", userId: target.id },
        }),
      });
      expect(res.status).toBe(200);
      return sseData(await res.text(), "completed");
    }

    const turn1 = await invoke("what did I ask first");
    const turn2 = await invoke("and now the follow up");

    expect(turn1.sessionId).toBe(explicitSessionId);
    expect(turn1.finalText).toBe("first turn answer");
    expect(turn2.sessionId).toBe(explicitSessionId);
    expect(turn2.finalText).toBe("second turn answer");
    expect(turn2.usage).toBeDefined();

    // Turn-2's prompt to the model must carry turn-1's transcript (the PR fix).
    const turn2Prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(turn2Prompt).toContain("first turn answer");
    expect(turn2Prompt).toContain("what did I ask first");

    // agent_messages persisted for the explicit session across both turns.
    const rows = await createAgentMessagesRepository(db).loadBySession(explicitSessionId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const chatSession = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "runtime", "session_id"])
      .where("session_id", "=", explicitSessionId)
      .executeTakeFirst();
    expect(chatSession).toEqual({
      workspace_key: target.id,
      runtime: "aisdk",
      session_id: explicitSessionId,
    });

    // The persisted transcript is retrievable through the transcript-read surface.
    const transcriptRes = await app.request(`/api/agent-sessions/${explicitSessionId}/messages`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(transcriptRes.status).toBe(200);
    const transcript = await transcriptRes.json();
    expect(transcript).toMatchObject({
      ok: true,
      runtime: "aisdk",
      sessionId: explicitSessionId,
      messages: [
        { seq: 1, role: "user" },
        {
          seq: 2,
          role: "assistant",
          content: { role: "assistant", content: [{ type: "text", text: "first turn answer" }] },
        },
        { seq: 3, role: "user" },
        {
          seq: 4,
          role: "assistant",
          content: { role: "assistant", content: [{ type: "text", text: "second turn answer" }] },
        },
      ],
    });
  });

  it("reads archived AI SDK transcript messages by session id", async () => {
    const { target } = await seedTenant(db);
    const archivedSessionId = "invoke-archived-readable";
    await db
      .insertInto("chat_sessions")
      .values({
        workspace_key: target.id,
        thread_key: "",
        runtime: "aisdk",
        session_id: archivedSessionId,
        archived_at: "2026-07-01T00:00:00.000Z",
      })
      .execute();
    await createAgentMessagesRepository(db).appendBatch([
      { sessionId: archivedSessionId, seq: 1, role: "user", content: { role: "user", content: "archived prompt" } },
      {
        sessionId: archivedSessionId,
        seq: 2,
        role: "assistant",
        content: { role: "assistant", content: "archived answer" },
      },
    ]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(textSequenceModel(["unused"])),
      buildMcpServers: async () => ({}),
    });

    const transcriptRes = await app.request(`/api/agent-sessions/${archivedSessionId}/messages`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(transcriptRes.status).toBe(200);
    await expect(transcriptRes.json()).resolves.toMatchObject({
      ok: true,
      runtime: "aisdk",
      sessionId: archivedSessionId,
      messages: [
        { seq: 1, role: "user", content: { role: "user", content: "archived prompt" } },
        { seq: 2, role: "assistant", content: { role: "assistant", content: "archived answer" } },
      ],
    });
  });

  it("starts a fresh session when explicitly asked to resume an archived same-workspace session id", async () => {
    const { requester, target } = await seedTenant(db);
    const archivedSessionId = "invoke-archived-resume";
    const activeSessionId = "invoke-active-existing";
    await db
      .insertInto("chat_sessions")
      .values({
        workspace_key: target.id,
        thread_key: "",
        runtime: "aisdk",
        session_id: archivedSessionId,
        archived_at: "2026-07-01T00:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({
        workspace_key: target.id,
        thread_key: "",
        runtime: "aisdk",
        session_id: activeSessionId,
      })
      .execute();
    await createAgentMessagesRepository(db).appendBatch([
      { sessionId: archivedSessionId, seq: 1, role: "user", content: { role: "user", content: "archived prompt" } },
      {
        sessionId: archivedSessionId,
        seq: 2,
        role: "assistant",
        content: { role: "assistant", content: "archived answer" },
      },
      { sessionId: activeSessionId, seq: 1, role: "user", content: { role: "user", content: "active prompt" } },
      {
        sessionId: activeSessionId,
        seq: 2,
        role: "assistant",
        content: { role: "assistant", content: "active answer" },
      },
    ]);
    const model = textSequenceModel(["fresh answer"]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(model),
      buildMcpServers: async () => ({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        sessionId: archivedSessionId,
        message: "start fresh",
        target: { type: "user", userId: target.id },
      }),
    });

    expect(res.status).toBe(200);
    const completed = sseData(await res.text(), "completed");
    expect(completed.sessionId).toEqual(expect.any(String));
    expect(completed.sessionId).not.toBe(archivedSessionId);
    expect(completed.sessionId).not.toBe(activeSessionId);
    expect(completed.finalText).toBe("fresh answer");
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).not.toContain("archived answer");
    expect(prompt).not.toContain("active answer");

    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", target.id)
      .where("runtime", "=", "aisdk")
      .orderBy("id", "asc")
      .execute();
    expect(sessions).toEqual([
      { session_id: archivedSessionId, archived_at: "2026-07-01T00:00:00.000Z" },
      { session_id: activeSessionId, archived_at: null },
    ]);
    await expect(createAgentMessagesRepository(db).loadBySession(archivedSessionId)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(activeSessionId)).resolves.toHaveLength(2);
    await expect(createAgentMessagesRepository(db).loadBySession(completed.sessionId)).resolves.toHaveLength(2);
  });

  it("rejects cross-workspace reuse of the same explicit aisdk sessionId", async () => {
    const { requester, target } = await seedTenant(db);
    const otherTarget = await createUserRepository(db).create({
      name: "Other Target",
      email: "other-target@test.com",
      emailVerified: true,
      slackUserId: "SOTHER",
    });
    const explicitSessionId = "invoke-cross-workspace-default";
    const model = textSequenceModel(["first workspace answer", "second workspace answer"]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(model),
      buildMcpServers: async () => ({}),
    });

    const firstRes = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        sessionId: explicitSessionId,
        message: "remember workspace one",
        target: { type: "user", userId: target.id },
      }),
    });
    expect(firstRes.status).toBe(200);
    const firstCompleted = sseData(await firstRes.text(), "completed");
    expect(firstCompleted.finalText).toBe("first workspace answer");

    const secondRes = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        sessionId: explicitSessionId,
        message: "workspace two should not see workspace one",
        target: { type: "user", userId: otherTarget.id },
      }),
    });
    expect(secondRes.status).toBe(200);
    const secondText = await secondRes.text();
    expect(sseData(secondText, "completed")).toBeUndefined();
    expect(sseData(secondText, "error")).toMatchObject({
      error: {
        code: "RUN_FAILED",
        message: `Session id belongs to another workspace: ${explicitSessionId}`,
      },
    });

    expect(model.doStreamCalls).toHaveLength(1);
    const rows = await createAgentMessagesRepository(db).loadBySession(explicitSessionId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    await expect(
      db
        .selectFrom("chat_sessions")
        .select(["workspace_key", "runtime", "session_id"])
        .where("session_id", "=", explicitSessionId)
        .execute(),
    ).resolves.toEqual([{ workspace_key: target.id, runtime: "aisdk", session_id: explicitSessionId }]);
  });

  it("rejects cross-workspace reuse of an archived explicit aisdk sessionId", async () => {
    const { requester, target } = await seedTenant(db);
    const otherTarget = await createUserRepository(db).create({
      name: "Other Target",
      email: "other-target-archived@test.com",
      emailVerified: true,
      slackUserId: "SOTHERARCHIVED",
    });
    const archivedSessionId = "invoke-cross-workspace-archived";
    await db
      .insertInto("chat_sessions")
      .values({
        workspace_key: target.id,
        thread_key: "",
        runtime: "aisdk",
        session_id: archivedSessionId,
        archived_at: "2026-07-01T00:00:00.000Z",
      })
      .execute();
    const model = textSequenceModel(["should not run"]);
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(model),
      buildMcpServers: async () => ({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        sessionId: archivedSessionId,
        message: "workspace two should not claim archived workspace one",
        target: { type: "user", userId: otherTarget.id },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(sseData(text, "completed")).toBeUndefined();
    expect(sseData(text, "error")).toMatchObject({
      error: {
        code: "RUN_FAILED",
        message: `Session id belongs to another workspace: ${archivedSessionId}`,
      },
    });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("surfaces an aisdk run failure as an SSE error without persisting a transcript", async () => {
    const { requester, target } = await seedTenant(db);
    const model = errorModel();
    const app = createApp(db, createTestConfig({ DATA_DIR: dataDir }), {
      logger: createTestLogger(),
      runAgent: makeAiSdkRunAgent(model),
      buildMcpServers: async () => ({}),
    });

    const res = await app.request("/api/agent-runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        requesterUserId: requester.id,
        sessionId: "invoke-error-session",
        message: "trigger a failure",
        target: { type: "user", userId: target.id },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(sseData(text, "completed")).toBeUndefined();
    const error = sseData(text, "error");
    expect(error?.error?.code).toBe("RUN_FAILED");

    await expect(createAgentMessagesRepository(db).loadBySession("invoke-error-session")).resolves.toEqual([]);
  });
});
