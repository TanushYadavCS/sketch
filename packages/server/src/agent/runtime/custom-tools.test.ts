import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../../db/schema";
import { createTestDb, createTestLogger } from "../../test-utils";
import type { RunAgentParams } from "../runner";
import { createAgentRuntimeCustomToolEffects, createDefaultAgentRuntimeCustomToolProvider } from "./custom-tools";

interface SmokeTool {
  inputSchema?: {
    safeParse(value: unknown): { success: boolean };
  };
  execute?: (input: Record<string, unknown>, options: never) => Promise<unknown>;
  toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
}

describe("AI SDK custom Sketch tool provider", () => {
  let workspace: string;
  let db: Kysely<DB>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sketch-runtime-custom-tools-"));
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
    await rm(workspace, { recursive: true, force: true });
  });

  function params(overrides: Partial<RunAgentParams> = {}): RunAgentParams {
    return {
      db,
      workspaceKey: "user-U1",
      userMessage: "hello",
      workspaceDir: workspace,
      userName: "Alice",
      logger: createTestLogger(),
      platform: "slack",
      onProgressEvent: vi.fn().mockResolvedValue(undefined),
      agentRuntime: "aisdk",
      ...overrides,
    };
  }

  it("registers namespaced custom tools and applies the persona allowlist", async () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: false,
      visionAnalysisEnabled: false,
      visionConfig: null,
    });

    const tools = await provider.createTools(params({ agentAllowedTools: ["mcp__sketch__SendFileToChat", "Read"] }));

    expect(Object.keys(tools)).toEqual(["mcp__sketch__SendFileToChat"]);
  });

  it("exposes the conditional media tools only when enabled", async () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: true,
      visionAnalysisEnabled: true,
      visionConfig: { apiKey: "sk-or-vision", model: "vision-model", source: "env", providerMode: "env" },
    });

    const tools = await provider.createTools(params());

    expect(tools.mcp__sketch__TranscribeAudio).toBeDefined();
    expect(tools.mcp__sketch__VisualAnalysis).toBeDefined();
  });

  it("invokes the wrapped SDK handler and preserves upload side effects", async () => {
    const filePath = join(workspace, "report.txt");
    await writeFile(filePath, "done");
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: false,
      visionAnalysisEnabled: false,
      visionConfig: null,
    });
    const tools = await provider.createTools(params());

    const input = { file_path: filePath };
    const result = await tools.mcp__sketch__SendFileToChat.execute?.(input, {} as never);
    const modelOutput = await (tools.mcp__sketch__SendFileToChat as SmokeTool).toModelOutput?.({
      toolCallId: "tool-upload",
      input,
      output: result,
    });

    expect(modelOutput).toEqual({
      type: "content",
      value: [{ type: "text", text: `File queued for upload: ${filePath}` }],
    });
    expect(modelOutput).not.toEqual(result);
    expect(effects.uploadCollector.drain()).toEqual([filePath]);
  });

  it("maps MCP image content to the AI SDK file envelope used by @ai-sdk/mcp", async () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: false,
      visionAnalysisEnabled: false,
      visionConfig: null,
    });
    const tools = await provider.createTools(params());

    const modelOutput = await (tools.mcp__sketch__SendFileToChat as SmokeTool).toModelOutput?.({
      toolCallId: "tool-image",
      input: {},
      output: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
    });

    expect(modelOutput).toEqual({
      type: "content",
      value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "iVBORw0KGgo=" } }],
    });
  });

  it("parses and invokes every custom Sketch tool wrapper", async () => {
    const filePath = join(workspace, "report.txt");
    await writeFile(filePath, "done");
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: true,
      visionAnalysisEnabled: true,
      visionConfig: { apiKey: "sk-or-vision", model: "vision-model", source: "env", providerMode: "env" },
    });
    const tools = await provider.createTools(params());
    const smokeInputs = {
      mcp__sketch__SendFileToChat: { file_path: filePath },
      mcp__sketch__ReadChatHistory: {},
      mcp__sketch__SearchChatHistory: { query: "alpha" },
      mcp__sketch__SearchDeliveryTargets: { query: "alpha", limit: 1 },
      mcp__sketch__local_run_command: { command: "pwd" },
      mcp__sketch__local_claude_session: { action: "list" },
      mcp__sketch__ManageScheduledTasks: { action: "list" },
      mcp__sketch__ListTasks: { parentEntityId: "entity-1", limit: 1 },
      mcp__sketch__GetTeamDirectory: {},
      mcp__sketch__SetUserTimezone: { timezone: "Asia/Kolkata" },
      mcp__sketch__SearchUsers: { queries: ["alice"] },
      mcp__sketch__SendMessageToUser: { recipientUserId: "user-2", message: "hello" },
      mcp__sketch__SendMessageToUsers: { recipientUserIds: ["user-2"], message: "hello" },
      mcp__sketch__UpdateInboxWorkflow: { inboxMessageId: "msg-1", metadata: { stage: "draft" } },
      mcp__sketch__ResolveInboxWorkflow: { inboxMessageId: "msg-1" },
      mcp__sketch__WriteAgentOutput: {
        outputDate: "2026-07-04",
        timezone: "Asia/Kolkata",
        masthead: { title: "Smoke", summary: "Smoke" },
        items: [],
      },
      mcp__sketch__TranscribeAudio: { file_path: join(workspace, "missing.mp3") },
      mcp__sketch__VisualAnalysis: { file_path: join(workspace, "missing.png"), question: "What is shown?" },
      mcp__sketch__getProviderConfig: {},
      mcp__sketch__Search: { source: "local", kind: "doc" },
      mcp__sketch__SearchEntities: { queries: ["alpha"] },
      mcp__sketch__GetEntityContext: { entityId: "entity-1", limit: 1 },
      mcp__sketch__GetFileContent: { fileId: "file-1" },
      mcp__sketch__WhatsAppGroupHistory: { sliceId: "slice-1" },
    } satisfies Record<string, Record<string, unknown>>;

    expect(Object.keys(smokeInputs).sort()).toEqual(Object.keys(tools).sort());

    for (const [toolName, input] of Object.entries(smokeInputs)) {
      const toolDefinition = tools[toolName] as SmokeTool | undefined;
      expect(toolDefinition?.inputSchema, toolName).toBeDefined();
      expect(toolDefinition?.inputSchema?.safeParse(input).success, toolName).toBe(true);
      const output = await toolDefinition?.execute?.(input, {} as never);
      await expect(
        Promise.resolve(toolDefinition?.toModelOutput?.({ toolCallId: `${toolName}-call`, input, output })),
        toolName,
      ).resolves.toMatchObject({
        type: "content",
        value: expect.any(Array),
      });
    }
  });
});
