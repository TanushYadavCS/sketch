import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../../db/schema";
import { createTestDb, createTestLogger } from "../../test-utils";
import { type RunAgentParams, runAgent } from "../runner";
import { createDefaultAgentRuntimeMcpToolProvider } from "./mcp-tools";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import type { AgentRuntimeProvider } from "./provider";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface TestMcpServer {
  url: string;
  requests: string[];
  toolCalls: unknown[];
  deleteRequests: () => number;
  close: () => Promise<void>;
}

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

async function readJson(req: IncomingMessage): Promise<JsonRpcRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, {
    "content-type": "application/json",
    "mcp-session-id": "test-session",
  });
  res.end(JSON.stringify(body));
}

async function createTestMcpServer(): Promise<TestMcpServer> {
  const requests: string[] = [];
  const toolCalls: unknown[] = [];
  let deleteRequests = 0;
  let closed = false;

  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);

    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      deleteRequests += 1;
      res.writeHead(202);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const body = await readJson(req);
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    if (body.method === "initialize") {
      writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp", version: "1.0.0" },
        },
      });
      return;
    }

    if (body.method === "tools/list") {
      writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo a message",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
          ],
        },
      });
      return;
    }

    if (body.method === "tools/call") {
      toolCalls.push(body.params);
      const params = body.params ?? {};
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: `echo:${String(args.message)}` }],
        },
      });
      return;
    }

    writeJson(res, {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Method not found" },
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test MCP server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    toolCalls,
    deleteRequests: () => deleteRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function toolNames(model: MockLanguageModelV4): string[] {
  return (model.doStreamCalls[0]?.tools ?? []).map((tool) => String(tool.name)).sort();
}

describe("DefaultAgentRuntimeMcpToolProvider", () => {
  let db: Kysely<DB>;
  let workspace: string;
  let servers: TestMcpServer[];

  beforeEach(async () => {
    db = await createTestDb();
    workspace = await mkdtemp(join(tmpdir(), "sketch-mcp-tools-"));
    await mkdir(join(workspace, "notes"));
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
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

  it("connects to HTTP MCP servers, namespaces tools, calls the remote tool, and closes the client", async () => {
    const server = await createTestMcpServer();
    servers.push(server);
    const provider = createDefaultAgentRuntimeMcpToolProvider();

    const tools = await provider.createTools(
      makeRunParams(textModel(), {
        integrationMcpServers: { canvas: { type: "http", url: server.url } },
      }),
    );

    expect(Object.keys(tools)).toEqual(["mcp__canvas__echo"]);
    const execute = tools.mcp__canvas__echo?.execute as
      | ((input: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => Promise<unknown>)
      | undefined;
    expect(execute).toBeTypeOf("function");
    await expect(execute?.({ message: "hello" }, {})).resolves.toMatchObject({
      content: [{ type: "text", text: "echo:hello" }],
    });
    expect(server.toolCalls).toEqual([{ name: "echo", arguments: { message: "hello" } }]);

    await provider.close?.();

    expect(server.deleteRequests()).toBeGreaterThan(0);
  });

  it("skips remote MCP connection when the explicit allowlist has no tools for that server", async () => {
    const server = await createTestMcpServer();
    servers.push(server);
    const provider = createDefaultAgentRuntimeMcpToolProvider();

    const tools = await provider.createTools(
      makeRunParams(textModel(), {
        agentAllowedTools: ["Read"],
        integrationMcpServers: { canvas: { type: "http", url: server.url } },
      }),
    );

    expect(Object.keys(tools)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("lets the agent call a namespaced integration MCP tool", async () => {
    const server = await createTestMcpServer();
    servers.push(server);
    const model = new MockLanguageModelV4({
      provider: "mock-anthropic",
      modelId: "claude-sonnet-4-6",
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "tool-mcp",
                toolName: "mcp__canvas__echo",
                input: JSON.stringify({ message: "from-agent" }),
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
              { type: "text-delta", id: "text-1", delta: "called mcp" },
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
        integrationMcpServers: { canvas: { type: "http", url: server.url } },
      }),
    );

    expect(toolNames(model)).toContain("mcp__canvas__echo");
    expect(server.toolCalls).toEqual([{ name: "echo", arguments: { message: "from-agent" } }]);
    expect(result.trace.finalText).toBe("called mcp");
    expect(result.trace.progressEvents).toContainEqual({
      kind: "tool_use",
      toolName: "mcp__canvas__echo",
      input: { message: "from-agent" },
    });
    expect(server.deleteRequests()).toBeGreaterThan(0);
  });

  it("degrades gracefully when an integration MCP server is down", async () => {
    const server = await createTestMcpServer();
    servers.push(server);
    const url = server.url;
    await server.close();
    const model = textModel("still done");

    const result = await runAgent(
      makeRunParams(model, {
        integrationMcpServers: { canvas: { type: "http", url } },
      }),
    );

    expect(result.trace.finalText).toBe("still done");
    expect(toolNames(model)).not.toContain("mcp__canvas__echo");
  });
});
