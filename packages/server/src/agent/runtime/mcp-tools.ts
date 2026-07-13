import { type MCPClient, createMCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { RunAgentParams } from "../runner";
import type { AgentRuntimeMcpToolProvider } from "./contracts";

function namespacedMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function agentAllowsTool(agentAllowedTools: string[] | null | undefined, toolName: string): boolean {
  return agentAllowedTools == null || agentAllowedTools.includes(toolName);
}

function agentAllowsServer(agentAllowedTools: string[] | null | undefined, serverName: string): boolean {
  return agentAllowedTools == null || agentAllowedTools.some((toolName) => toolName.startsWith(`mcp__${serverName}__`));
}

export class DefaultAgentRuntimeMcpToolProvider implements AgentRuntimeMcpToolProvider {
  private readonly clients: MCPClient[] = [];

  async createTools(params: RunAgentParams): Promise<ToolSet> {
    const tools: ToolSet = {};
    const servers = params.integrationMcpServers;
    if (!servers) return tools;

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (!agentAllowsServer(params.agentAllowedTools, serverName)) continue;

      let client: MCPClient | null = null;
      try {
        client = await createMCPClient({
          transport: {
            type: serverConfig.type,
            url: serverConfig.url,
            headers: serverConfig.headers,
          },
          onUncaughtError: (err) => {
            params.logger.warn({ err, mcpServerName: serverName }, "Integration MCP client uncaught error");
          },
        });
        const serverTools = await client.tools();
        this.clients.push(client);
        client = null;

        for (const [toolName, toolDefinition] of Object.entries(serverTools)) {
          const namespacedName = namespacedMcpToolName(serverName, toolName);
          if (!agentAllowsTool(params.agentAllowedTools, namespacedName)) continue;
          tools[namespacedName] = toolDefinition as ToolSet[string];
        }
      } catch (err) {
        params.logger.warn({ err, mcpServerName: serverName }, "Failed to connect integration MCP server");
        await client?.close().catch((closeErr) => {
          params.logger.warn({ err: closeErr, mcpServerName: serverName }, "Failed to close failed MCP client");
        });
      }
    }

    return tools;
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.clients.splice(0).map((client) => client.close()));
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected.length > 0) {
      throw new AggregateError(
        rejected.map((result) => result.reason),
        "Failed to close one or more integration MCP clients",
      );
    }
  }
}

export function createDefaultAgentRuntimeMcpToolProvider(): AgentRuntimeMcpToolProvider {
  return new DefaultAgentRuntimeMcpToolProvider();
}
