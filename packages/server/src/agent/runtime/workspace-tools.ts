import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, matchesGlob, relative } from "node:path";
import type {
  BashInput,
  BashOutput,
  FileEditInput,
  FileEditOutput,
  FileReadInput,
  FileReadOutput,
  FileWriteInput,
  FileWriteOutput,
  GlobInput,
  GlobOutput,
  GrepInput,
  GrepOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { VISUAL_ANALYSIS_AGENT_TOOL_NAME } from "@sketch/shared";
import { rgPath } from "@vscode/ripgrep";
import { type JSONValue, type Tool, type ToolSet, tool } from "ai";
import { z } from "zod/v4";
import type { Logger } from "../../logger";
import { isImageFilePath } from "../permissions";
import type { AgentRuntimeWorkspaceToolName, AgentRuntimeWorkspaceToolScopePolicy } from "./contracts";
import {
  type AgentRuntimeGuardedPath,
  absoluteGlobBase,
  guardRuntimeGlob,
  guardRuntimePath,
  scanRuntimeBashCommand,
} from "./path-guard";

export interface AgentRuntimeWorkspaceToolDeps {
  scope: AgentRuntimeWorkspaceToolScopePolicy;
  toolNames?: readonly AgentRuntimeWorkspaceToolName[];
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Logger, "debug">;
}

type ToolToModelOutput = NonNullable<Tool["toModelOutput"]>;

const DEFAULT_TOOL_NAMES: readonly AgentRuntimeWorkspaceToolName[] = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_BASH_OUTPUT_LIMIT_BYTES = 24_000;
const MAX_LIVE_OUTPUT_BUFFER_BYTES = DEFAULT_BASH_OUTPUT_LIMIT_BYTES * 8;
const DEFAULT_GREP_HEAD_LIMIT = 250;
const DEFAULT_READ_LINE_LIMIT = 2_000;
const DEFAULT_READ_LINE_CHAR_LIMIT = 2_000;
const DEFAULT_RG_TIMEOUT_MS = 120_000;
const PROCESS_KILL_GRACE_MS = 2_000;
const LONG_LINE_TRUNCATION_MARKER = "[sketch runtime line truncated]";
export const AGENT_RUNTIME_BASH_TRUNCATION_MARKER = "\n[sketch runtime output truncated]\n";
export const AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS = {
  Bash: "Phase 3a runs foreground shell commands only; SDK background-task inputs/outputs are deferred, and dangerouslyDisableSandbox is intentionally unsupported because this runtime has no OS sandbox to disable.",
  Read: "Phase 3a reads capped UTF-8 text files with offset/limit and returns native image blocks when image reads are allowed; SDK PDF/notebook output variants are deferred.",
  Write:
    "Phase 3a returns the SDK-required write fields; gitDiff and permission-dialog userModified metadata are deferred.",
  Edit: "Phase 3a preserves SDK uniqueness/not-found semantics and required output fields; gitDiff metadata is deferred.",
  Glob: "Phase 3a uses vendored ripgrep for SDK-style ignore-aware matching, then applies runtime containment and read-policy filtering before the SDK's 100-result cap.",
  Grep: "Phase 3a uses vendored ripgrep for SDK-style regex, multiline, type-registry, ignore-aware, and output-window behavior with runtime containment post-filtering.",
} satisfies Record<AgentRuntimeWorkspaceToolName, string>;

try {
  accessSync(rgPath);
} catch (error) {
  throw new Error(`Vendored ripgrep binary is unavailable at ${rgPath}`, { cause: error });
}

let rgPathLogged = false;

function enabledToolNames(input?: readonly AgentRuntimeWorkspaceToolName[]): Set<AgentRuntimeWorkspaceToolName> {
  return new Set(input ?? DEFAULT_TOOL_NAMES);
}

function assertReadAllowed(path: AgentRuntimeGuardedPath, scope: AgentRuntimeWorkspaceToolScopePolicy): void {
  if (
    scope.blockedReadPaths.includes(path.realpath) ||
    (scope.blockImageReads &&
      (isImageFilePath(path.inputPath) || isImageFilePath(path.absolutePath) || isImageFilePath(path.realpath)))
  ) {
    throw new Error(
      `Direct image reads are not supported for this model. Use ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} with this exact path instead: ${path.absolutePath}. Do not use Read, Bash, cat, base64, or conversion workarounds for this image.`,
    );
  }
}

function canReadPath(path: AgentRuntimeGuardedPath, scope: AgentRuntimeWorkspaceToolScopePolicy): boolean {
  try {
    assertReadAllowed(path, scope);
    return true;
  } catch {
    return false;
  }
}

function truncateOutput(value: string, limitBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limitBytes) return value;
  return `${bytes.subarray(0, limitBytes).toString("utf8")}${AGENT_RUNTIME_BASH_TRUNCATION_MARKER}`;
}

