import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SketchMcpDeps } from "./types";

export function createProviderConfigTool(deps: Pick<SketchMcpDeps, "loadIntegrationProvider">) {
  return tool(
    "getProviderConfig",
    "Check if an integration provider is configured. Credentials and user scoping are injected automatically into integration CLI wrappers at runtime — never set API keys or email addresses manually.",
    {},
    async () => {
      if (!deps.loadIntegrationProvider) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ configured: false }) }],
        };
      }

      const provider = await deps.loadIntegrationProvider();
      if (!provider) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ configured: false }) }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              configured: true,
              type: provider.type,
            }),
          },
        ],
      };
    },
  );
}
