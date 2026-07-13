import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentMessagesRepository } from "../../db/repositories/agent-messages";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import {
  AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
  createDefaultAgentRuntimeCompactionProvider,
  reconstructCompactedHistory,
} from "./compaction";
import type { AgentRuntimeMessage } from "./contracts";
import { runAgentRuntimeCore } from "./core";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import type { AgentRuntimeProvider } from "./provider";
import { createDbAgentRuntimeSessionStore } from "./session-store";

function markerEnvelope(replacedPrefixEndSeq: number) {
  return {
    marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
    version: 1,
    trigger: "auto",
    summary: "Prefix summary.",
    replacedPrefixStartSeq: 1,
    replacedPrefixEndSeq,
    keepRecentTailStartSeq: replacedPrefixEndSeq + 1,
  };
}

function toRuntimeMessages(
  rows: ReadonlyArray<{ seq: number; role: string; content: unknown }>,
): AgentRuntimeMessage[] {
  return rows.map((row) => ({ seq: row.seq, role: row.role as AgentRuntimeMessage["role"], content: row.content }));
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function mockProvider(model: MockLanguageModelV4): AgentRuntimeProvider {
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

describe("DB-backed agent runtime session store", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("round-trips messages ordered by seq", async () => {
    const store = createDbAgentRuntimeSessionStore(db);

    await store.appendTransactional("sess-ai", [
      { role: "user", content: { role: "user", content: "one" } },
      { role: "assistant", content: { role: "assistant", content: "two" } },
    ]);

    await expect(store.load("sess-ai")).resolves.toEqual([
      { seq: 1, role: "user", content: { role: "user", content: "one" } },
      { seq: 2, role: "assistant", content: { role: "assistant", content: "two" } },
    ]);
  });

  it("allocates monotonic seq values across appends to the same session", async () => {
    const store = createDbAgentRuntimeSessionStore(db);

    await store.appendTransactional("sess-ai", [{ role: "user", content: { role: "user", content: "one" } }]);
    await store.appendTransactional("sess-ai", [
      { role: "assistant", content: { role: "assistant", content: "two" } },
      { role: "user", content: { role: "user", content: "three" } },
    ]);

    const rows = await store.load("sess-ai");
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.content)).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });

  it("survives restart by reconstructing from an appended compaction marker", async () => {
    const store = createDbAgentRuntimeSessionStore(db);
    await store.appendTransactional("sess-compact-restart", [
      { role: "user", content: { role: "user", content: "old one" } },
      { role: "assistant", content: { role: "assistant", content: "old two" } },
      { role: "user", content: { role: "user", content: "recent" } },
    ]);
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doGenerate: {
        content: [{ type: "text", text: "Restart-safe summary." }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(10, 2),
        warnings: [],
      },
    });
    const compactor = createDefaultAgentRuntimeCompactionProvider({
      provider: mockProvider(model),
      sessionStore: store,
      systemPrompt: "system",
      currentUserMessage: { role: "user", content: "current" },
      contextWindowTokens: 10,
      thresholdFraction: 0.1,
      keepRecentTailFraction: 0.1,
      estimateTokens: () => 1,
    });

    await compactor.compact({ sessionId: "sess-compact-restart", messages: await store.load("sess-compact-restart") });
    const allRows = await createAgentMessagesRepository(db).loadBySession("sess-compact-restart");
    const turnRows = await store.load("sess-compact-restart");
    const effectiveRows = reconstructCompactedHistory(turnRows);

    expect(allRows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(allRows[3]).toMatchObject({
      role: "user",
      content: {
        marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
        summary: "Restart-safe summary.",
        replacedPrefixStartSeq: 1,
        replacedPrefixEndSeq: 2,
        keepRecentTailStartSeq: 3,
      },
    });
    expect(turnRows.map((row) => row.seq)).toEqual([3, 4]);
    expect(effectiveRows.map((row) => row.content)).toEqual([
      { role: "user", content: "[Prior conversation summary]\nRestart-safe summary." },
      { role: "user", content: "recent" },
    ]);
  });

  it("assembles identical history from the reduced turn load and a full load, with and without a marker", async () => {
    const store = createDbAgentRuntimeSessionStore(db);
    const repo = createAgentMessagesRepository(db);

    await store.appendTransactional("s-nomarker", [
      { role: "user", content: { role: "user", content: "a" } },
      { role: "assistant", content: { role: "assistant", content: "b" } },
      { role: "user", content: { role: "user", content: "c" } },
    ]);
    const fullNoMarker = toRuntimeMessages(await repo.loadBySession("s-nomarker"));
    const reducedNoMarker = await store.load("s-nomarker");
    expect(reducedNoMarker).toEqual(fullNoMarker);
    expect(reconstructCompactedHistory(reducedNoMarker)).toEqual(reconstructCompactedHistory(fullNoMarker));

    await store.appendTransactional("s-marker", [
      { role: "user", content: { role: "user", content: "old-1" } },
      { role: "assistant", content: { role: "assistant", content: "old-2" } },
      { role: "user", content: { role: "user", content: "recent" } },
    ]);
    await store.appendTransactional("s-marker", [{ role: "user", content: markerEnvelope(2) }]);

    const fullMarker = toRuntimeMessages(await repo.loadBySession("s-marker"));
    const reducedMarker = await store.load("s-marker");
    expect(reducedMarker.map((row) => row.seq)).toEqual([3, 4]);
    expect(reconstructCompactedHistory(reducedMarker)).toEqual(reconstructCompactedHistory(fullMarker));
  });

  it("skips a poisoned pre-marker row that a full load would fail to parse", async () => {
    const store = createDbAgentRuntimeSessionStore(db);
    const repo = createAgentMessagesRepository(db);

    await db
      .insertInto("agent_messages")
      .values([
        { session_id: "s-poison", seq: 1, role: "user", content: "{ not valid json" },
        { session_id: "s-poison", seq: 2, role: "user", content: JSON.stringify(markerEnvelope(1)) },
        {
          session_id: "s-poison",
          seq: 3,
          role: "assistant",
          content: JSON.stringify({ role: "assistant", content: "tail" }),
        },
      ])
      .execute();

    await expect(repo.loadBySession("s-poison")).rejects.toThrow();

    const rows = await store.load("s-poison");
    expect(rows.map((row) => row.seq)).toEqual([2, 3]);
    expect(reconstructCompactedHistory(rows).map((row) => row.content)).toEqual([
      { role: "user", content: "[Prior conversation summary]\nPrefix summary." },
      { role: "assistant", content: "tail" },
    ]);
  });

  it("does not append a partially failed provider run", async () => {
    const store = createDbAgentRuntimeSessionStore(db);
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [{ type: "error", error: new Error("provider failed before a completed run") }],
        }),
      },
    });

    await expect(
      runAgentRuntimeCore({
        provider: mockProvider(model),
        prompt: "hello",
        systemPrompt: "system",
        maxTurns: 1,
        persistSession: true,
        sessionId: "sess-crash",
        sessionStore: store,
      }),
    ).rejects.toThrow("Agent runtime provider failed");

    await expect(store.load("sess-crash")).resolves.toEqual([]);
  });

  it("appends the user turn and response messages at run end, then archives without removing messages", async () => {
    const store = createDbAgentRuntimeSessionStore(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "aisdk", session_id: "sess-complete" })
      .execute();
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "done" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(10, 2),
            },
          ],
        }),
      },
    });

    await runAgentRuntimeCore({
      provider: mockProvider(model),
      prompt: "hello",
      systemPrompt: "system",
      maxTurns: 1,
      persistSession: true,
      sessionId: "sess-complete",
      sessionStore: store,
    });

    const rows = await store.load("sess-complete");
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0].content).toEqual({ role: "user", content: "hello" });

    await store.archive({ sessionId: "sess-complete", runtime: "aisdk" });
    await expect(store.load("sess-complete")).resolves.toHaveLength(2);
    const session = await db
      .selectFrom("chat_sessions")
      .select("archived_at")
      .where("session_id", "=", "sess-complete")
      .executeTakeFirstOrThrow();
    expect(session.archived_at).toEqual(expect.any(String));
  });

  it("archives rows by runtime session lookup without removing messages", async () => {
    const store = createDbAgentRuntimeSessionStore(db);
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "sdk", session_id: "sess-sdk" })
      .execute();
    await store.appendTransactional("sess-ai", [{ role: "user", content: { role: "user", content: "ai" } }]);
    await store.appendTransactional("sess-sdk", [{ role: "user", content: { role: "user", content: "sdk" } }]);

    await store.archive({ workspaceKey: "user-U1", threadKey: "", runtime: "aisdk" });

    await expect(store.load("sess-ai")).resolves.toHaveLength(1);
    await expect(store.load("sess-sdk")).resolves.toHaveLength(1);
    const sessions = await db
      .selectFrom("chat_sessions")
      .select(["runtime", "archived_at"])
      .where("workspace_key", "=", "user-U1")
      .orderBy("runtime", "asc")
      .execute();
    expect(sessions).toEqual([
      { runtime: "aisdk", archived_at: expect.any(String) },
      { runtime: "sdk", archived_at: null },
    ]);
  });
});
