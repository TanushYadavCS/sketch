/**
 * Workspace isolation via canUseTool — factory function that creates the
 * permission callback for the Claude Agent SDK's query().
 *
 * Four security layers:
 * 1. Tool allowlist — only permitted tools can execute
 * 2. File path validation — file tools restricted to workspace + ~/.claude (read-write).
 *    Layer 2 also implicitly covers file-tool reads of /tmp/sketch-int-* (wrapper files
 *    live outside the workspace and outside ~/.claude, so they're denied here).
 * 3. Credential wrapper Bash isolation — block Bash read-style commands whose target
 *    path contains /sketch-int- (e.g. `cat /tmp/sketch-int-canvas-xxx.sh`), while
 *    allowing execution with downstream output truncation (e.g. `$CANVAS_CLI | head`).
 * 4. Bash path validation — commands blocked if they reference absolute paths outside
 *    workspace/~/.claude.
 */
import { resolve } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger";

export const PERMITTED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"];

export const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

export const READ_ONLY_FILE_TOOLS = ["Read", "Glob", "Grep"];

/**
 * Matches Bash commands that attempt to read a credential wrapper file with a
 * read-style tool. The key constraint is `[^|;&]*` between the read command
 * name and `/sketch-int-`: it ensures the wrapper path is on the SAME side of
 * any command separator as the read command.
 *
 * Blocks: `cat /tmp/sketch-int-canvas-xxx.sh`, `head -n 5 /tmp/sketch-int-...`,
 *         `grep SECRET /tmp/sketch-int-...`, `foo && cat /tmp/sketch-int-...`,
 *         `xxd /tmp/sketch-int-...`, `cat < /tmp/sketch-int-...`.
 * Allows: `$CANVAS_CLI action list | head -c 2000` (head is after the pipe —
 *         it's truncating wrapper OUTPUT, not reading the wrapper FILE),
 *         `sh /tmp/sketch-int-...` (executing the wrapper — `sh` isn't in the
 *         read-command list), `env | grep CANVAS` (no /sketch-int- path).
 *
 * Known gaps accepted as out-of-scope for this layer:
 * - Glob expansion: `cat /tmp/*int*.sh` won't match (no literal /sketch-int-).
 * - `echo "cat /tmp/sketch-int-..."`: false positive, just printing a string.
 */
const WRAPPER_READ_RE =
  /\b(cat|head|tail|less|more|bat|xxd|od|hexdump|strings|file|stat|awk|sed|grep|dd|tac|nl|rev|cp|mv|cmp|diff|base64|vi|vim|nano|emacs|ed)\b[^|;&]*\/sketch-int-/;

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

    // Layer 3: block Bash read-style commands targeting credential wrapper files.
    // (FILE_TOOLS reads of /tmp/sketch-int-* are already denied by Layer 2 because
    // the wrapper files live outside the workspace and outside ~/.claude.)
    if (toolName === "Bash") {
      const command = (input.command as string) || "";
      if (WRAPPER_READ_RE.test(command)) {
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
