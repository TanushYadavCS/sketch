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
import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { VISUAL_ANALYSIS_AGENT_TOOL_NAME, cliSkillRequiredEnv } from "@sketch/shared";
import type { Logger } from "../logger";
import {
  SHELL_PATH_EXPANSION_DENY_MESSAGE,
  containsShellPathExpansion,
  isCanvasCliFirstExecutableToken,
} from "./shell-command";

export const PERMITTED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"];

export const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

export const READ_ONLY_FILE_TOOLS = ["Read", "Glob", "Grep"];

export interface CanUseToolOptions {
  agentAllowedTools?: string[] | null;
  agentEnv?: Record<string, string>;
  blockedReadPaths?: Iterable<string> | null;
  blockImageReads?: boolean;
}

export const IMAGE_FILE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

/**
 * Returns true when filePath is exactly dir or a child of dir.
 * Appends a trailing separator before the startsWith check so that
 * "/data/workspaces/u123" does not match "/data/workspaces/u1234".
 */
function isInsideDir(filePath: string, dir: string): boolean {
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function realpathExistingPath(filePath: string): string | null {
  try {
    return realpathSync.native(filePath);
  } catch {
    return null;
  }
}

function rawAbsolutePath(filePath: string, absWorkspace: string): string {
  if (isAbsolute(filePath)) return filePath;
  if (absWorkspace === "/") return `/${filePath}`;
  return `${absWorkspace}/${filePath}`;
}

function lexicalAbsolutePath(filePath: string, absWorkspace: string): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return resolve(absWorkspace, filePath);
}

/**
 * Canonicalizes file-tool paths by resolving each existing symlink before any
 * later `..` segment is applied. Missing tails are kept as string segments so
 * Write can target new paths, but every existing component is physically
 * resolved with OS realpath semantics.
 */
