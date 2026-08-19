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
    safeParse?(value: unknown): { success: boolean };
    validate?(value: unknown):
      | PromiseLike<{ success: boolean; value?: Record<string, unknown> }>
      | {
          success: boolean;
          value?: Record<string, unknown>;
        };
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

  it("keeps bounded question tools on web and exposes channels with a registered capability", async () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: false,
      visionAnalysisEnabled: false,
      visionConfig: null,
    });
    const webTools = await provider.createTools(params({ responseSurface: "web" }));
    const slackTools = await provider.createTools(params({ responseSurface: "slack" }));
    const enabledSlackTools = await provider.createTools(
      params({
        responseSurface: "slack",
        questionInteractionCapabilities: {
          available: true,
          interactiveSingleSelect: false,
          interactiveBatch: false,
          nativeCustomResponse: false,
          textFallback: true,
          cancelControl: false,
        },
      }),
    );
    const questionTool = webTools.mcp__sketch__AskUserQuestion as SmokeTool;
    const input = {
      questionId: "delivery-mode",
      question: "Where should the result go?",
      options: [
        { id: "slack", label: "Slack" },
        { id: "email", label: "Email" },
      ],
    };

    expect(questionTool).toBeDefined();
    expect(webTools.mcp__sketch__AskUserQuestions).toBeDefined();
    expect(slackTools.mcp__sketch__AskUserQuestion).toBeUndefined();
    expect(enabledSlackTools.mcp__sketch__AskUserQuestion).toBeDefined();
    expect(enabledSlackTools.mcp__sketch__AskUserQuestions).toBeDefined();
    await questionTool.execute?.(input, {} as never);
    expect(effects.drain(params({ responseSurface: "web" })).pendingQuestion).toEqual({
      id: "delivery-mode",
      prompt: "Where should the result go?",
      options: input.options,
    });
  });

  it("passes malformed agent output calls to the handler for rejection tracking", async () => {
    const effects = createAgentRuntimeCustomToolEffects();
    const provider = createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: false,
      visionAnalysisEnabled: false,
      visionConfig: null,
    });
    const recordRejectedAttempt = vi.fn();
    const write = vi.fn();
    const tools = await provider.createTools(params({ agentOutputWriter: { recordRejectedAttempt, write } }));
    const writeTool = tools.mcp__sketch__WriteAgentOutput as SmokeTool;
    const malformedInput = {
      outputDate: "2026-07-04",
      timezone: "UTC",
      masthead: { title: "", summary: "Summary" },
      items: [],
    };

    const validation = await writeTool.inputSchema?.validate?.(malformedInput);
    expect(validation).toEqual({ success: true, value: malformedInput });
    await expect(writeTool.execute?.(validation?.value ?? malformedInput, {} as never)).rejects.toThrow();
    expect(recordRejectedAttempt).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
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
      mcp__sketch__SearchDeliveryTargets: { query: "alpha", limit: 1 },
      mcp__sketch__local_run_command: { command: "pwd" },
      mcp__sketch__local_claude_session: { action: "list" },
      mcp__sketch__ManageScheduledTasks: { action: "list" },
      mcp__sketch__ManageAutomationShares: { action: "list", task_id: "task-1" },
      mcp__sketch__ListFollowups: {},
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
    } satisfies Record<string, Record<string, unknown>>;

    expect(Object.keys(smokeInputs).sort()).toEqual(Object.keys(tools).sort());

    for (const [toolName, input] of Object.entries(smokeInputs)) {
      const toolDefinition = tools[toolName] as SmokeTool | undefined;
      expect(toolDefinition?.inputSchema, toolName).toBeDefined();
      const validation = toolDefinition?.inputSchema?.safeParse
        ? toolDefinition.inputSchema.safeParse(input)
        : await toolDefinition?.inputSchema?.validate?.(input);
      expect(validation?.success, toolName).toBe(true);
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
