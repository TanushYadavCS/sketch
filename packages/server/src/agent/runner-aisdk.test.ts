import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentMessagesRepository } from "../db/repositories/agent-messages";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { IntegrationProvider } from "../integrations/types";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { type RunAgentParams, runAgent } from "./runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./runtime/pricing";
import type { AgentRuntimeProvider } from "./runtime/provider";

const API_KEY = "sk_live_aisdk_test_key";

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function textModel(text = "done"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: text },
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

function readThenTextModel(filePath: string, text = "done"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "tool-read-image",
              toolName: "Read",
              input: JSON.stringify({ file_path: filePath }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: usage(20, 1),
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: text },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(10, 2),
            },
          ],
        }),
      },
    ],
  });
}

function bashThenTextModel(command: string, text = "done"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "tool-bash",
              toolName: "Bash",
              input: JSON.stringify({ command }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: usage(20, 1),
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: text },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(10, 2),
            },
          ],
        }),
      },
    ],
  });
}

function bashThenProviderErrorModel(command: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "tool-bash",
              toolName: "Bash",
              input: JSON.stringify({ command }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: usage(20, 1),
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [{ type: "error", error: new Error("provider failed after brokered bash") }],
        }),
      },
    ],
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

function capturingProvider(model: LanguageModel, capture: { systemPrompt?: string }): AgentRuntimeProvider {
  return {
    ...mockProvider(model),
    preparePrompt: (input) => {
      capture.systemPrompt = input.systemPrompt;
      return {
        instructions: input.systemPrompt,
        messages: input.messages ?? [{ role: "user", content: input.prompt }],
      };
    },
  };
}

function calledToolNames(model: MockLanguageModelV4): string[] {
  return (model.doStreamCalls[0]?.tools ?? []).map((tool) => String(tool.name)).sort();
}

async function writeFakeBrokerCli(cliPath: string): Promise<void> {
  await writeFile(
    cliPath,
    `
const { writeFileSync } = require("node:fs");

const [, , mode, launcherPath, outputFile, agentValue] = process.argv;
writeFileSync(
  outputFile,
  JSON.stringify({
    mode,
    launcherPath,
    agentValue,
    brokerSecret: process.env.BROKER_TOKEN || "",
  }),
);
process.stdout.write("brokered ok\\n");
`,
  );
}

function brokerCapableProvider(cliPath: string): IntegrationProvider {
  return {
    type: "canvas",
    listConnections: vi.fn().mockResolvedValue([]),
    listApps: vi.fn().mockResolvedValue({ apps: [], pageInfo: { endCursor: null, hasMore: false } }),
    initiateConnection: vi.fn().mockResolvedValue({ redirectUrl: "" }),
    removeConnection: vi.fn().mockResolvedValue(undefined),
    isBrokerCapable: () => true,
    getBrokerSpec: vi.fn(() => ({
      cliPath,
      credentialEnv: { BROKER_TOKEN: "broker-secret" },
      launcherEnvName: "CANVAS_CLI",
    })),
  };
}

async function readBrokerCliOutput(outputPath: string): Promise<{
  mode: string;
  launcherPath: string;
  agentValue: string;
  brokerSecret: string;
}> {
  return JSON.parse(await readFile(outputPath, "utf8"));
}

