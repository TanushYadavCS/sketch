import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { type RunAgentParams, runAgent } from "./runner";
import {
  createAgentRuntimeCustomToolEffects,
  createDefaultAgentRuntimeCustomToolProvider,
} from "./runtime/custom-tools";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./runtime/pricing";
import type { AgentRuntimeProvider } from "./runtime/provider";
import { createSketchMcpToolDefinitions } from "./sketch-tools";
import { type SketchMcpDeps, UploadCollector } from "./tools/types";

interface RuntimeTool {
  execute?: (input: Record<string, unknown>, options: never) => Promise<unknown>;
}

interface SketchToolDefinition {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
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

function toolThenTextModel(toolName: string, input: Record<string, unknown>, text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: `tool-${toolName}`,
              toolName,
              input: JSON.stringify(input),
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

describe("agent admin file parity", () => {
  let db: Kysely<DB>;
  let workspace: string;
  let adminId: string;
  let memberId: string;

  beforeEach(async () => {
    db = await createTestDb();
    workspace = await mkdtemp(join(tmpdir(), "sketch-admin-file-parity-"));
    const users = createUserRepository(db);
    const admin = await users.create({
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
      authRole: "admin",
    });
    const member = await users.create({
      name: "Member",
      email: "member@example.com",
      emailVerified: true,
      authRole: "member",
    });
    adminId = admin.id;
    memberId = member.id;

    const now = new Date("2026-08-26T00:00:00.000Z").toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg-admin-parity",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .execute();
    await db
      .insertInto("access_scopes")
      .values([
        {
          id: "scope-member",
          connector_config_id: "cfg-admin-parity",
          scope_type: "drive",
          provider_scope_id: "member-drive",
        },
        {
          id: "scope-private",
          connector_config_id: "cfg-admin-parity",
          scope_type: "drive",
          provider_scope_id: "private-drive",
        },
      ])
      .execute();
    await db
      .insertInto("access_scope_members")
      .values({ access_scope_id: "scope-member", principal_type: "email", principal_value: "member@example.com" })
      .execute();
    await db
      .insertInto("indexed_files")
      .values([
        {
          id: "file-member",
          connector_config_id: "cfg-admin-parity",
          provider_file_id: "provider-member",
          file_name: "Member visible project",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "Member readable planning notes",
          synced_at: now,
          source_updated_at: now,
          access_scope_id: "scope-member",
        },
        {
          id: "file-private",
          connector_config_id: "cfg-admin-parity",
          provider_file_id: "provider-private",
          file_name: "Private Bob project",
          file_type: "doc",
          content_category: "document",
          source: "google_drive",
          content: "Private Bob payload",
          synced_at: now,
          source_updated_at: now,
          access_scope_id: "scope-private",
        },
      ])
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "entity-private",
        name: "Private Bob",
        source_type: "project",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_mentions")
      .values({
        id: "mention-private",
        entity_id: "entity-private",
        indexed_file_id: "file-private",
        chunk_index: 0,
        context_snippet: "Private Bob context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    await rm(workspace, { recursive: true, force: true });
  });

  function toolDeps(currentUserId: string, adminReadAllEnabled: boolean): SketchMcpDeps {
    return {
      uploadCollector: new UploadCollector(),
      workspaceDir: workspace,
      db,
      userRepo: createUserRepository(db),
      currentUserId,
      adminReadAllEnabled,
      slackEntitySyncEnabled: true,
      logger: createTestLogger(),
    };
  }

  function runParams(model: LanguageModel, currentUserId: string, userName: string, userEmail: string): RunAgentParams {
    return {
      db,
      workspaceKey: "channel-admin-parity",
      threadTs: "group-thread",
      userMessage: "search private bob",
      workspaceDir: workspace,
      userName,
      userEmail,
      logger: createTestLogger(),
      platform: "slack",
      contextType: "channel_mention",
      currentUserId,
      userRepo: createUserRepository(db),
      isAdminReadAllEnabled: async () => true,
      onProgressEvent: vi.fn().mockResolvedValue(undefined),
      agentRuntime: "aisdk",
      agentRuntimeProvider: mockProvider(model),
    };
  }

  it("lets an interactive admin content run search, read, contextualize, and discover inaccessible files", async () => {
    const deps = toolDeps(adminId, true);
    const definitions = createSketchMcpToolDefinitions(deps) as SketchToolDefinition[];
    const callSketchTool = async (name: string, input: Record<string, unknown>) => {
      const definition = definitions.find((tool) => tool.name === name);
      if (!definition) throw new Error(`Missing tool ${name}`);
      return definition.handler(input, {});
    };

    await expect(callSketchTool("Search", { query: "Private Bob", limit: 5 })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("Private Bob project") })],
    });
    await expect(callSketchTool("GetFileContent", { fileId: "file-private" })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("Private Bob payload") })],
    });
    await expect(callSketchTool("GetEntityContext", { entityId: "entity-private", limit: 5 })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("Private Bob context") })],
    });

    const effects = createAgentRuntimeCustomToolEffects();
    const aiSdkTools = await createDefaultAgentRuntimeCustomToolProvider({
      effects,
      transcriptionEnabled: false,
      visionAnalysisEnabled: false,
      visionConfig: null,
      adminReadAllEnabled: true,
    }).createTools(runParams(textModel(), adminId, "Admin", "admin@example.com"));
    const searchEntities = aiSdkTools.mcp__sketch__SearchEntities as RuntimeTool;

    await expect(searchEntities.execute?.({ queries: ["Private Bob"] }, {} as never)).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("entity-private") })],
    });

    const memberDefinitions = createSketchMcpToolDefinitions(toolDeps(memberId, false)) as SketchToolDefinition[];
    const memberSearchEntities = memberDefinitions.find((tool) => tool.name === "SearchEntities");
    if (!memberSearchEntities) throw new Error("Missing tool SearchEntities");
    await expect(memberSearchEntities.handler({ queries: ["Private Bob"] }, {})).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("entity-private") })],
    });
  });

  it("keeps a member search filtered while replaying prior admin tool output in the same group session", async () => {
    const adminModel = toolThenTextModel("mcp__sketch__Search", { query: "Private Bob", limit: 5 }, "admin turn done");
    const memberModel = toolThenTextModel(
      "mcp__sketch__Search",
      { query: "Private Bob", limit: 5 },
      "member turn done",
    );

    await runAgent(runParams(adminModel, adminId, "Admin", "admin@example.com"));
    const memberResult = await runAgent(runParams(memberModel, memberId, "Member", "member@example.com"));

    expect(JSON.stringify(memberModel.doStreamCalls[0]?.prompt)).toContain("Private Bob project");
    const memberPrompt = memberModel.doStreamCalls[1]?.prompt as Array<{ role: string }>;
    const memberToolResult = JSON.stringify(memberPrompt?.at(-1));
    expect(memberToolResult).toContain("entity-private");
    expect(memberToolResult).not.toContain("file-private");
    expect(memberToolResult).not.toContain("Private Bob project");
    expect(memberResult.trace.finalText).toBe("member turn done");
  });
});
