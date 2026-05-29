import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { SketchMcpDeps } from "./types";

export function createSendFileToChatTool(deps: Pick<SketchMcpDeps, "uploadCollector">, absWorkspace: string) {
  return tool(
    "SendFileToChat",
    "Queue a file from the workspace to be sent back to the user in chat. The file must exist within your workspace directory. Create the file first using Write or Bash, then call this tool with the absolute path.",
    { file_path: z.string().describe("Absolute path to the file within your workspace") },
    async ({ file_path }) => {
      const absPath = resolve(file_path);

      if (!absPath.startsWith(absWorkspace)) {
        return {
          content: [{ type: "text" as const, text: `Error: file must be within your workspace ${absWorkspace}` }],
        };
      }

      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `Error: file not found at ${absPath}` }],
        };
      }

      deps.uploadCollector.collect(absPath);
      return {
        content: [{ type: "text" as const, text: `File queued for upload: ${absPath}` }],
      };
    },
  );
}