async function runBash(params: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimitBytes: number;
  abortSignal?: AbortSignal;
}): Promise<BashOutput> {
  return await new Promise<BashOutput>((resolvePromise, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLiveTruncated = false;
    let stderrLiveTruncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn("/bin/sh", ["-lc", params.command], {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      detached: true,
    });

    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };

    const terminate = (reason: "timeout" | "abort") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      killProcessGroup("SIGTERM");
      killTimer ??= setTimeout(() => killProcessGroup("SIGKILL"), PROCESS_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => terminate("timeout"), params.timeoutMs);
    const abortListener = () => terminate("abort");
    if (params.abortSignal?.aborted) {
      terminate("abort");
    } else {
      params.abortSignal?.addEventListener("abort", abortListener, { once: true });
    }

    const pushBounded = (
      target: Buffer[],
      currentBytes: number,
      chunk: Buffer,
    ): { bytes: number; truncated: boolean } => {
      if (currentBytes >= MAX_LIVE_OUTPUT_BUFFER_BYTES)
        return { bytes: currentBytes + chunk.byteLength, truncated: true };
      const remaining = MAX_LIVE_OUTPUT_BUFFER_BYTES - currentBytes;
      if (chunk.byteLength <= remaining) {
        target.push(chunk);
        return { bytes: currentBytes + chunk.byteLength, truncated: false };
      }
      target.push(chunk.subarray(0, remaining));
      return { bytes: currentBytes + chunk.byteLength, truncated: true };
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const result = pushBounded(stdout, stdoutBytes, chunk);
      stdoutBytes = result.bytes;
      stdoutLiveTruncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = pushBounded(stderr, stderrBytes, chunk);
      stderrBytes = result.bytes;
      stderrLiveTruncated ||= result.truncated;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      params.abortSignal?.removeEventListener("abort", abortListener);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      params.abortSignal?.removeEventListener("abort", abortListener);
      const stderrNotices: string[] = [];
      if (stdoutLiveTruncated) stdout.push(Buffer.from(AGENT_RUNTIME_BASH_TRUNCATION_MARKER, "utf8"));
      if (stderrLiveTruncated) stderr.push(Buffer.from(AGENT_RUNTIME_BASH_TRUNCATION_MARKER, "utf8"));
      if (exitCode !== null && exitCode !== 0) {
        stderrNotices.push(`[sketch runtime command exited with code ${exitCode}]`);
      }
      if (signal !== null && !timedOut && !aborted) {
        stderrNotices.push(`[sketch runtime command terminated by signal ${signal}]`);
      }
      if (timedOut) {
        stderrNotices.push(`[sketch runtime command timed out after ${params.timeoutMs}ms]`);
      }
      if (aborted) {
        stderrNotices.push("[sketch runtime command aborted]");
      }
      const stderrText = [Buffer.concat(stderr).toString("utf8"), ...stderrNotices].filter(Boolean).join("\n");
      resolvePromise({
        stdout: truncateOutput(Buffer.concat(stdout).toString("utf8"), params.outputLimitBytes),
        stderr: truncateOutput(stderrText, params.outputLimitBytes),
        interrupted: timedOut || aborted || signal !== null,
      });
    });
  });
}

function splitFileLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function truncateLine(line: string): string {
  if (line.length <= DEFAULT_READ_LINE_CHAR_LIMIT) return line;
  return `${line.slice(0, DEFAULT_READ_LINE_CHAR_LIMIT)} ${LONG_LINE_TRUNCATION_MARKER}`;
}

