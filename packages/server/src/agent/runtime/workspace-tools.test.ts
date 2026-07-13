import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRuntimeWorkspaceToolScopePolicy } from "./contracts";
import { createAgentRuntimeWorkspaceToolScopePolicy } from "./path-guard";
import { createAgentRuntimeWorkspaceTools } from "./workspace-tools";

async function executeTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const selectedTool = tools[name];
  const executable = selectedTool as
    | {
        execute?: (
          input: unknown,
          options: { toolCallId: string; messages: ModelMessage[]; context: undefined },
        ) => unknown;
      }
    | undefined;
  if (!executable?.execute) throw new Error(`Tool is not executable: ${name}`);
  return await executable.execute(input, {
    toolCallId: "tool-call-test",
    messages: [],
    context: undefined,
  });
}

interface SmokeTool {
  toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
}

describe("agent runtime workspace tools", () => {
  let root: string;
  let workspace: string;
  let orgClaudeDir: string;
  let scope: AgentRuntimeWorkspaceToolScopePolicy;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-runtime-tools-"));
    workspace = join(root, "workspace");
    orgClaudeDir = join(root, "claude");
    await mkdir(workspace);
    await mkdir(orgClaudeDir);
    scope = await createAgentRuntimeWorkspaceToolScopePolicy({ workspaceRoot: workspace, orgClaudeDir });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads, writes, and edits files through resolved in-root paths", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Write", { file_path: "notes/today.txt", content: "hello world" }),
    ).resolves.toMatchObject({
      type: "create",
      content: "hello world",
    });
    await expect(readFile(join(workspace, "notes", "today.txt"), "utf8")).resolves.toBe("hello world");

    const readResult = await executeTool(tools, "Read", { file_path: join(workspace, "notes", "today.txt") });
    expect(readResult).toMatchObject({
      type: "text",
      file: { content: "     1→hello world", numLines: 1, startLine: 1, totalLines: 1 },
    });

    await expect(
      executeTool(tools, "Edit", {
        file_path: "notes/today.txt",
        old_string: "world",
        new_string: "Sketch",
      }),
    ).resolves.toMatchObject({
      oldString: "world",
      newString: "Sketch",
      originalFile: "hello world",
      replaceAll: false,
    });
    await expect(readFile(join(workspace, "notes", "today.txt"), "utf8")).resolves.toBe("hello Sketch");
  });

  it("supports SDK Read offset and limit fields", async () => {
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes", "lines.txt"), "one\ntwo\nthree\nfour");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Read", { file_path: "notes/lines.txt", offset: 2, limit: 2 }),
    ).resolves.toMatchObject({
      file: {
        content: "     2→two\n     3→three",
        numLines: 2,
        startLine: 2,
        totalLines: 4,
      },
    });
  });

  it("matches SDK Edit not-found and uniqueness failures", async () => {
    await writeFile(join(workspace, "duplicate.txt"), "same\nsame\n");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Edit", { file_path: "duplicate.txt", old_string: "missing", new_string: "next" }),
    ).rejects.toThrow("old_string not found");
    await expect(
      executeTool(tools, "Edit", { file_path: "duplicate.txt", old_string: "same", new_string: "next" }),
    ).rejects.toThrow("old_string must uniquely identify");
    await expect(
      executeTool(tools, "Edit", {
        file_path: "duplicate.txt",
        old_string: "same",
        new_string: "next",
        replace_all: true,
      }),
    ).resolves.toMatchObject({ replaceAll: true });
  });

  it("blocks direct Read through a symlink to a blocked visual path", async () => {
    const attachmentsDir = join(workspace, "attachments");
    const blockedPath = join(attachmentsDir, "image.png");
    await mkdir(attachmentsDir);
    await writeFile(blockedPath, "image");
    await symlink(blockedPath, join(workspace, "image-link"));
    const blockedScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockedReadPaths: [blockedPath],
    });
    const tools = createAgentRuntimeWorkspaceTools({ scope: blockedScope });

    await expect(executeTool(tools, "Read", { file_path: join(workspace, "image-link") })).rejects.toThrow(
      "VisualAnalysis",
    );
  });

  it("blocks content-reading tools through a symlink to a blocked visual path", async () => {
    const attachmentsDir = join(workspace, "attachments");
    const blockedPath = join(attachmentsDir, "image.png");
    await mkdir(attachmentsDir);
    await writeFile(blockedPath, "image needle");
    await symlink(blockedPath, join(workspace, "image-link"));
    const blockedScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockedReadPaths: [blockedPath],
    });
    const tools = createAgentRuntimeWorkspaceTools({ scope: blockedScope });
    const readBlockedMessage = "Direct image reads are not supported";

    await expect(executeTool(tools, "Read", { file_path: join(workspace, "image-link") })).rejects.toThrow(
      readBlockedMessage,
    );
    await expect(
      executeTool(tools, "Edit", { file_path: join(workspace, "image-link"), old_string: "image", new_string: "x" }),
    ).rejects.toThrow(readBlockedMessage);
    await expect(
      executeTool(tools, "Write", { file_path: join(workspace, "image-link"), content: "replacement" }),
    ).rejects.toThrow(readBlockedMessage);
    await expect(
      executeTool(tools, "Grep", { pattern: "needle", path: attachmentsDir, output_mode: "content" }),
    ).resolves.toMatchObject({
      mode: "content",
      filenames: [],
      content: "",
      numFiles: 0,
      numLines: 0,
    });
  });

  it("blocks image-extension content reads when visual analysis should handle images", async () => {
    const imagePath = join(workspace, "foo.png");
    await writeFile(imagePath, "image needle");
    const imageBlockingScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockImageReads: true,
    });
    const tools = createAgentRuntimeWorkspaceTools({ scope: imageBlockingScope });

    await expect(executeTool(tools, "Read", { file_path: imagePath })).rejects.toThrow("VisualAnalysis");
    await expect(
      executeTool(tools, "Edit", { file_path: imagePath, old_string: "image", new_string: "x" }),
    ).rejects.toThrow("VisualAnalysis");
    await expect(
      executeTool(tools, "Grep", { pattern: "needle", path: workspace, output_mode: "content" }),
    ).resolves.toMatchObject({
      mode: "content",
      filenames: [],
      content: "",
      numFiles: 0,
    });
  });

  it("returns image blocks when native image reads are allowed", async () => {
    const imagePath = join(workspace, "foo.png");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imagePath, imageBytes);
    const imageAllowedScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockImageReads: false,
    });
    const tools = createAgentRuntimeWorkspaceTools({ scope: imageAllowedScope });

    const output = await executeTool(tools, "Read", { file_path: imagePath });
    expect(output).toEqual({
      type: "image",
      file: { base64: imageBytes.toString("base64"), type: "image/png", originalSize: imageBytes.byteLength },
    });
    expect((tools.Read as SmokeTool).toModelOutput?.({ toolCallId: "read-image", input: {}, output })).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: imageBytes.toString("base64") },
        },
      ],
    });
  });

  it("does not block non-image content reads when image blocking is enabled", async () => {
    const textPath = join(workspace, "notes.txt");
    await writeFile(textPath, "plain text");
    const imageBlockingScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockImageReads: true,
    });
    const tools = createAgentRuntimeWorkspaceTools({ scope: imageBlockingScope });

    await expect(executeTool(tools, "Read", { file_path: textPath })).resolves.toMatchObject({
      file: { content: "     1→plain text" },
    });
  });

  it("caps default Read output and truncates very long lines without inflating total lines", async () => {
    const longLine = "x".repeat(2_100);
    const filePath = join(workspace, "large.txt");
    await writeFile(
      filePath,
      `${["first", longLine, ...Array.from({ length: 2_000 }, (_, index) => `line-${index}`)].join("\n")}\n`,
    );
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    const result = await executeTool(tools, "Read", { file_path: filePath });

    expect(result).toMatchObject({
      type: "text",
      file: {
        numLines: 2_000,
        totalLines: 2_002,
      },
    });
    expect((result as { file: { content: string } }).file.content).toContain("[sketch runtime line truncated]");
    expect((result as { file: { content: string } }).file.content).not.toContain("line-1999");
  });

  it("denies file tools through symlink escapes", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "escape"), "dir");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Read", { file_path: join(workspace, "escape", "secret.txt") })).rejects.toThrow(
      "outside the allowed workspace roots",
    );
    await expect(
      executeTool(tools, "Write", { file_path: join(workspace, "escape", "new.txt"), content: "x" }),
    ).rejects.toThrow("outside the allowed workspace roots");
  });

  it("denies Write through missing-segment traversal before a symlink escape", async () => {
    const outside = join(root, "outside-missing");
    const escapedFile = join(outside, "new.txt");
    await mkdir(outside);
    await symlink(outside, join(workspace, "link"), "dir");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Write", { file_path: `${workspace}/missing/../link/new.txt`, content: "escaped" }),
    ).rejects.toThrow("outside the allowed workspace roots");
    await expect(readFile(escapedFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("globs and greps only within validated roots", async () => {
    await mkdir(join(workspace, "src"));
    const tsFile = join(workspace, "src", "a.ts");
    const markdownFile = join(workspace, "src", "b.md");
    await writeFile(tsFile, "export const label = 'Sketch';\n");
    await writeFile(markdownFile, "Sketch notes\n");
    const tsFileRealpath = await realpath(tsFile);
    const markdownFileRealpath = await realpath(markdownFile);
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Glob", { pattern: "src/**/*.ts" })).resolves.toMatchObject({
      filenames: [tsFileRealpath],
      numFiles: 1,
      truncated: false,
    });
    await expect(
      executeTool(tools, "Grep", { pattern: "sketch", glob: "**/*.md", output_mode: "content", "-i": true }),
    ).resolves.toMatchObject({
      mode: "content",
      filenames: [markdownFileRealpath],
      content: `${markdownFileRealpath}:1:Sketch notes`,
    });
    await expect(executeTool(tools, "Glob", { pattern: "../*.ts" })).rejects.toThrow("parent directory segments");
  });

  it("Glob skips a symlink resolving outside the workspace instead of failing the whole match", async () => {
    await mkdir(join(workspace, "src"));
    const tsFile = join(workspace, "src", "a.ts");
    await writeFile(tsFile, "export const a = 1;\n");
    const outside = join(root, "outside-glob");
    await mkdir(outside);
    await writeFile(join(outside, "leaked.ts"), "export const leaked = 1;\n");
    await symlink(join(outside, "leaked.ts"), join(workspace, "src", "escape.ts"));
    const tsFileRealpath = await realpath(tsFile);
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Glob", { pattern: "src/**/*.ts" })).resolves.toMatchObject({
      filenames: [tsFileRealpath],
      numFiles: 1,
      truncated: false,
    });
  });

  it("does not leak out-of-root symlinks through rg-backed Grep or Glob", async () => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "safe.txt"), "needle safe\n");
    const outside = join(root, "outside-rg");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "needle secret\n");
    await symlink(outside, join(workspace, "src", "outside-dir"), "dir");
    await symlink(join(outside, "secret.txt"), join(workspace, "src", "outside-file.txt"));
    const safeRealpath = await realpath(join(workspace, "src", "safe.txt"));
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Grep", { pattern: "needle", path: "src", output_mode: "content" }),
    ).resolves.toMatchObject({
      mode: "content",
      filenames: [safeRealpath],
      content: `${safeRealpath}:1:needle safe`,
      numFiles: 1,
    });
    await expect(executeTool(tools, "Glob", { pattern: "src/**/*.txt" })).resolves.toMatchObject({
      filenames: [safeRealpath],
      numFiles: 1,
    });
  });

  it("filters blocked and image files from all rg-backed Grep modes and Glob", async () => {
    const attachmentsDir = join(workspace, "attachments");
    await mkdir(attachmentsDir);
    const safePath = join(attachmentsDir, "safe.txt");
    const blockedPath = join(attachmentsDir, "blocked.txt");
    const imagePath = join(attachmentsDir, "chart.png");
    await writeFile(safePath, "needle safe\n");
    await writeFile(blockedPath, "needle blocked\n");
    await writeFile(imagePath, "needle image\n");
    const safeRealpath = await realpath(safePath);
    const filteredScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockedReadPaths: [blockedPath],
      blockImageReads: true,
    });
    const tools = createAgentRuntimeWorkspaceTools({ scope: filteredScope });

    await expect(executeTool(tools, "Grep", { pattern: "needle", path: attachmentsDir })).resolves.toMatchObject({
      mode: "files_with_matches",
      filenames: [safeRealpath],
      numFiles: 1,
    });
    await expect(
      executeTool(tools, "Grep", { pattern: "needle", path: attachmentsDir, output_mode: "content" }),
    ).resolves.toMatchObject({
      mode: "content",
      filenames: [safeRealpath],
      content: `${safeRealpath}:1:needle safe`,
      numFiles: 1,
    });
    await expect(
      executeTool(tools, "Grep", { pattern: "needle", path: attachmentsDir, output_mode: "count" }),
    ).resolves.toMatchObject({
      mode: "count",
      filenames: [safeRealpath],
      content: `${safeRealpath}:1`,
      numFiles: 1,
      numMatches: 1,
    });
    await expect(executeTool(tools, "Glob", { pattern: "attachments/*" })).resolves.toMatchObject({
      filenames: [safeRealpath],
      numFiles: 1,
    });
  });

  it("matches ripgrep parity cases for type, multiline, ignores, regex errors, windows, and counts", async () => {
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(workspace, ".gitignore"), "ignored.rs\n");
    const rustPath = join(workspace, "src", "lib.rs");
    const ignoredPath = join(workspace, "ignored.rs");
    const nodeModulePath = join(workspace, "node_modules", "pkg", "lib.rs");
    const multilinePath = join(workspace, "src", "multi.txt");
    const countsPath = join(workspace, "src", "counts.txt");
    await writeFile(rustPath, "fn main() {}\n");
    await writeFile(ignoredPath, "fn ignored() {}\n");
    await writeFile(nodeModulePath, "fn module() {}\n");
    await writeFile(multilinePath, "alpha\nbeta\n");
    await writeFile(countsPath, "needle one\nnope\nneedle two\n");
    const rustRealpath = await realpath(rustPath);
    const multilineRealpath = await realpath(multilinePath);
    const countsRealpath = await realpath(countsPath);
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Grep", { pattern: "fn main", type: "rust" })).resolves.toMatchObject({
      filenames: [rustRealpath],
      numFiles: 1,
    });
    await expect(
      executeTool(tools, "Grep", { pattern: "alpha.*beta", path: "src", multiline: true, output_mode: "content" }),
    ).resolves.toMatchObject({
      filenames: [multilineRealpath],
      content: expect.stringContaining("alpha"),
      numFiles: 1,
    });
    await expect(executeTool(tools, "Grep", { pattern: "fn", type: "rust" })).resolves.toMatchObject({
      filenames: [rustRealpath],
      numFiles: 1,
    });
    await expect(executeTool(tools, "Grep", { pattern: "(?<=needle) one", path: "src" })).rejects.toThrow(
      "look-around",
    );
    await expect(
      executeTool(tools, "Grep", {
        pattern: "needle",
        path: "src",
        output_mode: "content",
        head_limit: 1,
        offset: 1,
      }),
    ).resolves.toMatchObject({
      mode: "content",
      content: `${countsRealpath}:3:needle two`,
      numLines: 1,
      appliedLimit: 1,
      appliedOffset: 1,
    });
    await expect(
      executeTool(tools, "Grep", { pattern: "needle", path: "src", output_mode: "count" }),
    ).resolves.toMatchObject({
      mode: "count",
      content: `${countsRealpath}:2`,
      numMatches: 2,
    });
  });

  it("uses SDK workspace tool schema field names", () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });
    const shapes = Object.fromEntries(
      Object.entries(tools).map(([name, selectedTool]) => [
        name,
        Object.keys((selectedTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape).sort(),
      ]),
    );

    expect(shapes).toMatchObject({
      Bash: ["command", "description", "timeout"],
      Edit: ["file_path", "new_string", "old_string", "replace_all"],
      Glob: ["path", "pattern"],
      Grep: [
        "-A",
        "-B",
        "-C",
        "-i",
        "-n",
        "context",
        "glob",
        "head_limit",
        "multiline",
        "offset",
        "output_mode",
        "path",
        "pattern",
        "type",
      ],
      Read: ["file_path", "limit", "offset"],
      Write: ["content", "file_path"],
    });
  });

  it("builds only the requested subset of workspace tools", () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope, toolNames: ["Read", "Grep"] });

    expect(Object.keys(tools).sort()).toEqual(["Grep", "Read"]);
  });
});
