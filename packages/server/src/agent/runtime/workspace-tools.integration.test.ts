import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeWorkspaceToolScopePolicy } from "./contracts";
import { createAgentRuntimeWorkspaceToolScopePolicy } from "./path-guard";
import { AGENT_RUNTIME_BASH_TRUNCATION_MARKER, createAgentRuntimeWorkspaceTools } from "./workspace-tools";

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

describe("agent runtime Bash workspace tool", () => {
  let root: string;
  let workspace: string;
  let orgClaudeDir: string;
  let scope: AgentRuntimeWorkspaceToolScopePolicy;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-runtime-bash-"));
    workspace = join(root, "workspace");
    orgClaudeDir = join(root, "claude");
    await mkdir(workspace);
    await mkdir(orgClaudeDir);
    scope = await createAgentRuntimeWorkspaceToolScopePolicy({ workspaceRoot: workspace, orgClaudeDir });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs scoped commands, blocks out-of-root absolute paths, and truncates output", async () => {
    await writeFile(join(workspace, "notes.txt"), "notes");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Bash", { command: "printf scoped" })).resolves.toMatchObject({
      stdout: "scoped",
      interrupted: false,
    });
    await expect(executeTool(tools, "Bash", { command: "cat ./notes.txt" })).resolves.toMatchObject({
      stdout: "notes",
      interrupted: false,
    });
    await expect(executeTool(tools, "Bash", { command: "cat /etc/passwd" })).rejects.toThrow("allowed workspace roots");
    await expect(
      executeTool(tools, "Bash", {
        command: "node -e \"process.stdout.write('x'.repeat(25000))\"",
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(AGENT_RUNTIME_BASH_TRUNCATION_MARKER),
    });
  });

  it("bounds live output buffering before returning the final truncated output", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Bash", {
        command: "node -e \"process.stdout.write('x'.repeat(300000))\"",
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(AGENT_RUNTIME_BASH_TRUNCATION_MARKER),
      interrupted: false,
    });
  });

  it("reports non-zero exits without marking them as timeout interruptions", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Bash", { command: "printf failure >&2; exit 7" })).resolves.toMatchObject({
      stderr: expect.stringContaining("exited with code 7"),
      interrupted: false,
    });
  });

  it("denies Bash relative traversal before the shell can read outside the workspace", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Bash", { command: "cat ../outside/secret.txt" })).rejects.toThrow(
      "allowed workspace roots",
    );
    await expect(executeTool(tools, "Bash", { command: "cat ../../etc/passwd" })).rejects.toThrow(
      "allowed workspace roots",
    );
  });

  it("denies cd parent traversal before a sibling secret can be read", async () => {
    const sibling = join(root, "sibling");
    const leakedPath = join(workspace, "leaked.txt");
    await mkdir(sibling);
    await writeFile(join(sibling, "secret.txt"), "do-not-leak");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Bash", { command: `cd .. && cat sibling/secret.txt > ${leakedPath}` }),
    ).rejects.toThrow("allowed workspace roots");
    await expect(readFile(leakedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies cd ../.. before a chained absolute read", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Bash", { command: "cd ../.. && cat /etc/passwd" })).rejects.toThrow(
      "allowed workspace roots",
    );
  });

  it("denies bare parent directory path reads", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Bash", { command: "cat .." })).rejects.toThrow("allowed workspace roots");
  });

  it("denies semicolon reads after cd leaves the workspace", async () => {
    const sibling = join(root, "semicolon-sibling");
    const leakedPath = join(workspace, "semicolon-leaked.txt");
    await mkdir(sibling);
    await writeFile(join(sibling, "secret.txt"), "do-not-leak");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Bash", { command: `cd ..; cat semicolon-sibling/secret.txt > ${leakedPath}` }),
    ).rejects.toThrow("allowed workspace roots");
    await expect(readFile(leakedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows cd into a workspace subdirectory before reading a file there", async () => {
    const subdir = join(workspace, "subdir");
    await mkdir(subdir);
    await writeFile(join(subdir, "inside.txt"), "inside");
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(executeTool(tools, "Bash", { command: "cd subdir && cat ./inside.txt" })).resolves.toMatchObject({
      stdout: "inside",
      interrupted: false,
    });
  });

  it("keeps the Canvas CLI Bash carveout unchanged", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope, env: { CANVAS_CLI: "/usr/bin/printf" } });

    await expect(
      executeTool(tools, "Bash", { command: "$CANVAS_CLI 'canvas payload /etc/passwd'" }),
    ).resolves.toMatchObject({
      stdout: "canvas payload /etc/passwd",
      interrupted: false,
    });
  });

  it("terminates commands that exceed the configured timeout", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Bash", {
        command: "sleep 2",
        timeout: 50,
      }),
    ).resolves.toMatchObject({
      interrupted: true,
      stderr: expect.stringContaining("timed out"),
    });
  });

  it("SIGKILLs a SIGTERM-ignoring command group and still resolves", async () => {
    const tools = createAgentRuntimeWorkspaceTools({ scope });

    await expect(
      executeTool(tools, "Bash", {
        command: "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"",
        timeout: 50,
      }),
    ).resolves.toMatchObject({
      interrupted: true,
      stderr: expect.stringContaining("timed out"),
    });
  });

  it("logs the Bash description as tool metadata", async () => {
    const logger = { debug: vi.fn() };
    const tools = createAgentRuntimeWorkspaceTools({ scope, logger });

    await executeTool(tools, "Bash", { command: "printf ok", description: "Print an ok sentinel" });

    expect(logger.debug).toHaveBeenCalledWith(
      { toolName: "Bash", description: "Print an ok sentinel" },
      "Agent runtime Bash tool invoked",
    );
  });
});
