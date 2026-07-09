import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VISUAL_ANALYSIS_AGENT_TOOL_NAME } from "@sketch/shared";
import { isImageFilePath } from "../permissions";
import {
  SHELL_PATH_EXPANSION_DENY_MESSAGE,
  containsShellPathExpansion,
  isCanvasCliFirstExecutableToken,
} from "../shell-command";
import type {
  AgentRuntimeAllowedRoot,
  AgentRuntimeContainmentAllowReason,
  AgentRuntimeRealpathContainmentDecision,
  AgentRuntimeWorkspaceToolScopePolicy,
} from "./contracts";

export interface AgentRuntimePathGuardInput {
  workspaceRoot: string;
  orgClaudeDir?: string | null;
  blockedReadPaths?: readonly string[];
  blockImageReads?: boolean;
  logger?: AgentRuntimePathGuardLogger;
}

export interface AgentRuntimeGuardedPath {
  inputPath: string;
  absolutePath: string;
  realpath: string;
  root: AgentRuntimeAllowedRoot;
}

export interface AgentRuntimeBashPathScanResult {
  behavior: "allow" | "deny";
  message?: string;
  blockedPath?: string;
}

export interface AgentRuntimePathGuardLogger {
  debug: (bindings: Record<string, unknown>, message: string) => void;
}

const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=:(<>])((?:\/[^\s"'`$|&;<>)]*)+)/g;
const SHELL_SCAN_TOKEN_PATTERN = /(&&|\|\||;|\r?\n)|'([^']*)'|"([^"]*)"|([^\s|&;<>]+)/g;
const GLOB_SYNTAX_PATTERN = /[*?[\]{}]/;

type ShellScanToken = { kind: "connector"; value: string } | { kind: "word"; value: string };

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = relative(dir, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rawAbsolutePath(filePath: string, cwd: string): string {
  if (isAbsolute(filePath)) return filePath;
  return `${cwd}${sep}${filePath}`;
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  try {
    await lstat(filePath);
    return await realpath(filePath);
  } catch {
    return null;
  }
}

export async function resolveRealpathWithExistingAncestor(filePath: string): Promise<string | null> {
  if (!isAbsolute(filePath)) return null;
  let currentPath: string = sep;
  const segments = filePath.split(/[\\/]+/).filter((segment) => segment.length > 0);

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      currentPath = dirname(currentPath);
      continue;
    }

    const candidate = currentPath === sep ? `${sep}${segment}` : join(currentPath, segment);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) return null;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        currentPath = candidate;
        continue;
      }
      return null;
    }

    if (stat.isSymbolicLink()) {
      try {
        currentPath = await realpath(candidate);
      } catch {
        return null;
      }
      continue;
    }

    currentPath = candidate;
  }

  return currentPath;
}

async function createAllowedRoot(
  kind: AgentRuntimeAllowedRoot["kind"],
  rootPath: string,
  options: { optional: true; logger?: AgentRuntimePathGuardLogger },
): Promise<AgentRuntimeAllowedRoot | null>;
async function createAllowedRoot(
  kind: AgentRuntimeAllowedRoot["kind"],
  rootPath: string,
  options?: { optional?: false; logger?: AgentRuntimePathGuardLogger },
): Promise<AgentRuntimeAllowedRoot>;
async function createAllowedRoot(
  kind: AgentRuntimeAllowedRoot["kind"],
  rootPath: string,
  options: { optional?: boolean; logger?: AgentRuntimePathGuardLogger } = {},
): Promise<AgentRuntimeAllowedRoot | null> {
  const absolutePath = resolve(rootPath);
  const rootRealpath = await realpathIfExists(absolutePath);
  if (!rootRealpath) {
    if (options.optional) {
      options.logger?.debug({ kind, path: absolutePath }, "Org Claude dir absent, skipping runtime tool root");
      return null;
    }
    throw new Error(`Runtime tool root does not exist or cannot be resolved: ${absolutePath}`);
  }
  return { kind, path: absolutePath, realpath: rootRealpath };
}

export async function createAgentRuntimeWorkspaceToolScopePolicy(
  input: AgentRuntimePathGuardInput,
): Promise<AgentRuntimeWorkspaceToolScopePolicy> {
  const workspaceRoot = await createAllowedRoot("workspace-root", input.workspaceRoot);
  const orgClaudeDir = input.orgClaudeDir
    ? await createAllowedRoot("org-claude-dir", input.orgClaudeDir, { optional: true, logger: input.logger })
    : null;
  const blockedReadPaths = await Promise.all(
    (input.blockedReadPaths ?? []).map(async (path) => {
      const resolved = await resolveRealpathWithExistingAncestor(rawAbsolutePath(path, workspaceRoot.path));
      return resolved ?? resolve(path);
    }),
  );

  return {
    allowedRoots: { workspaceRoot, orgClaudeDir },
    blockedReadPaths,
    blockImageReads: input.blockImageReads ?? false,
  };
}

