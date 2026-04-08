/**
 * Workspace isolation via canUseTool — factory function that creates the
 * permission callback for the Claude Agent SDK's query().
 *
 * Four security layers:
 * 1. Tool allowlist — only permitted tools can execute
 * 2. File path validation — file tools restricted to workspace + ~/.claude (read-write)
 * 3. Credential wrapper isolation — block reading /tmp/sketch-int-* wrapper files
 * 4. Bash path validation — commands blocked if they reference absolute paths outside workspace/~/.claude
 */
import { resolve } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger";

export const PERMITTED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"];

export const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

export const READ_ONLY_FILE_TOOLS = ["Read", "Glob", "Grep"];

/**
 * Returns true when filePath is exactly dir or a child of dir.
 * Appends a trailing separator before the startsWith check so that
 * "/data/workspaces/u123" does not match "/data/workspaces/u1234".
 */
function isInsideDir(filePath: string, dir: string): boolean {
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

export function createCanUseTool(absWorkspace: string, logger: Logger, claudeDir: string) {
  const absClaudeDir = resolve(claudeDir);

  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    logger.debug({ toolName }, "canUseTool called");

    if (!PERMITTED_TOOLS.includes(toolName) && !toolName.startsWith("mcp__")) {
      return { behavior: "deny", message: `Tool ${toolName} is not allowed` };
    }

    if (FILE_TOOLS.includes(toolName)) {
      const rawPath = (input.file_path as string) || (input.path as string) || absWorkspace;
      const filePath = resolve(rawPath);
      if (!isInsideDir(filePath, absWorkspace)) {
        if (isInsideDir(filePath, absClaudeDir)) {
          return { behavior: "allow", updatedInput: input };
        }
        logger.warn({ toolName, filePath, absWorkspace }, "Blocked file access outside workspace");
        return {
          behavior: "deny",
          message: `Access denied: ${filePath} is outside your workspace ${absWorkspace}`,
        };
      }
    }

    // Layer 3: block reading credential wrapper files
    if (FILE_TOOLS.includes(toolName)) {
      const rawPath = (input.file_path as string) || (input.path as string) || "";
      if (rawPath.includes("/tmp/sketch-int-")) {
        logger.warn({ toolName, rawPath }, "Blocked read of integration credential wrapper");
        return { behavior: "deny", message: "Access denied: cannot read integration credential files" };
      }
    }
    if (toolName === "Bash") {
      const command = (input.command as string) || "";
      if (/sketch-int-/.test(command) && /cat |head |tail |less |more |bat |vi |vim |nano /.test(command)) {
        logger.warn({ toolName, command }, "Blocked bash read of integration credential wrapper");
        return { behavior: "deny", message: "Access denied: cannot read integration credential files" };
      }
    }

    // Layer 4: bash path validation
    if (toolName === "Bash") {
      const command = (input.command as string) || "";
      const hasAbsolutePath = /(?:^|\s)\/(?!dev\/null|tmp\/)/.test(command);
      if (hasAbsolutePath && !command.includes(absWorkspace) && !command.includes(absClaudeDir)) {
        logger.warn({ toolName, command, absWorkspace }, "Blocked bash command referencing outside paths");
        return {
          behavior: "deny",
          message: `Access denied: bash commands must operate within your workspace ${absWorkspace}`,
        };
      }
    }

    return { behavior: "allow", updatedInput: input };
  };
}