function canonicalizeFileToolPath(filePath: string, absWorkspace: string): string | null {
  const absolutePath = rawAbsolutePath(filePath, absWorkspace);
  let real = "/";

  for (const segment of absolutePath.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") {
      real = dirname(real);
      continue;
    }

    const candidate = join(real, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) return null;
      real = candidate;
      continue;
    }

    if (stat.isSymbolicLink()) {
      const resolved = realpathExistingPath(candidate);
      if (!resolved) return null;
      real = resolved;
      continue;
    }

    real = candidate;
  }

  return real;
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

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function absoluteGlobBase(pattern: string): string {
  const segments = pattern.split("/");
  const baseSegments = [""];

  for (const segment of segments.slice(1)) {
    if (hasGlobSyntax(segment)) break;
    baseSegments.push(segment);
  }

  return baseSegments.length === 1 ? "/" : baseSegments.join("/");
}

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(extname(filePath).toLowerCase());
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
  const lexicalAbsWorkspace = resolve(absWorkspace);
  const absClaudeDir = claudeDir ? resolve(claudeDir) : null;
  const realAbsWorkspace = realpathExistingPath(lexicalAbsWorkspace);
  const realAbsClaudeDir = absClaudeDir ? realpathExistingPath(absClaudeDir) : null;
  const configuredBlockedReadPaths = Array.from(options.blockedReadPaths ?? []);
  const blockedReadPaths = new Set(
    configuredBlockedReadPaths.map((path) => lexicalAbsolutePath(path, lexicalAbsWorkspace)),
  );
  const realBlockedReadPaths = new Set(
    configuredBlockedReadPaths
      .map((path) => canonicalizeFileToolPath(path, lexicalAbsWorkspace))
      .filter((path): path is string => path !== null),
  );
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

    if (toolName === "Skill" || toolName.endsWith("__Skill")) {
      const skillName = typeof input.skill === "string" ? input.skill.trim() : "";
      const requiredEnv = cliSkillRequiredEnv(skillName);
      const unavailable = requiredEnv.some((name) => !options.agentEnv?.[name]);
      if (unavailable) {
        return {
          behavior: "deny",
          message: `Skill "${skillName}" is unavailable because its integration is not connected. Reconnect it from Integrations in Sketch.`,
        };
      }
    }

    if (FILE_TOOLS.includes(toolName)) {
      const rawPath = (input.file_path as string) || (input.path as string) || absWorkspace;
      const filePath = lexicalAbsolutePath(rawPath, lexicalAbsWorkspace);
      const realFilePath = canonicalizeFileToolPath(rawPath, lexicalAbsWorkspace);
      const isInsideWorkspace =
        realFilePath !== null && realAbsWorkspace !== null && isInsideDir(realFilePath, realAbsWorkspace);
      const isInsideClaudeDir =
        realFilePath !== null && realAbsClaudeDir !== null && isInsideDir(realFilePath, realAbsClaudeDir);

      if (!isInsideWorkspace && !isInsideClaudeDir) {
        logger.warn({ toolName, filePath, realFilePath, absWorkspace }, "Blocked file access outside workspace");
        return {
          behavior: "deny",
          message: `Access denied: ${filePath} is outside your workspace ${absWorkspace}`,
        };
      }

      if (toolName === "Glob") {
        const pattern = input.pattern;
        if (typeof pattern === "string" && hasParentSegment(pattern)) {
          logger.warn({ toolName, pattern }, "Blocked Glob pattern with parent directory segment");
          return {
            behavior: "deny",
            message: `Access denied: Glob patterns must stay within your workspace ${absWorkspace}`,
          };
        }

        if (typeof pattern === "string" && isAbsolute(pattern)) {
          const patternBase = absoluteGlobBase(pattern);
          const realPatternBase = canonicalizeFileToolPath(patternBase, lexicalAbsWorkspace);
          const patternBaseInsideWorkspace =
            realPatternBase !== null && realAbsWorkspace !== null && isInsideDir(realPatternBase, realAbsWorkspace);
          const patternBaseInsideClaudeDir =
            realPatternBase !== null && realAbsClaudeDir !== null && isInsideDir(realPatternBase, realAbsClaudeDir);

          if (!patternBaseInsideWorkspace && !patternBaseInsideClaudeDir) {
            logger.warn({ toolName, pattern, patternBase, realPatternBase }, "Blocked Glob pattern outside workspace");
            return {
              behavior: "deny",
              message: `Access denied: Glob patterns must stay within your workspace ${absWorkspace}`,
            };
          }
        }
      }

      if (
        toolName === "Read" &&
        (blockedReadPaths.has(filePath) ||
          (realFilePath !== null && realBlockedReadPaths.has(realFilePath)) ||
          (options.blockImageReads &&
            (isImageFilePath(filePath) || (realFilePath !== null && isImageFilePath(realFilePath)))))
      ) {
        logger.warn({ toolName, filePath }, "Blocked Read on attachment that requires VisualAnalysis");
        return {
          behavior: "deny",
          message: `Direct image reads are not supported for this model. Use ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} with this exact path instead: ${filePath}. Do not use Read, Bash, cat, base64, or conversion workarounds for this image.`,
        };
      }
    }

    // Layer 3: bash path validation
    if (toolName === "Bash") {
      const command = (input.command as string) || "";
      for (const blockedPath of blockedReadPaths) {
        if (commandReferencesPath(command, blockedPath, lexicalAbsWorkspace)) {
          logger.warn({ toolName, blockedPath }, "Blocked Bash command on attachment that requires VisualAnalysis");
          return {
            behavior: "deny",
            message: `Use ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} with this path instead of Bash: ${blockedPath}`,
          };
        }
      }

      if (isCanvasCliFirstExecutableToken(command)) {
        return { behavior: "allow", updatedInput: input };
      }

      if (containsShellPathExpansion(command)) {
        logger.warn({ toolName, command, absWorkspace }, "Blocked bash command with shell path expansion");
        return {
          behavior: "deny",
          message: SHELL_PATH_EXPANSION_DENY_MESSAGE,
        };
      }

      const hasAbsolutePath = /(?:^|[\s<>])\/(?!dev\/null|tmp\/)/.test(command);
      if (
        hasAbsolutePath &&
        !command.includes(lexicalAbsWorkspace) &&
        !(absClaudeDir && command.includes(absClaudeDir))
      ) {
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
