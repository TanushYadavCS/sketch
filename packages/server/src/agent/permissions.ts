/**
 * Workspace isolation via canUseTool — factory function that creates the
 * permission callback for the Claude Agent SDK's query().
 *
 * Three security layers:
 * 1. Tool allowlist — only permitted tools can execute
 * 2. File path validation — file tools restricted to workspace + ~/.claude (read-write).
 * 3. Bash path validation — commands blocked if they reference absolute paths outside
 *    workspace/~/.claude.
 */
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { VISUAL_ANALYSIS_AGENT_TOOL_NAME } from "@sketch/shared";
import type { Logger } from "../logger";

export const PERMITTED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"];

export const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

export const READ_ONLY_FILE_TOOLS = ["Read", "Glob", "Grep"];

export interface CanUseToolOptions {
  agentAllowedTools?: string[] | null;
  blockedReadPaths?: Iterable<string> | null;
}

/**
 * Returns true when filePath is exactly dir or a child of dir.
 * Appends a trailing separator before the startsWith check so that
 * "/data/workspaces/u123" does not match "/data/workspaces/u1234".
 */
function isInsideDir(filePath: string, dir: string): boolean {
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandWords(command: string): string[] {
  return Array.from(
    command.matchAll(/'([^']*)'|"([^"]*)"|([^\s|&;<>]+)/g),
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

function hasGlobSyntax(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function matchesBlockedPathPattern(pattern: string, blockedPath: string, relativeBlockedPath: string): boolean {
  const normalizedPattern = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  if (isAbsolute(normalizedPattern)) return matchesGlob(blockedPath, normalizedPattern);
  return matchesGlob(relativeBlockedPath, normalizedPattern);
}

function commandReferencesPath(command: string, filePath: string, absWorkspace: string): boolean {
  const candidates = new Set([filePath]);
  const relativePath = relative(absWorkspace, filePath);
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    candidates.add(relativePath);
    candidates.add(`./${relativePath}`);
  }

  for (const candidate of candidates) {
    const pattern = new RegExp(`(^|[^\\w./-])${escapeRegExp(candidate)}($|[^\\w./-])`);
    if (pattern.test(command)) return true;
  }

  for (const word of commandWords(command)) {
    if (hasGlobSyntax(word) && matchesBlockedPathPattern(word, filePath, relativePath)) return true;
  }

  return false;
}

export function createCanUseTool(
  absWorkspace: string,
  logger: Logger,
  claudeDir: string | undefined,
  options: CanUseToolOptions = {},
) {
  const absClaudeDir = claudeDir ? resolve(claudeDir) : null;
  const blockedReadPaths = new Set(Array.from(options.blockedReadPaths ?? [], (path) => resolve(path)));
  /**
   * NULL/undefined = no allowlist (legacy or non-agent run). Empty array =
   * deny every tool. Non-empty array = the canonical allowlist. Distinguishing
   * NULL from `[]` matters: an admin who unselects all tools must not silently
   * grant every MCP tool.
   */
  const agentAllowlist = options.agentAllowedTools ? new Set(options.agentAllowedTools) : null;

  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    logger.debug({ toolName }, "canUseTool called");

    if (!PERMITTED_TOOLS.includes(toolName) && !toolName.startsWith("mcp__")) {
      return { behavior: "deny", message: `Tool ${toolName} is not allowed` };
    }

    if (agentAllowlist && !agentAllowlist.has(toolName)) {
      logger.warn({ toolName }, "Blocked tool call outside agent allowlist");
      return { behavior: "deny", message: `Tool ${toolName} is not in this agent's allowlist` };
    }

    if (FILE_TOOLS.includes(toolName)) {
      const rawPath = (input.file_path as string) || (input.path as string) || absWorkspace;
      const filePath = resolve(rawPath);
      if (!isInsideDir(filePath, absWorkspace)) {
        if (absClaudeDir && isInsideDir(filePath, absClaudeDir)) {
          return { behavior: "allow", updatedInput: input };
        }
        logger.warn({ toolName, filePath, absWorkspace }, "Blocked file access outside workspace");
        return {
          behavior: "deny",
          message: `Access denied: ${filePath} is outside your workspace ${absWorkspace}`,
        };
      }

      if (toolName === "Read" && blockedReadPaths.has(filePath)) {
        logger.warn({ toolName, filePath }, "Blocked Read on attachment that requires VisualAnalysis");
        return {
          behavior: "deny",
          message: `Use ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} with this path instead of Read: ${filePath}`,
        };
      }
    }

    // Layer 3: bash path validation
    if (toolName === "Bash") {
      const command = (input.command as string) || "";
      for (const blockedPath of blockedReadPaths) {
        if (commandReferencesPath(command, blockedPath, absWorkspace)) {
          logger.warn({ toolName, blockedPath }, "Blocked Bash command on attachment that requires VisualAnalysis");
          return {
            behavior: "deny",
            message: `Use ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} with this path instead of Bash: ${blockedPath}`,
          };
        }
      }

      // Temporary broad carveout: CANVAS_CLI is a brokered launcher created by
      // Sketch, and Canvas CLI commands commonly carry JSON/text values that
      // trip the generic path scanner. Revisit with a structured shell parser.
      if (command.includes("CANVAS_CLI")) {
        return { behavior: "allow", updatedInput: input };
      }

      const hasAbsolutePath = /(?:^|\s)\/(?!dev\/null|tmp\/)/.test(command);
      if (hasAbsolutePath && !command.includes(absWorkspace) && !(absClaudeDir && command.includes(absClaudeDir))) {
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