function allowedRoots(scope: AgentRuntimeWorkspaceToolScopePolicy): AgentRuntimeAllowedRoot[] {
  return [scope.allowedRoots.workspaceRoot, scope.allowedRoots.orgClaudeDir].filter(
    (root): root is AgentRuntimeAllowedRoot => root !== null && root !== undefined,
  );
}

function allowReason(root: AgentRuntimeAllowedRoot): AgentRuntimeContainmentAllowReason {
  return root.kind === "workspace-root" ? "inside_workspace_root" : "inside_org_claude_dir";
}

export async function decideRuntimePathContainment(params: {
  path: string;
  cwd?: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<AgentRuntimeRealpathContainmentDecision> {
  const cwd = params.cwd ?? params.scope.allowedRoots.workspaceRoot.path;
  const absolutePath = rawAbsolutePath(params.path, cwd);
  const targetRealpath = await resolveRealpathWithExistingAncestor(absolutePath);

  if (!targetRealpath) {
    return {
      behavior: "deny",
      reason: "invalid_path",
      message: `Access denied: ${params.path} could not be resolved safely`,
    };
  }

  for (const root of allowedRoots(params.scope)) {
    if (isInsideDir(targetRealpath, root.realpath)) {
      return { behavior: "allow", targetRealpath, root, reason: allowReason(root) };
    }
  }

  return {
    behavior: "deny",
    targetRealpath,
    reason: "outside_allowed_roots",
    message: `Access denied: ${params.path} is outside the allowed workspace roots`,
  };
}

export async function guardRuntimePath(params: {
  path: string;
  cwd?: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<AgentRuntimeGuardedPath> {
  const cwd = params.cwd ?? params.scope.allowedRoots.workspaceRoot.path;
  const absolutePath = rawAbsolutePath(params.path, cwd);
  const decision = await decideRuntimePathContainment({ ...params, cwd });

  if (decision.behavior === "deny") {
    throw new Error(decision.message);
  }

  return {
    inputPath: params.path,
    absolutePath,
    realpath: decision.targetRealpath,
    root: decision.root,
  };
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function hasGlobSyntax(value: string): boolean {
  return GLOB_SYNTAX_PATTERN.test(value);
}

export function absoluteGlobBase(pattern: string): string {
  const segments = pattern.split("/");
  const baseSegments = [""];

  for (const segment of segments.slice(1)) {
    if (hasGlobSyntax(segment)) break;
    baseSegments.push(segment);
  }

  return baseSegments.length === 1 ? "/" : baseSegments.join("/");
}

export async function guardRuntimeGlob(params: {
  pattern: string;
  basePath?: string | null;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<void> {
  if (hasParentSegment(params.pattern)) {
    throw new Error("Access denied: Glob patterns must not contain parent directory segments");
  }

  if (params.basePath) {
    await guardRuntimePath({ path: params.basePath, scope: params.scope });
  }

  if (isAbsolute(params.pattern)) {
    await guardRuntimePath({ path: absoluteGlobBase(params.pattern), scope: params.scope });
  }
}

function extractAbsolutePaths(command: string): string[] {
  const paths = new Set<string>();
  for (const match of command.matchAll(ABSOLUTE_PATH_PATTERN)) {
    const candidate = match[1]?.replace(/[),.]+$/, "");
    if (candidate && !candidate.startsWith("//")) paths.add(candidate);
  }
  return Array.from(paths);
}

/**
 * Scans simple shell path tokens for defense-in-depth relative traversal checks.
 * This intentionally is not a complete shell parser: it does not expand variables,
 * command substitutions, eval-generated strings, aliases, functions, or structured
 * shell syntax. It covers bare and simply quoted argv-style tokens, redirection
 * targets, and cd-based cwd tracking across common command connectors, which
 * catches common file commands such as cat, ls, cp, mv, rm, head, tail, grep, and
 * shell redirects before the workspace shell can resolve `..` outside the runtime
 * cwd.
 */
function extractShellScanTokens(command: string): ShellScanToken[] {
  return Array.from(command.matchAll(SHELL_SCAN_TOKEN_PATTERN), (match) => {
    const connector = match[1];
    if (connector !== undefined) return { kind: "connector", value: connector };
    return { kind: "word", value: match[2] ?? match[3] ?? match[4] ?? "" };
  });
}

function shellPathToken(rawToken: string): string {
  const assignmentValueIndex = rawToken.indexOf("=");
  return (assignmentValueIndex > 0 ? rawToken.slice(assignmentValueIndex + 1) : rawToken).replace(/[),]+$/, "");
}

function hasUnexpandedShellSyntax(token: string): boolean {
  return token.includes("$") || token.includes("`");
}

function shouldScanRelativePathToken(token: string): boolean {
  if (!token || token.startsWith("-") || token.startsWith("$") || token.includes("$(") || token.includes("`")) {
    return false;
  }
  if (isAbsolute(token)) return false;
  return token === "." || token === ".." || token.startsWith("./") || token.startsWith("../") || token.includes("/");
}

function cdTarget(tokens: readonly ShellScanToken[], cdIndex: number): { target: string; index: number } | null {
  for (let index = cdIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.kind === "connector") return null;

    const target = shellPathToken(token.value);
    if (!target || target === "--" || target === "-L" || target === "-P") continue;
    return { target, index };
  }

  return null;
}

function bashPathDenyResult(blockedPath: string): AgentRuntimeBashPathScanResult {
  return {
    behavior: "deny",
    blockedPath,
    message: `Access denied: Bash commands must operate within the allowed workspace roots: ${blockedPath}`,
  };
}

function visualAnalysisBashDenyResult(blockedPath: string): AgentRuntimeBashPathScanResult {
  return {
    behavior: "deny",
    blockedPath,
    message: `Use ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} with this path instead of Bash: ${blockedPath}`,
  };
}

function shellTokenReferencesPath(command: string, candidate: string): boolean {
  const pattern = new RegExp(`(^|[^\\w./-])${escapeRegExp(candidate)}($|[^\\w./-])`);
  return pattern.test(command);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBlockedReadPathReference(params: {
  command: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): string | null {
  return (
    params.scope.blockedReadPaths.find((path) => {
      if (params.command.includes(path)) return true;
      const fileName = basename(path);
      return fileName.length > 0 && shellTokenReferencesPath(params.command, fileName);
    }) ?? null
  );
}

function isBlockedImageReadPath(params: {
  inputPath: string;
  targetRealpath: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): boolean {
  return params.scope.blockImageReads && (isImageFilePath(params.inputPath) || isImageFilePath(params.targetRealpath));
}

async function scanRelativePathTokensWithCwd(params: {
  command: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<AgentRuntimeBashPathScanResult | null> {
  const tokens = extractShellScanTokens(params.command);
  let cwd = params.scope.allowedRoots.workspaceRoot.realpath;
  let atCommandStart = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const scanToken = tokens[index];
    if (!scanToken) continue;

    if (scanToken.kind === "connector") {
      atCommandStart = true;
      continue;
    }

    const token = shellPathToken(scanToken.value);
    if (!token) continue;

    if (atCommandStart && token === "cd") {
      const cd = cdTarget(tokens, index);
      if (!cd || hasUnexpandedShellSyntax(cd.target)) {
        return bashPathDenyResult(cd?.target ?? "cd");
      }

      const decision = await decideRuntimePathContainment({
        path: cd.target,
        cwd,
        scope: params.scope,
      });
      if (decision.behavior === "deny") {
        return bashPathDenyResult(cd.target);
      }

      cwd = decision.targetRealpath;
      index = cd.index;
      atCommandStart = false;
      continue;
    }

    if (shouldScanRelativePathToken(token) || (params.scope.blockImageReads && isImageFilePath(token))) {
      const decision = await decideRuntimePathContainment({
        path: token,
        cwd,
        scope: params.scope,
      });
      if (decision.behavior === "deny") {
        return bashPathDenyResult(token);
      }
      if (params.scope.blockedReadPaths.includes(decision.targetRealpath)) {
        return visualAnalysisBashDenyResult(token);
      }
      if (isBlockedImageReadPath({ inputPath: token, targetRealpath: decision.targetRealpath, scope: params.scope })) {
        return visualAnalysisBashDenyResult(token);
      }
    }

    atCommandStart = false;
  }

  return null;
}

export async function scanRuntimeBashCommand(params: {
  command: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
  canvasCliEnvVar?: string;
}): Promise<AgentRuntimeBashPathScanResult> {
  const blockedPath = findBlockedReadPathReference({ command: params.command, scope: params.scope });
  if (blockedPath) {
    return visualAnalysisBashDenyResult(blockedPath);
  }

  if (params.canvasCliEnvVar && isCanvasCliFirstExecutableToken(params.command, params.canvasCliEnvVar)) {
    return { behavior: "allow" };
  }

  if (containsShellPathExpansion(params.command)) {
    return {
      behavior: "deny",
      blockedPath: params.command,
      message: SHELL_PATH_EXPANSION_DENY_MESSAGE,
    };
  }

  for (const absolutePath of extractAbsolutePaths(params.command)) {
    const scanPath = hasGlobSyntax(absolutePath) ? absoluteGlobBase(absolutePath) : absolutePath;
    const decision = await decideRuntimePathContainment({ path: scanPath, scope: params.scope });
    if (decision.behavior === "deny") {
      return {
        behavior: "deny",
        blockedPath: absolutePath,
        message: `Access denied: Bash commands must operate within the allowed workspace roots: ${absolutePath}`,
      };
    }
    if (params.scope.blockedReadPaths.includes(decision.targetRealpath)) {
      return visualAnalysisBashDenyResult(absolutePath);
    }
    if (
      isBlockedImageReadPath({ inputPath: absolutePath, targetRealpath: decision.targetRealpath, scope: params.scope })
    ) {
      return visualAnalysisBashDenyResult(absolutePath);
    }
  }

  const relativeScan = await scanRelativePathTokensWithCwd({ command: params.command, scope: params.scope });
  if (relativeScan) return relativeScan;

  return { behavior: "allow" };
}