function lineNumberedContent(lines: readonly string[], startLine: number): string {
  return lines.map((line, index) => `${String(startLine + index).padStart(6)}→${truncateLine(line)}`).join("\n");
}

type ImageReadMediaType = Extract<FileReadOutput, { type: "image" }>["file"]["type"];

function imageMediaType(filePath: string): ImageReadMediaType {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

async function executeRead(params: {
  file_path: string;
  offset?: number;
  limit?: number;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<FileReadOutput> {
  const guarded = await guardRuntimePath({ path: params.file_path, scope: params.scope });
  assertReadAllowed(guarded, params.scope);
  if (
    isImageFilePath(guarded.inputPath) ||
    isImageFilePath(guarded.absolutePath) ||
    isImageFilePath(guarded.realpath)
  ) {
    const data = await readFile(guarded.realpath);
    return {
      type: "image",
      file: {
        base64: data.toString("base64"),
        type: imageMediaType(guarded.realpath),
        originalSize: data.byteLength,
      },
    };
  }

  const content = await readFile(guarded.realpath, "utf8");
  const lines = splitFileLines(content);
  const startLine = params.offset ?? 1;
  const startIndex = Math.max(startLine - 1, 0);
  const selected = lines.slice(startIndex, startIndex + (params.limit ?? DEFAULT_READ_LINE_LIMIT));

  return {
    type: "text",
    file: {
      filePath: guarded.realpath,
      content: lineNumberedContent(selected, startLine),
      numLines: selected.length,
      startLine,
      totalLines: lines.length,
    },
  };
}

function readToModelOutput({ output }: Parameters<ToolToModelOutput>[0]): ReturnType<ToolToModelOutput> {
  const result = output as FileReadOutput;
  if (result.type !== "image") return { type: "json", value: result as JSONValue };

  return {
    type: "content",
    value: [
      {
        type: "file",
        mediaType: result.file.type,
        data: { type: "data", data: result.file.base64 },
      },
    ],
  };
}

function structuredPatch(originalFile: string | null, nextFile: string): FileEditOutput["structuredPatch"] {
  const oldLines = (originalFile ?? "").split(/\r?\n/);
  const newLines = nextFile.split(/\r?\n/);
  return [
    {
      oldStart: 1,
      oldLines: originalFile === null ? 0 : oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
    },
  ];
}

async function executeEdit(
  params: FileEditInput & { scope: AgentRuntimeWorkspaceToolScopePolicy },
): Promise<FileEditOutput> {
  if (params.old_string === params.new_string) {
    throw new Error("Edit failed: old_string and new_string must be different");
  }

  const guarded = await guardRuntimePath({ path: params.file_path, scope: params.scope });
  assertReadAllowed(guarded, params.scope);
  const current = await readFile(guarded.realpath, "utf8");
  const occurrences = current.split(params.old_string).length - 1;
  if (occurrences === 0) throw new Error(`Edit failed: old_string not found in ${guarded.realpath}`);
  if (!params.replace_all && occurrences > 1) {
    throw new Error(`Edit failed: old_string must uniquely identify one replacement in ${guarded.realpath}`);
  }

  const next = params.replace_all
    ? current.split(params.old_string).join(params.new_string)
    : current.replace(params.old_string, params.new_string);
  await writeFile(guarded.realpath, next, "utf8");

  return {
    filePath: guarded.realpath,
    oldString: params.old_string,
    newString: params.new_string,
    originalFile: current,
    structuredPatch: structuredPatch(current, next),
    userModified: false,
    replaceAll: params.replace_all === true,
  };
}

async function executeWrite(
  params: FileWriteInput & { scope: AgentRuntimeWorkspaceToolScopePolicy },
): Promise<FileWriteOutput> {
  const guarded = await guardRuntimePath({ path: params.file_path, scope: params.scope });
  assertReadAllowed(guarded, params.scope);
  const originalFile = await readFile(guarded.realpath, "utf8").catch((error: unknown) => {
    const code =
      error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  });
  await mkdir(dirname(guarded.realpath), { recursive: true });
  await writeFile(guarded.realpath, params.content, "utf8");

  return {
    type: originalFile === null ? "create" : "update",
    filePath: guarded.realpath,
    content: params.content,
    structuredPatch: structuredPatch(originalFile, params.content),
    originalFile,
  };
}

interface RgResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface RgSearchRoot {
  guarded: AgentRuntimeGuardedPath;
  searchPath: string;
}

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

async function runRg(params: {
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
}): Promise<RgResult> {
  return await new Promise<RgResult>((resolvePromise, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    /**
     * `--no-config` plus dropping RIPGREP_CONFIG_PATH keeps ripgrep behavior deterministic and independent of any
     * ambient config. Containment already neutralizes a hostile config via the realpath post-filter, so this is
     * defense-in-depth: it removes a class of behavioral surprises (symlink following, output-format changes).
     */
    const { RIPGREP_CONFIG_PATH: _omitRgConfig, ...rgEnv } = process.env;
    const child = spawn(rgPath, ["--no-config", ...params.args], {
      cwd: params.cwd,
      env: rgEnv,
      detached: true,
    });

    const outputLimitBytes = params.outputLimitBytes ?? MAX_LIVE_OUTPUT_BUFFER_BYTES;
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      killTimer ??= setTimeout(() => killProcessGroup("SIGKILL"), PROCESS_KILL_GRACE_MS);
    }, params.timeoutMs ?? DEFAULT_RG_TIMEOUT_MS);
    const pushBounded = (target: Buffer[], currentBytes: number, chunk: Buffer) => {
      if (currentBytes >= outputLimitBytes) return currentBytes + chunk.byteLength;
      const remaining = outputLimitBytes - currentBytes;
      target.push(chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining));
      return currentBytes + chunk.byteLength;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = pushBounded(stdout, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = pushBounded(stderr, stderrBytes, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

function cleanRgError(stderr: string): string {
  const message = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return message || "ripgrep failed";
}

function assertRgSuccess(result: RgResult): void {
  if (result.timedOut) throw new Error("ripgrep search timed out");
  if (result.exitCode === 0 || result.exitCode === 1) return;
  throw new Error(cleanRgError(result.stderr));
}

function rgOutputLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

async function resolveRgSearchRoot(params: {
  path?: string;
  pattern?: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<RgSearchRoot> {
  const path = params.path ?? (params.pattern && isAbsolute(params.pattern) ? absoluteGlobBase(params.pattern) : ".");
  const guarded = await guardRuntimePath({ path, scope: params.scope });
  const rel = relative(params.scope.allowedRoots.workspaceRoot.realpath, guarded.realpath);
  const searchPath = rel === "" ? "." : rel;
  return { guarded, searchPath };
}

function globPatternForRg(pattern: string, searchRoot: string): string {
  if (!isAbsolute(pattern)) return pattern;
  const rel = relative(searchRoot, pattern);
  return rel === "" ? "*" : rel;
}

function relativePathForGlob(path: string, basePath: string): string {
  const rel = relative(basePath, path);
  return rel.length === 0 ? "." : rel;
}

async function rgVisibleFileSet(params: {
  root: RgSearchRoot;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<Set<string>> {
  const result = await runRg({
    args: ["--files", "--glob", "!**/node_modules/**", params.root.searchPath],
    cwd: params.scope.allowedRoots.workspaceRoot.realpath,
  });
  assertRgSuccess(result);
  const visible = new Set<string>();
  for (const line of rgOutputLines(result.stdout)) {
    const guarded = await guardRgResultPath({ path: line, scope: params.scope });
    if (guarded && canReadPath(guarded, params.scope)) visible.add(guarded.realpath);
  }
  return visible;
}

async function guardRgResultPath(params: {
  path: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
}): Promise<AgentRuntimeGuardedPath | null> {
  try {
    return await guardRuntimePath({
      path: params.path,
      cwd: params.scope.allowedRoots.workspaceRoot.realpath,
      scope: params.scope,
    });
  } catch {
    return null;
  }
}

async function rgFilteredRealpaths(params: {
  root: RgSearchRoot;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
  lines: readonly string[];
  visibleFiles: ReadonlySet<string>;
}): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of params.lines) {
    const guarded = await guardRgResultPath({ path: line, scope: params.scope });
    if (!guarded || !params.visibleFiles.has(guarded.realpath) || !canReadPath(guarded, params.scope)) continue;
    if (seen.has(guarded.realpath)) continue;
    seen.add(guarded.realpath);
    paths.push(guarded.realpath);
  }
  return paths;
}

async function executeGlob(params: GlobInput & { scope: AgentRuntimeWorkspaceToolScopePolicy }): Promise<GlobOutput> {
  const startedAt = Date.now();
  await guardRuntimeGlob({ pattern: params.pattern, basePath: params.path, scope: params.scope });
  const root = await resolveRgSearchRoot({ path: params.path, pattern: params.pattern, scope: params.scope });
  const visibleFiles = await rgVisibleFileSet({ root, scope: params.scope });
  const rgPattern = globPatternForRg(params.pattern, root.guarded.realpath);
  const result = await runRg({
    args: ["--files", "--glob", rgPattern, "--glob", "!**/node_modules/**", root.searchPath],
    cwd: params.scope.allowedRoots.workspaceRoot.realpath,
  });
  assertRgSuccess(result);
  const rgRealpaths = await rgFilteredRealpaths({
    root,
    scope: params.scope,
    lines: rgOutputLines(result.stdout),
    visibleFiles,
  });
  const matched = rgRealpaths.filter((path) => {
    if (isAbsolute(params.pattern)) return matchesGlob(path, params.pattern);
    return matchesGlob(relativePathForGlob(path, root.guarded.realpath), params.pattern);
  });
  const withMtimes = await Promise.all(
    matched.map(async (path) => ({ path, mtimeMs: (await stat(path).catch(() => null))?.mtimeMs ?? 0 })),
  );
  const filenames = withMtimes
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .map((file) => file.path);
  const limited = filenames.slice(0, 100);

  return {
    durationMs: Date.now() - startedAt,
    numFiles: filenames.length,
    filenames: limited,
    truncated: filenames.length > limited.length,
  };
}

function applyGrepWindow<T>(items: readonly T[], input: Pick<GrepInput, "head_limit" | "offset">): T[] {
  const offset = input.offset ?? 0;
  const headLimit = input.head_limit ?? DEFAULT_GREP_HEAD_LIMIT;
  const offsetItems = items.slice(offset);
  return headLimit === 0 ? [...offsetItems] : offsetItems.slice(0, headLimit);
}

function grepLinePrefix(filePath: string, lineNumber: number, showLineNumbers: boolean): string {
  return showLineNumbers ? `${filePath}:${lineNumber}:` : `${filePath}:`;
}

function grepContextArgs(params: Pick<GrepInput, "-A" | "-B" | "-C" | "context">): string[] {
  if (params["-C"] !== undefined) return ["-C", String(params["-C"])];
  if (params.context !== undefined) return ["-C", String(params.context)];
  const args: string[] = [];
  if (params["-A"] !== undefined) args.push("-A", String(params["-A"]));
  if (params["-B"] !== undefined) args.push("-B", String(params["-B"]));
  return args;
}

function grepBaseArgs(params: GrepInput, root: RgSearchRoot): string[] {
  const args = ["--glob", "!**/node_modules/**", "--with-filename"];
  if (params["-i"]) args.push("-i");
  if (params.multiline) args.push("-U", "--multiline-dotall");
  if (params.glob) args.push("--glob", params.glob);
  if (params.type) args.push("--type", params.type);
  return [...args, "--", params.pattern, root.searchPath];
}

function parseRgJsonEvents(stdout: string): RgJsonEvent[] {
  const events: RgJsonEvent[] = [];
  for (const line of rgOutputLines(stdout)) {
    try {
      events.push(JSON.parse(line) as RgJsonEvent);
    } catch {}
  }
  return events;
}

async function parseGrepContent(params: {
  stdout: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
  visibleFiles: ReadonlySet<string>;
  showLineNumbers: boolean;
}): Promise<{ filenames: string[]; contentLines: string[] }> {
  const filenames: string[] = [];
  const seen = new Set<string>();
  const contentLines: string[] = [];
  let currentFile: string | null = null;

  for (const event of parseRgJsonEvents(params.stdout)) {
    if (event.type === "begin") {
      currentFile = null;
      const rawPath = event.data?.path?.text;
      if (!rawPath) continue;
      const guarded = await guardRgResultPath({ path: rawPath, scope: params.scope });
      if (!guarded || !params.visibleFiles.has(guarded.realpath) || !canReadPath(guarded, params.scope)) continue;
      currentFile = guarded.realpath;
      if (!seen.has(currentFile)) {
        seen.add(currentFile);
        filenames.push(currentFile);
      }
      continue;
    }

    if ((event.type === "match" || event.type === "context") && currentFile) {
      const lineNumber = event.data?.line_number ?? 0;
      const text = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
      contentLines.push(`${grepLinePrefix(currentFile, lineNumber, params.showLineNumbers)}${text}`);
    }
  }

  return { filenames, contentLines };
}

async function parseGrepCounts(params: {
  stdout: string;
  scope: AgentRuntimeWorkspaceToolScopePolicy;
  visibleFiles: ReadonlySet<string>;
}): Promise<Array<{ file: string; count: number }>> {
  const counts: Array<{ file: string; count: number }> = [];
  for (const line of rgOutputLines(params.stdout)) {
    const separator = line.lastIndexOf(":");
    if (separator === -1) continue;
    const rawPath = line.slice(0, separator);
    const count = Number(line.slice(separator + 1));
    if (!Number.isFinite(count)) continue;
    const guarded = await guardRgResultPath({ path: rawPath, scope: params.scope });
    if (!guarded || !params.visibleFiles.has(guarded.realpath) || !canReadPath(guarded, params.scope)) continue;
    counts.push({ file: guarded.realpath, count });
  }
  return counts;
}

async function executeGrep(params: GrepInput & { scope: AgentRuntimeWorkspaceToolScopePolicy }): Promise<GrepOutput> {
  const guardedRoot = await guardRuntimePath({
    path: params.path ?? params.scope.allowedRoots.workspaceRoot.path,
    scope: params.scope,
  });
  const root: RgSearchRoot = {
    guarded: guardedRoot,
    searchPath: relative(params.scope.allowedRoots.workspaceRoot.realpath, guardedRoot.realpath) || ".",
  };

  if (params.glob) {
    await guardRuntimeGlob({ pattern: params.glob, basePath: guardedRoot.realpath, scope: params.scope });
  }

  const outputMode = params.output_mode ?? "files_with_matches";
  const visibleFiles = await rgVisibleFileSet({ root, scope: params.scope });
  const appliedOffset = params.offset ?? 0;
  const appliedLimit = params.head_limit ?? DEFAULT_GREP_HEAD_LIMIT;

  if (outputMode === "count") {
    const result = await runRg({
      args: ["-c", ...grepBaseArgs(params, root)],
      cwd: params.scope.allowedRoots.workspaceRoot.realpath,
    });
    assertRgSuccess(result);
    const counts = await parseGrepCounts({ stdout: result.stdout, scope: params.scope, visibleFiles });
    const filenames = counts.map((entry) => entry.file);
    const countLines = applyGrepWindow(
      counts.map((entry) => `${entry.file}:${entry.count}`),
      params,
    );
    return {
      mode: "count",
      numFiles: filenames.length,
      filenames: applyGrepWindow(filenames, params),
      content: countLines.join("\n"),
      numLines: countLines.length,
      numMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
      appliedLimit,
      appliedOffset,
    };
  }

  if (outputMode === "content") {
    const result = await runRg({
      args: ["--json", ...grepContextArgs(params), ...grepBaseArgs(params, root)],
      cwd: params.scope.allowedRoots.workspaceRoot.realpath,
    });
    assertRgSuccess(result);
    const parsed = await parseGrepContent({
      stdout: result.stdout,
      scope: params.scope,
      visibleFiles,
      showLineNumbers: params["-n"] ?? true,
    });
    const contentLines = parsed.contentLines;
    const limitedLines = applyGrepWindow(contentLines, params);
    return {
      mode: "content",
      numFiles: parsed.filenames.length,
      filenames: parsed.filenames,
      content: limitedLines.join("\n"),
      numLines: limitedLines.length,
      numMatches: contentLines.length,
      appliedLimit,
      appliedOffset,
    };
  }

  const result = await runRg({
    args: ["--files-with-matches", ...grepBaseArgs(params, root)],
    cwd: params.scope.allowedRoots.workspaceRoot.realpath,
  });
  assertRgSuccess(result);
  const filenames = await rgFilteredRealpaths({
    root,
    scope: params.scope,
    lines: rgOutputLines(result.stdout),
    visibleFiles,
  });

  return {
    mode: "files_with_matches",
    numFiles: filenames.length,
    filenames: applyGrepWindow(filenames, params),
    appliedLimit,
    appliedOffset,
  };
}

export function createAgentRuntimeWorkspaceTools(deps: AgentRuntimeWorkspaceToolDeps): ToolSet {
  if (!rgPathLogged) {
    deps.logger?.debug({ rgPath }, "Agent runtime vendored ripgrep resolved");
    rgPathLogged = true;
  }

  const enabled = enabledToolNames(deps.toolNames);
  const tools: ToolSet = {};

  if (enabled.has("Read")) {
    tools.Read = tool({
      description: `Read a file inside the workspace or org Claude directory using the Claude SDK Read schema. ${AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS.Read}`,
      inputSchema: z.object({
        file_path: z.string(),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      }),
      execute: async ({ file_path, offset, limit }: FileReadInput) =>
        executeRead({ file_path, offset, limit, scope: deps.scope }),
      toModelOutput: readToModelOutput,
    });
  }

  if (enabled.has("Write")) {
    tools.Write = tool({
      description: `Write a UTF-8 file inside the workspace or org Claude directory using the Claude SDK Write schema. ${AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS.Write}`,
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      execute: async ({ file_path, content }: FileWriteInput) =>
        executeWrite({ file_path, content, scope: deps.scope }),
    });
  }

  if (enabled.has("Edit")) {
    tools.Edit = tool({
      description: `Replace text in a UTF-8 file using the Claude SDK Edit schema and uniqueness semantics. ${AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS.Edit}`,
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ file_path, old_string, new_string, replace_all }: FileEditInput) =>
        executeEdit({ file_path, old_string, new_string, replace_all, scope: deps.scope }),
    });
  }

  if (enabled.has("Glob")) {
    tools.Glob = tool({
      description: `Find files by glob pattern inside the workspace or org Claude directory, sorted by modified time. ${AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS.Glob}`,
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
      execute: async ({ pattern, path }: GlobInput) => executeGlob({ pattern, path, scope: deps.scope }),
    });
  }

  if (enabled.has("Grep")) {
    tools.Grep = tool({
      description: `Search file contents using the Claude SDK Grep schema. Phase 3a supports content/files_with_matches/count, -i, -n, glob, type, head_limit, offset, and line context. ${AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS.Grep}`,
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
        "-B": z.number().int().nonnegative().optional(),
        "-A": z.number().int().nonnegative().optional(),
        "-C": z.number().int().nonnegative().optional(),
        context: z.number().int().nonnegative().optional(),
        "-n": z.boolean().optional(),
        "-i": z.boolean().optional(),
        type: z.string().optional(),
        head_limit: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
        multiline: z.boolean().optional(),
      }),
      execute: async (input: GrepInput) => executeGrep({ ...input, scope: deps.scope }),
    });
  }

  if (enabled.has("Bash")) {
    tools.Bash = tool({
      description: `Run a foreground shell command scoped to the workspace using the Claude SDK Bash schema. ${AGENT_RUNTIME_WORKSPACE_TOOL_PARITY_DELTAS.Bash}`,
      inputSchema: z.object({
        command: z.string(),
        timeout: z.number().int().positive().max(600_000).optional(),
        description: z.string().optional(),
      }),
      execute: async ({ command, timeout, description }: BashInput, options) => {
        deps.logger?.debug({ toolName: "Bash", description }, "Agent runtime Bash tool invoked");
        const scan = await scanRuntimeBashCommand({
          command,
          scope: deps.scope,
          canvasCliEnvVar: "CANVAS_CLI",
        });
        if (scan.behavior === "deny") throw new Error(scan.message);
        return await runBash({
          command,
          cwd: deps.scope.allowedRoots.workspaceRoot.realpath,
          env: deps.env ?? {},
          timeoutMs: timeout ?? DEFAULT_BASH_TIMEOUT_MS,
          outputLimitBytes: DEFAULT_BASH_OUTPUT_LIMIT_BYTES,
          abortSignal: options.abortSignal,
        });
      },
    });
  }

  return tools;
}