describe("runAgent AI SDK runtime path", () => {
  let db: Kysely<DB>;
  let workspace: string;

  beforeEach(async () => {
    db = await createTestDb();
    workspace = await mkdtemp(join(tmpdir(), "sketch-runner-aisdk-"));
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes", "today.txt"), "alpha");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.destroy();
    await rm(workspace, { recursive: true, force: true });
  });

  function makeRunParams(model: LanguageModel, overrides: Partial<RunAgentParams> = {}): RunAgentParams {
    return {
      db,
      workspaceKey: "user-U1",
      userMessage: "hello",
      workspaceDir: workspace,
      claudeConfigDir: workspace,
      userName: "Alice",
      logger: createTestLogger(),
      platform: "slack",
      onProgressEvent: vi.fn().mockResolvedValue(undefined),
      agentRuntime: "aisdk",
      agentRuntimeProvider: mockProvider(model),
      ...overrides,
    };
  }

  it("runs a workspace-tool loop through the main path and resumes the DB session on turn two", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "tool-1", toolName: "Read", input: '{"file_path":"notes/today.txt"}' },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(20, 1),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "saw alpha" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(30, 3),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: "resumed" },
              { type: "text-end", id: "text-2" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(40, 2),
              },
            ],
          }),
        },
      ],
    });
    const onProgressEvent = vi.fn().mockResolvedValue(undefined);
    const onSessionId = vi.fn().mockResolvedValue(undefined);

    const turn1 = await runAgent({
      db,
      workspaceKey: "user-U1",
      userMessage: "read today's notes",
      workspaceDir: workspace,
      claudeConfigDir: workspace,
      userName: "Alice",
      logger: createTestLogger(),
      platform: "slack",
      onProgressEvent,
      onSessionId,
      agentRuntime: "aisdk",
      agentRuntimeProvider: mockProvider(model),
    });
    const turn2 = await runAgent({
      db,
      workspaceKey: "user-U1",
      userMessage: "continue",
      workspaceDir: workspace,
      claudeConfigDir: workspace,
      userName: "Alice",
      logger: createTestLogger(),
      platform: "slack",
      onProgressEvent: vi.fn().mockResolvedValue(undefined),
      agentRuntime: "aisdk",
      agentRuntimeProvider: mockProvider(model),
    });

    expect(turn1.trace.progressEvents).toEqual([
      { kind: "tool_use", toolName: "Read", input: { file_path: "notes/today.txt" } },
    ]);
    expect(turn1.trace.finalText).toBe("saw alpha");
    expect(turn2.sessionId).toBe(turn1.sessionId);
    expect(turn2.rawUsage.isResumedSession).toBe(true);
    expect(turn2.trace.finalText).toBe("resumed");
    expect(onSessionId).toHaveBeenCalledWith(turn1.sessionId);

    const rows = await createAgentMessagesRepository(db).loadBySession(turn1.sessionId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
    await expect(
      db
        .selectFrom("chat_sessions")
        .select(["workspace_key", "thread_key", "runtime", "session_id"])
        .where("workspace_key", "=", "user-U1")
        .where("thread_key", "=", "")
        .where("runtime", "=", "aisdk")
        .executeTakeFirst(),
    ).resolves.toEqual({
      workspace_key: "user-U1",
      thread_key: "",
      runtime: "aisdk",
      session_id: turn1.sessionId,
    });
    expect(model.doStreamCalls.at(-1)?.prompt.length).toBeGreaterThan(2);
  });

  it("persists and resumes explicit AI SDK session ids when persistSession is false", async () => {
    const explicitSessionId = "agent-runtime-explicit-resume";
    const model = textSequenceModel(["first explicit session", "second explicit session"]);
    const settings = createSettingsRepository(db);
    await settings.create();
    await settings.update({ onboardingCompletedAt: new Date().toISOString(), sketchApiKey: API_KEY });

    const turn1 = await runAgent(
      makeRunParams(model, {
        resumeSessionId: explicitSessionId,
        persistSession: false,
        threadTs: "thread-1",
      }),
    );
    const turn2 = await runAgent(
      makeRunParams(model, {
        resumeSessionId: explicitSessionId,
        persistSession: false,
        threadTs: "thread-1",
      }),
    );

    expect(turn1.sessionId).toBe(explicitSessionId);
    expect(turn2.sessionId).toBe(explicitSessionId);
    expect(turn2.rawUsage.isResumedSession).toBe(true);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("first explicit session");

    const session = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "runtime", "session_id"])
      .where("session_id", "=", explicitSessionId)
      .executeTakeFirst();
    expect(session).toEqual({
      workspace_key: "user-U1",
      thread_key: "thread-1",
      runtime: "aisdk",
      session_id: explicitSessionId,
    });
    const rows = await createAgentMessagesRepository(db).loadBySession(explicitSessionId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const app = createApp(db, createTestConfig({ DATA_DIR: workspace }), { logger: createTestLogger() });
    const res = await app.request(`/api/agent-sessions/${explicitSessionId}/messages`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      runtime: "aisdk",
      sessionId: explicitSessionId,
      messages: [
        { seq: 1, role: "user", content: { role: "user", content: "hello" } },
        {
          seq: 2,
          role: "assistant",
          content: { role: "assistant", content: [{ type: "text", text: "first explicit session" }] },
        },
        { seq: 3, role: "user", content: { role: "user", content: "hello" } },
        {
          seq: 4,
          role: "assistant",
          content: { role: "assistant", content: [{ type: "text", text: "second explicit session" }] },
        },
      ],
    });
  });

  it("does not persist fresh AI SDK runs when persistSession is false", async () => {
    const result = await runAgent(
      makeRunParams(textModel("fresh transient session"), {
        sessionMode: "fresh",
        persistSession: false,
      }),
    );

    await expect(createAgentMessagesRepository(db).loadBySession(result.sessionId)).resolves.toEqual([]);
    await expect(
      db
        .selectFrom("chat_sessions")
        .select(["workspace_key", "thread_key", "runtime", "session_id"])
        .where("session_id", "=", result.sessionId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("exposes default workspace tools when agentAllowedTools is null", async () => {
    const model = textModel();

    await runAgent(makeRunParams(model, { agentAllowedTools: null }));

    expect(calledToolNames(model)).toEqual([
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "Write",
      "mcp__sketch__GetEntityContext",
      "mcp__sketch__GetFileContent",
      "mcp__sketch__GetTeamDirectory",
      "mcp__sketch__ListFollowups",
      "mcp__sketch__ListTasks",
      "mcp__sketch__ManageAutomationShares",
      "mcp__sketch__ManageScheduledTasks",
      "mcp__sketch__ReadChatHistory",
      "mcp__sketch__ResolveInboxWorkflow",
      "mcp__sketch__Search",
      "mcp__sketch__SearchChatHistory",
      "mcp__sketch__SearchDeliveryTargets",
      "mcp__sketch__SearchEntities",
      "mcp__sketch__SearchUsers",
      "mcp__sketch__SendFileToChat",
      "mcp__sketch__SendMessage",
      "mcp__sketch__SendMessageToTarget",
      "mcp__sketch__SendMessageToUsers",
      "mcp__sketch__SetUserTimezone",
      "mcp__sketch__UpdateInboxWorkflow",
      "mcp__sketch__WriteAgentOutput",
      "mcp__sketch__getProviderConfig",
      "mcp__sketch__local_claude_session",
      "mcp__sketch__local_run_command",
    ]);
  });

  it("exposes Skill when discovered skills are available and the allowlist permits it", async () => {
    await mkdir(join(workspace, ".claude", "skills", "canvas"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "skills", "canvas", "SKILL.md"),
      "---\ndescription: Canvas skill\n---\nCanvas instructions",
    );
    const model = textModel();

    await runAgent(makeRunParams(model, { agentAllowedTools: null }));

    expect(calledToolNames(model)).toContain("Skill");
    const skillTool = model.doStreamCalls[0]?.tools?.find((tool) => tool.name === "Skill") as
      | { description?: string }
      | undefined;
    expect(skillTool?.description).toContain("- canvas: Canvas skill");
  });

  it("exposes only explicit allowlist tools that exist in the AI SDK runtime", async () => {
    const model = textModel();

    await runAgent(makeRunParams(model, { agentAllowedTools: ["Read", "Grep", "WebSearch"] }));

    expect(calledToolNames(model)).toEqual(["Grep", "Read"]);
  });

  it("silently drops allowlisted web tools from the AI SDK runtime and appends runtime capabilities", async () => {
    const model = textModel();
    const capture: { systemPrompt?: string } = {};

    await runAgent(
      makeRunParams(model, {
        agentAllowedTools: ["Read", "WebSearch", "WebFetch"],
        agentRuntimeProvider: capturingProvider(model, capture),
      }),
    );

    expect(calledToolNames(model)).toEqual(["Read"]);
    expect(capture.systemPrompt).not.toContain("WebSearch");
    expect(capture.systemPrompt).not.toContain("WebFetch");
    expect(capture.systemPrompt).toContain("## Runtime Capabilities");
  });

  it("does not register Bash when the persona allowlist excludes it", async () => {
    const model = textModel();

    await runAgent(makeRunParams(model, { agentAllowedTools: ["Read", "Write", "Edit", "Glob", "Grep"] }));

    expect(calledToolNames(model)).toEqual(["Edit", "Glob", "Grep", "Read", "Write"]);
  });

  it("applies the persona allowlist to custom Sketch tools", async () => {
    const model = textModel();

    await runAgent(makeRunParams(model, { agentAllowedTools: ["mcp__sketch__Search", "mcp__sketch__SendFileToChat"] }));

    expect(calledToolNames(model)).toEqual(["mcp__sketch__Search", "mcp__sketch__SendFileToChat"]);
  });

  it("filters Skill through the persona allowlist", async () => {
    await mkdir(join(workspace, ".claude", "skills", "canvas"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "skills", "canvas", "SKILL.md"),
      "---\ndescription: Canvas skill\n---\nCanvas instructions",
    );
    const excluded = textModel();
    const included = textModel();

    await runAgent(makeRunParams(excluded, { agentAllowedTools: ["Read"] }));
    await runAgent(makeRunParams(included, { agentAllowedTools: ["Skill"] }));

    expect(calledToolNames(excluded)).toEqual(["Read"]);
    expect(calledToolNames(included)).toEqual(["Skill"]);
  });

  it("runs Skill tool calls and attributes them to the selected skill", async () => {
    await mkdir(join(workspace, ".claude", "skills", "canvas"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "skills", "canvas", "SKILL.md"),
      "---\ndescription: Canvas skill\n---\nCanvas instructions",
    );
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "tool-skill", toolName: "Skill", input: '{"skill":"canvas"}' },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(20, 1),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "loaded canvas" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(10, 2),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent(makeRunParams(model));

    expect(result.trace.progressEvents).toContainEqual({
      kind: "tool_use",
      toolName: "Skill",
      input: { skill: "canvas" },
    });
    expect(result.rawUsage.toolCalls).toContainEqual(
      expect.objectContaining({ toolName: "Skill", skillName: "canvas" }),
    );
    expect(result.trace.finalText).toBe("loaded canvas");
  });

  it("prepends org CLAUDE.md before workspace CLAUDE.md before the Sketch system prompt", async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), "sketch-runner-aisdk-claude-"));
    await writeFile(join(claudeConfigDir, "CLAUDE.md"), "org memory", "utf-8");
    await writeFile(join(workspace, "CLAUDE.md"), "workspace memory", "utf-8");
    const capture: { systemPrompt?: string } = {};

    try {
      await runAgent(
        makeRunParams(textModel(), {
          claudeConfigDir,
          agentRuntimeProvider: capturingProvider(textModel(), capture),
        }),
      );
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }

    expect(capture.systemPrompt).toContain("org memory");
    expect(capture.systemPrompt).toContain("workspace memory");
    expect(capture.systemPrompt?.indexOf("org memory")).toBeLessThan(
      capture.systemPrompt?.indexOf("workspace memory") ?? -1,
    );
    expect(capture.systemPrompt?.indexOf("workspace memory")).toBeLessThan(
      capture.systemPrompt?.indexOf("You are Sketch") ?? -1,
    );
  });

  it("drains SendFileToChat uploads from the custom tool collector", async () => {
    const uploadPath = join(workspace, "report.txt");
    await writeFile(uploadPath, "ready");
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "tool-upload",
                toolName: "mcp__sketch__SendFileToChat",
                input: JSON.stringify({ file_path: uploadPath }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(20, 1),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "uploaded" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(10, 2),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent(makeRunParams(model));

    expect(result.pendingUploads).toEqual([uploadPath]);
    expect(result.trace.progressEvents).toContainEqual({
      kind: "tool_use",
      toolName: "mcp__sketch__SendFileToChat",
      input: { file_path: uploadPath },
    });
  });

  it("captures a missing managed Linear card from AI SDK lifecycle tool events", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "tool-bash",
                toolName: "Bash",
                input: JSON.stringify({ command: '$CANVAS_CLI search-apps --queries="linear" --output json' }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(20, 1),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-linear-1" },
              { type: "text-delta", id: "text-linear-1", delta: "connect linear" },
              { type: "text-end", id: "text-linear-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(10, 2),
              },
            ],
          }),
        },
      ],
    });
    const provider = {
      type: "canvas",
      listConnections: vi.fn().mockResolvedValue([]),
      listApps: vi.fn(),
      initiateConnection: vi.fn(),
      removeConnection: vi.fn(),
      isBrokerCapable: () => false,
      getBrokerSpec: () => null,
    };

    const result = await runAgent(
      makeRunParams(model, {
        userEmail: "alice@example.com",
        currentUserId: "alice",
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
        cliIntegrations: {
          listCatalog: () => [
            {
              id: "linear",
              name: "Linear",
              description: "Use Linear through Sketch.",
              icon: "https://linear.app/favicon.svg",
              executionMode: "api",
              connected: false,
              connectionId: null,
            },
          ],
          listConnections: vi.fn().mockResolvedValue([]),
        },
        agentEnv: { CANVAS_CLI: "missing-canvas-cli" },
      }),
    );

    expect(provider.listApps).not.toHaveBeenCalled();
    expect(result.pendingIntegrationConnections).toMatchObject([
      { appId: "linear", appName: "Linear", state: "connect", executionMode: "api" },
    ]);
  });

  it("captures integration cards from AI SDK lifecycle tool events", async () => {
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "tool-bash",
                toolName: "Bash",
                input: JSON.stringify({ command: "$CANVAS_CLI search-apps --queries=github --output json" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(20, 1),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "connect github" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(10, 2),
              },
            ],
          }),
        },
      ],
    });
    const provider = {
      type: "canvas",
      listConnections: vi.fn().mockResolvedValue([]),
      listApps: vi.fn().mockResolvedValue({
        apps: [{ id: "github", name: "GitHub", description: "Code hosting" }],
        pageInfo: { endCursor: null, hasMore: false },
      }),
      initiateConnection: vi.fn(),
      removeConnection: vi.fn(),
      isBrokerCapable: () => false,
      getBrokerSpec: () => null,
    };

    const result = await runAgent(
      makeRunParams(model, {
        userEmail: "alice@example.com",
        currentUserId: "alice",
        loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
        cliIntegrations: {
          listCatalog: () => [
            {
              id: "github",
              name: "GitHub",
              description: "Use GitHub through Sketch.",
              icon: "https://github.com/favicon.svg",
              executionMode: "cli",
              connected: false,
              connectionId: null,
            },
          ],
          listConnections: vi.fn().mockResolvedValue([]),
        },
        agentEnv: { CANVAS_CLI: "missing-canvas-cli" },
      }),
    );

    expect(provider.listApps).not.toHaveBeenCalled();
    expect(result.pendingIntegrationConnections).toMatchObject([
      { appId: "github", appName: "GitHub", state: "connect", executionMode: "cli" },
    ]);
  });

  it("passes brokered integration env vars into AI SDK Bash and cleans up after success", async () => {
    const cliPath = join(workspace, "fake-canvas-cli.cjs");
    const outputPath = join(workspace, "broker-success.json");
    await writeFakeBrokerCli(cliPath);
    const provider = brokerCapableProvider(cliPath);
    const loadIntegrationProvider = vi.fn().mockResolvedValue(provider);
    const command = `$CANVAS_CLI env-check "$CANVAS_CLI" "${outputPath}" "$AGENT_ONLY"`;

    const result = await runAgent(
      makeRunParams(bashThenTextModel(command, "brokered done"), {
        userEmail: "alice@example.com",
        loadIntegrationProvider,
        agentEnv: { AGENT_ONLY: "agent-value" },
      }),
    );
    const brokerOutput = await readBrokerCliOutput(outputPath);

    expect(result.trace.progressEvents).toContainEqual({
      kind: "tool_use",
      toolName: "Bash",
      input: { command },
    });
    expect(loadIntegrationProvider).toHaveBeenCalled();
    expect(provider.getBrokerSpec).toHaveBeenCalledWith({ userEmail: "alice@example.com", claudeConfigDir: workspace });
    expect(brokerOutput).toMatchObject({
      mode: "env-check",
      agentValue: "agent-value",
      brokerSecret: "broker-secret",
    });
    await expect(access(brokerOutput.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up brokered integration access when the AI SDK run throws", async () => {
    const cliPath = join(workspace, "fake-canvas-cli-error.cjs");
    const outputPath = join(workspace, "broker-error.json");
    await writeFakeBrokerCli(cliPath);
    const provider = brokerCapableProvider(cliPath);
    const command = `$CANVAS_CLI env-check "$CANVAS_CLI" "${outputPath}" "$AGENT_ONLY"`;

    await expect(
      runAgent(
        makeRunParams(bashThenProviderErrorModel(command), {
          userEmail: "alice@example.com",
          loadIntegrationProvider: vi.fn().mockResolvedValue(provider),
          agentEnv: { AGENT_ONLY: "agent-value" },
        }),
      ),
    ).rejects.toThrow("Agent runtime provider failed");

    const brokerOutput = await readBrokerCliOutput(outputPath);
    expect(brokerOutput).toMatchObject({
      mode: "env-check",
      agentValue: "agent-value",
      brokerSecret: "broker-secret",
    });
    await expect(access(brokerOutput.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses VisualAnalysis for image handling in the AI SDK runtime when configured", async () => {
    const imagePath = join(workspace, "diagram.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "diagram text" } }],
        usage: { prompt_tokens: 80, completion_tokens: 12, cost: 0.002 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "tool-vision",
                toolName: "mcp__sketch__VisualAnalysis",
                input: JSON.stringify({ file_path: imagePath, question: "What is shown?" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: usage(20, 1),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "saw diagram text" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: usage(10, 2),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent(
      makeRunParams(model, {
        attachments: [
          {
            originalName: "diagram.png",
            mimeType: "image/png",
            localPath: imagePath,
            sizeBytes: 8,
          },
        ],
        visionConfig: {
          apiKey: "sk-or-vision",
          model: "xiaomi/mimo-v2.5",
          source: "env",
          providerMode: "env",
        },
      }),
    );

    expect(calledToolNames(model)).toContain("mcp__sketch__VisualAnalysis");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("mcp__sketch__VisualAnalysis");
    expect(result.trace.finalText).toBe("saw diagram text");
    expect(result.auxCostUsd).toBe(0.002);
    expect(result.rawUsage.auxLlmCalls).toContainEqual(
      expect.objectContaining({
        op: "vision",
        model: "xiaomi/mimo-v2.5",
        costUsd: 0.002,
        source: "openrouter",
      }),
    );
  });

  it("does not block AI SDK Read on image paths when VisualAnalysis is excluded by an allowlist", async () => {
    const imagePath = join(workspace, "diagram.png");
    await writeFile(imagePath, "image-as-text");
    const model = readThenTextModel(imagePath, "read image directly");

    const result = await runAgent(
      makeRunParams(model, {
        attachments: [
          {
            originalName: "diagram.png",
            mimeType: "image/png",
            localPath: imagePath,
            sizeBytes: 13,
          },
        ],
        visionConfig: {
          apiKey: "sk-or-vision",
          model: "xiaomi/mimo-v2.5",
          source: "env",
          providerMode: "env",
        },
        agentAllowedTools: ["Read"],
        blockedReadPaths: [imagePath],
      }),
    );

    expect(calledToolNames(model)).toEqual(["Read"]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("mcp__sketch__VisualAnalysis");
    expect(model.doStreamCalls[1]?.prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              output: expect.objectContaining({
                type: "content",
                value: [
                  {
                    type: "file",
                    mediaType: "image/png",
                    data: { type: "data", data: Buffer.from("image-as-text").toString("base64") },
                  },
                ],
              }),
            }),
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("visual analysis");
    expect(result.trace.finalText).toBe("read image directly");
  });

  it("blocks AI SDK Read on image paths when VisualAnalysis is allowed", async () => {
    const imagePath = join(workspace, "diagram.png");
    await writeFile(imagePath, "image-as-text");
    const model = readThenTextModel(imagePath, "blocked image read");

    const result = await runAgent(
      makeRunParams(model, {
        attachments: [
          {
            originalName: "diagram.png",
            mimeType: "image/png",
            localPath: imagePath,
            sizeBytes: 13,
          },
        ],
        visionConfig: {
          apiKey: "sk-or-vision",
          model: "xiaomi/mimo-v2.5",
          source: "env",
          providerMode: "env",
        },
        agentAllowedTools: ["Read", "mcp__sketch__VisualAnalysis"],
      }),
    );

    expect(calledToolNames(model)).toEqual(["Read", "mcp__sketch__VisualAnalysis"]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("mcp__sketch__VisualAnalysis");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("mcp__sketch__VisualAnalysis");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("image-as-text");
    expect(result.trace.finalText).toBe("blocked image read");
  });
});
