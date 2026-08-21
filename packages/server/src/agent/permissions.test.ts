import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { createCanUseTool } from "./permissions";

function expectDeny(result: PermissionResult): asserts result is Extract<PermissionResult, { behavior: "deny" }> {
  expect(result.behavior).toBe("deny");
}

describe("createCanUseTool", () => {
  let tempRoot: string;
  let workspace: string;
  let claudeDir: string;
  let canUseTool: ReturnType<typeof createCanUseTool> extends Promise<infer T>
    ? never
    : ReturnType<typeof createCanUseTool>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sketch-permissions-"));
    workspace = join(tempRoot, "workspace");
    claudeDir = join(tempRoot, "claude");
    await mkdir(workspace, { recursive: true });
    await mkdir(claudeDir, { recursive: true });

    const logger = createTestLogger();
    canUseTool = createCanUseTool(workspace, logger, claudeDir);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("tool allowlist", () => {
    it.each(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"])(
      "allows permitted tool: %s",
      async (tool) => {
        const result = await canUseTool(tool, {});
        expect(result.behavior).toBe("allow");
      },
    );

    it("denies unknown tool 'Task'", async () => {
      const result = await canUseTool("Task", {});
      expectDeny(result);
      expect(result.message).toContain("Task");
      expect(result.message).toContain("not allowed");
    });

    it("denies unknown tool 'NotebookEdit'", async () => {
      const result = await canUseTool("NotebookEdit", {});
      expectDeny(result);
      expect(result.message).toContain("NotebookEdit");
    });

    it("denies empty string tool name", async () => {
      const result = await canUseTool("", {});
      expectDeny(result);
      expect(result.message).toContain("not allowed");
    });

    it("allows MCP tool from sketch server", async () => {
      const result = await canUseTool("mcp__sketch__SendFileToChat", { file_path: "/some/path" });
      expect(result.behavior).toBe("allow");
    });

    it("allows MCP tool from any server", async () => {
      const result = await canUseTool("mcp__some-other-server__SomeTool", { param: "value" });
      expect(result.behavior).toBe("allow");
    });

    it("allows MCP tool with deeply nested server name", async () => {
      const result = await canUseTool("mcp__my-org__my-tool__action", {});
      expect(result.behavior).toBe("allow");
    });

    it("denies tool that contains mcp but does not start with mcp__", async () => {
      const result = await canUseTool("mcp_missing_prefix", {});
      expectDeny(result);
      expect(result.message).toContain("not allowed");
    });
  });

  describe("file tools — workspace access", () => {
    it("allows file_path inside workspace", async () => {
      const result = await canUseTool("Read", { file_path: `${workspace}/notes.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows path inside workspace (Glob uses path)", async () => {
      const result = await canUseTool("Glob", { path: `${workspace}/src` });
      expect(result.behavior).toBe("allow");
    });

    it("allows path inside workspace (Grep uses path)", async () => {
      const result = await canUseTool("Grep", { path: `${workspace}/src` });
      expect(result.behavior).toBe("allow");
    });

    it("allows a relative Glob pattern without parent directory segments", async () => {
      const result = await canUseTool("Glob", { pattern: "src/**/*.ts" });
      expect(result.behavior).toBe("allow");
    });

    it("denies an absolute Glob pattern outside the workspace", async () => {
      const result = await canUseTool("Glob", { pattern: `${tempRoot}/outside/**/*.ts` });
      expectDeny(result);
      expect(result.message).toContain("Glob patterns must stay within your workspace");
    });

    it("denies a Glob pattern with parent directory segments", async () => {
      const result = await canUseTool("Glob", { pattern: "../*.ts" });
      expectDeny(result);
      expect(result.message).toContain("Glob patterns must stay within your workspace");
    });

    it("denies file_path outside workspace", async () => {
      const result = await canUseTool("Read", { file_path: "/etc/passwd" });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies path traversal that resolves outside workspace", async () => {
      const result = await canUseTool("Write", { file_path: `${workspace}/../../etc/passwd` });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies relative path traversal from the process cwd", async () => {
      const result = await canUseTool("Read", { file_path: "../secrets.txt" });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("allows when no path provided (defaults to workspace)", async () => {
      const result = await canUseTool("Grep", {});
      expect(result.behavior).toBe("allow");
    });

    it("allows subdirectory within workspace", async () => {
      const result = await canUseTool("Edit", { file_path: `${workspace}/src/deep/nested/file.ts` });
      expect(result.behavior).toBe("allow");
    });

    it("denies path that shares workspace prefix but is a sibling directory", async () => {
      const result = await canUseTool("Read", { file_path: `${workspace}-evil/secrets.txt` });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies a symlinked file inside the workspace when its target is outside", async () => {
      const outsideDir = join(tempRoot, "outside");
      await mkdir(outsideDir);
      const outsideFile = join(outsideDir, "secret.txt");
      const linkPath = join(workspace, "secret-link.txt");
      await writeFile(outsideFile, "secret");
      await symlink(outsideFile, linkPath);

      const result = await canUseTool("Read", { file_path: linkPath });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies a symlinked directory component inside the workspace when its target is outside", async () => {
      const outsideDir = join(tempRoot, "outside-dir");
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "secret.txt"), "secret");
      const linkPath = join(workspace, "linked-outside");
      await symlink(outsideDir, linkPath, "dir");

      const result = await canUseTool("Grep", { path: join(linkPath, "secret.txt") });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies a symlink inside the workspace even when it points outside", async () => {
      const outsideDir = join(tempRoot, "outside-phase1");
      await mkdir(outsideDir);
      await symlink(outsideDir, join(workspace, "escape"), "dir");

      const result = await canUseTool("Read", { file_path: join(workspace, "escape", "secret.txt") });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies parent traversal after a symlinked directory component resolves outside", async () => {
      const outsideDir = join(tempRoot, "outside-repro");
      const linkPath = join(workspace, "link");
      const outsideFile = join(tempRoot, "secret.txt");
      await mkdir(outsideDir);
      await writeFile(outsideFile, "secret");
      await symlink(outsideDir, linkPath, "dir");

      const result = await canUseTool("Read", { file_path: `${linkPath}/../secret.txt` });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies Write to link/../secret.txt when link points outside and the target is missing", async () => {
      const outsideDir = join(tempRoot, "outside-missing-target");
      const linkPath = join(workspace, "link");
      await mkdir(outsideDir);
      await symlink(outsideDir, linkPath, "dir");

      const result = await canUseTool("Write", { file_path: `${linkPath}/../secret.txt` });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies Write to link/./../x when link points outside and the target is missing", async () => {
      const outsideDir = join(tempRoot, "outside-dot-target");
      const linkPath = join(workspace, "link-dot");
      await mkdir(outsideDir);
      await symlink(outsideDir, linkPath, "dir");

      const result = await canUseTool("Write", { file_path: `${linkPath}/./../x` });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies a double symlink chain when the final target is outside the workspace", async () => {
      const outsideDir = join(tempRoot, "outside-chain");
      const middleLink = join(workspace, "outside-b");
      const firstLink = join(workspace, "outside-a");
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "secret.txt"), "secret");
      await symlink(outsideDir, middleLink, "dir");
      await symlink(middleLink, firstLink, "dir");

      const result = await canUseTool("Read", { file_path: join(firstLink, "secret.txt") });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("allows a double symlink chain when the final target stays inside the workspace", async () => {
      const insideDir = join(workspace, "inside-chain-target");
      const middleLink = join(workspace, "inside-b");
      const firstLink = join(workspace, "inside-a");
      await mkdir(insideDir);
      await writeFile(join(insideDir, "notes.txt"), "inside");
      await symlink(insideDir, middleLink, "dir");
      await symlink(middleLink, firstLink, "dir");

      const result = await canUseTool("Read", { file_path: join(firstLink, "notes.txt") });

      expect(result.behavior).toBe("allow");
    });

    it("allows a symlink inside the workspace when its target stays inside the workspace", async () => {
      const targetPath = join(workspace, "target.txt");
      const linkPath = join(workspace, "inside-link.txt");
      await writeFile(targetPath, "inside");
      await symlink(targetPath, linkPath);

      const result = await canUseTool("Read", { file_path: linkPath });

      expect(result.behavior).toBe("allow");
    });

    it("allows a normal read through a symlinked directory whose target stays inside the workspace", async () => {
      const targetDir = join(workspace, "linked-inside-target");
      const linkPath = join(workspace, "linked-inside");
      await mkdir(targetDir);
      await writeFile(join(targetDir, "notes.txt"), "inside");
      await symlink(targetDir, linkPath, "dir");

      const result = await canUseTool("Read", { file_path: join(linkPath, "notes.txt") });

      expect(result.behavior).toBe("allow");
    });

    it("allows paths through a symlinked workspace root when the real target is the workspace", async () => {
      const realWorkspace = join(tempRoot, "real-workspace");
      const workspaceLink = join(tempRoot, "workspace-link");
      await mkdir(realWorkspace);
      await writeFile(join(realWorkspace, "notes.md"), "notes");
      await symlink(realWorkspace, workspaceLink, "dir");
      const agentTool = createCanUseTool(workspaceLink, createTestLogger(), claudeDir);

      const result = await agentTool("Read", { file_path: join(workspaceLink, "notes.md") });

      expect(result.behavior).toBe("allow");
    });

    it("allows file access when a /tmp workspace root normalizes through the physical realpath", async () => {
      const tmpRoot = await mkdtemp(join("/tmp", "sketch-permissions-root-"));
      try {
        const tmpWorkspace = join(tmpRoot, "workspace");
        const tmpClaudeDir = join(tmpRoot, "claude");
        await mkdir(tmpWorkspace);
        await mkdir(tmpClaudeDir);
        const agentTool = createCanUseTool(tmpWorkspace, createTestLogger(), tmpClaudeDir);

        const result = await agentTool("Write", { file_path: join(tmpWorkspace, "notes.txt") });

        expect(result.behavior).toBe("allow");
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it("denies Write to a non-existent path under a symlinked directory that points outside", async () => {
      const outsideDir = join(tempRoot, "outside-write");
      const linkPath = join(workspace, "outside-write-link");
      await mkdir(outsideDir);
      await symlink(outsideDir, linkPath, "dir");

      const result = await canUseTool("Write", { file_path: join(linkPath, "new-file.txt") });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("denies a dangling symlink encountered during realpath resolution", async () => {
      const linkPath = join(workspace, "dangling-link");
      await symlink(join(tempRoot, "missing-target"), linkPath);

      const result = await canUseTool("Read", { file_path: linkPath });

      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });

    it("anchors relative file paths to the workspace root instead of process.cwd()", async () => {
      const previousCwd = process.cwd();
      const otherCwd = join(tempRoot, "other-cwd");
      const absolutePath = join(workspace, "absolute.txt");
      await mkdir(otherCwd);
      await writeFile(absolutePath, "absolute");
      await writeFile(join(workspace, "relative.txt"), "inside");
      await writeFile(join(otherCwd, "relative.txt"), "outside-cwd");

      try {
        process.chdir(otherCwd);

        const absoluteResult = await canUseTool("Read", { file_path: absolutePath });
        const relativeResult = await canUseTool("Read", { file_path: "relative.txt" });
        const outsideRelativeResult = await canUseTool("Read", { file_path: "../outside-normal.txt" });

        expect(absoluteResult.behavior).toBe("allow");
        expect(relativeResult.behavior).toBe("allow");
        expectDeny(outsideRelativeResult);
        expect(outsideRelativeResult.message).toContain("outside your workspace");
      } finally {
        process.chdir(previousCwd);
      }
    });

    it("denies Read for blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/image-without-extension`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Read", { file_path: blockedPath });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
      expect(result.message).toContain(blockedPath);
    });

    it.each(["jpg", "jpeg", "png", "gif", "webp"])(
      "denies Read for image extension .%s when image reads are disabled",
      async (extension) => {
        const logger = createTestLogger();
        const imagePath = `${workspace}/attachments/photo.${extension}`;
        const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockImageReads: true });

        const result = await agentTool("Read", { file_path: imagePath });

        expectDeny(result);
        expect(result.message).toContain("Direct image reads are not supported for this model");
        expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
        expect(result.message).toContain("Do not use Read, Bash, cat, base64, or conversion workarounds");
        expect(result.message).toContain(imagePath);
      },
    );

    it("allows Read for image extensions when image reads are enabled", async () => {
      const logger = createTestLogger();
      const imagePath = `${workspace}/attachments/photo.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockImageReads: false });

      const result = await agentTool("Read", { file_path: imagePath });

      expect(result.behavior).toBe("allow");
    });

    it("allows Read for non-image extensions when image reads are disabled", async () => {
      const logger = createTestLogger();
      const textPath = `${workspace}/attachments/notes.txt`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockImageReads: true });

      const result = await agentTool("Read", { file_path: textPath });

      expect(result.behavior).toBe("allow");
    });

    it("allows non-Read file tools for image extensions when image reads are disabled", async () => {
      const logger = createTestLogger();
      const imagePath = `${workspace}/attachments/photo.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockImageReads: true });

      const result = await agentTool("Grep", { path: imagePath });

      expect(result.behavior).toBe("allow");
    });

    it("resolves blocked attachment paths before comparing", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/image.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Read", { file_path: `${workspace}/attachments/../attachments/image.png` });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
    });

    it("denies Read through a symlink to a blocked image path", async () => {
      const logger = createTestLogger();
      const attachmentsDir = join(workspace, "attachments");
      const blockedPath = join(attachmentsDir, "image.png");
      const linkPath = join(workspace, "image-link");
      await mkdir(attachmentsDir);
      await writeFile(blockedPath, "image");
      await symlink(blockedPath, linkPath);
      const agentTool = createCanUseTool(workspace, logger, claudeDir, {
        blockedReadPaths: [blockedPath],
        blockImageReads: true,
      });

      const result = await agentTool("Read", { file_path: linkPath });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
    });

    it("allows non-Read file tools for blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/image.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Grep", { path: blockedPath });

      expect(result.behavior).toBe("allow");
    });

    it("denies Bash commands that reference blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/image.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: `base64 "${blockedPath}"` });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
      expect(result.message).toContain(blockedPath);
    });

    it("denies Bash commands that reference blocked attachment paths relative to the workspace", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/image.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: "cat ./attachments/image.png" });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
    });

    it("denies Bash commands with relative globs that match blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/photo.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: "base64 attachments/*.png" });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
    });

    it("denies Bash commands with absolute globs that match blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/photo.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: `cat ${workspace}/attachments/photo.*` });

      expectDeny(result);
      expect(result.message).toContain("Use mcp__sketch__VisualAnalysis");
    });

    it("allows Bash commands that do not reference blocked attachment paths", async () => {
      const logger = createTestLogger();
      const blockedPath = `${workspace}/attachments/image.png`;
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { blockedReadPaths: [blockedPath] });

      const result = await agentTool("Bash", { command: "cat notes.txt" });

      expect(result.behavior).toBe("allow");
    });
  });

  describe("file tools — ~/.claude access", () => {
    it("allows Read tool with ~/.claude/skills/canvas/SKILL.md", async () => {
      const result = await canUseTool("Read", { file_path: `${claudeDir}/skills/canvas/SKILL.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Glob tool with ~/.claude/skills/ path", async () => {
      const result = await canUseTool("Glob", { path: `${claudeDir}/skills/` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Grep tool with ~/.claude path", async () => {
      const result = await canUseTool("Grep", { path: claudeDir });
      expect(result.behavior).toBe("allow");
    });

    it("allows Write tool with ~/.claude/CLAUDE.md (org memory)", async () => {
      const result = await canUseTool("Write", { file_path: `${claudeDir}/CLAUDE.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Edit tool with ~/.claude/CLAUDE.md (org memory)", async () => {
      const result = await canUseTool("Edit", { file_path: `${claudeDir}/CLAUDE.md` });
      expect(result.behavior).toBe("allow");
    });

    it("denies path that shares claude dir prefix but is a sibling directory", async () => {
      const result = await canUseTool("Read", { file_path: `${claudeDir}-other/secrets.txt` });
      expectDeny(result);
      expect(result.message).toContain("outside your workspace");
    });
  });

  describe("bash validation", () => {
    it("allows command with no absolute paths", async () => {
      const result = await canUseTool("Bash", { command: "ls" });
      expect(result.behavior).toBe("allow");
    });

    it("allows command like 'echo hello'", async () => {
      const result = await canUseTool("Bash", { command: "echo hello" });
      expect(result.behavior).toBe("allow");
    });

    it("allows command referencing workspace path", async () => {
      const result = await canUseTool("Bash", { command: `cat ${workspace}/notes.md` });
      expect(result.behavior).toBe("allow");
    });

    it("allows literal relative workspace commands", async () => {
      const catResult = await canUseTool("Bash", { command: "cat notes.txt" });
      const lsResult = await canUseTool("Bash", { command: "ls ./sub" });
      expect(catResult.behavior).toBe("allow");
      expect(lsResult.behavior).toBe("allow");
    });

    it("allows command referencing ~/.claude path", async () => {
      const result = await canUseTool("Bash", { command: `cat ${claudeDir}/skills/canvas/SKILL.md` });
      expect(result.behavior).toBe("allow");
    });

    it("denies command referencing /etc/passwd", async () => {
      const result = await canUseTool("Bash", { command: "cat /etc/passwd" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it.each(["cat</etc/passwd", "cat >>/etc/hosts"])(
      "denies command with redirection-prefixed absolute path: %s",
      async (command) => {
        const result = await canUseTool("Bash", { command });
        expectDeny(result);
        expect(result.message).toContain("must operate within your workspace");
      },
    );

    it("denies command referencing /home/otheruser/", async () => {
      const result = await canUseTool("Bash", { command: "ls /home/otheruser/" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it("allows command with /dev/null", async () => {
      const result = await canUseTool("Bash", { command: "echo test > /dev/null" });
      expect(result.behavior).toBe("allow");
    });

    it("allows command with /tmp/ path", async () => {
      const result = await canUseTool("Bash", { command: "cat /tmp/somefile.txt" });
      expect(result.behavior).toBe("allow");
    });

    it("allows redirection-prefixed /tmp/ paths under the existing carveout", async () => {
      const result = await canUseTool("Bash", { command: "echo x>/tmp/leak" });
      expect(result.behavior).toBe("allow");
    });

    it("denies command with /data/ prefix outside workspace and claude dir", async () => {
      const result = await canUseTool("Bash", { command: "ls /data/shared" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it("denies chained commands that reference absolute paths outside the workspace", async () => {
      const result = await canUseTool("Bash", { command: "echo ok && cat /etc/passwd" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it.each([
      "cat $HOME/.ssh/id_rsa",
      "cat $(printf /etc/passwd)",
      "cat ${HOME}/x",
      "cat ~/secret",
      "cat `printf /etc`",
    ])("denies Bash commands that construct paths through shell expansion: %s", async (command) => {
      const result = await canUseTool("Bash", { command });
      expectDeny(result);
      expect(result.message).toContain("must use literal paths within the workspace");
    });

    it("allows command referencing the absolute workspace path", async () => {
      const result = await canUseTool("Bash", { command: `cat ${workspace}/file.txt` });
      expect(result.behavior).toBe("allow");
    });

    it("allows Canvas CLI as the first executable after shell-expansion checks", async () => {
      const result = await canUseTool("Bash", { command: "$CANVAS_CLI search foo" });
      expect(result.behavior).toBe("allow");
    });

    it("allows genuine Canvas CLI commands with shell metacharacters in JSON values", async () => {
      const result = await canUseTool("Bash", {
        command:
          'CANVAS_LOG=debug "$CANVAS_CLI" direct-execute-action --component-key clickup-create-task --configured-props \'{"name":"Script / Quote | Parent","description":"quoted \\"value\\"; A/B test","path":"/etc/passwd"}\' --output json',
      });
      expect(result.behavior).toBe("allow");
    });

    it("temporarily allows brokered Canvas CLI commands with shell chaining", async () => {
      const result = await canUseTool("Bash", {
        command:
          '$CANVAS_CLI direct-execute-action --component-key clickup-create-task --configured-props \'{"name":"Script / Quote | Parent"}\' && cat /etc/passwd',
      });
      expect(result.behavior).toBe("allow");
    });

    it("denies commands that only mention Canvas CLI after the first executable", async () => {
      const result = await canUseTool("Bash", { command: "echo CANVAS_CLI; cat /etc/passwd" });
      expectDeny(result);
      expect(result.message).toContain("must operate within your workspace");
    });

    it("denies non-carveout Canvas CLI variable expansion before literal path scanning", async () => {
      const result = await canUseTool("Bash", {
        command: 'CANVAS_NOTE="$CANVAS_CLI" echo CANVAS_CLI; cat /etc/passwd',
      });
      expectDeny(result);
      expect(result.message).toContain("must use literal paths within the workspace");
    });
  });

  describe("edge cases", () => {
    it("allows WebSearch with no path validation", async () => {
      const result = await canUseTool("WebSearch", { query: "vitest testing" });
      expect(result.behavior).toBe("allow");
    });

    it("allows WebFetch with no path validation", async () => {
      const result = await canUseTool("WebFetch", { url: "https://example.com" });
      expect(result.behavior).toBe("allow");
    });

    it("allows Skill with no path validation", async () => {
      const result = await canUseTool("Skill", { name: "some-skill" });
      expect(result.behavior).toBe("allow");
    });
  });

  describe("agent allowlist", () => {
    it("allows tools that are in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { agentAllowedTools: ["Read", "Bash"] });

      const readResult = await agentTool("Read", { file_path: `${workspace}/notes.md` });
      expect(readResult.behavior).toBe("allow");

      const bashResult = await agentTool("Bash", { command: "ls" });
      expect(bashResult.behavior).toBe("allow");
    });

    it("denies built-in tools that are not in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { agentAllowedTools: ["Read"] });

      const result = await agentTool("Bash", { command: "ls" });
      expectDeny(result);
      expect(result.message).toContain("not in this agent's allowlist");
    });

    it("denies MCP tools that are not in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { agentAllowedTools: ["Read"] });

      const result = await agentTool("mcp__sketch__SendFileToChat", { file_path: `${workspace}/x` });
      expectDeny(result);
      expect(result.message).toContain("not in this agent's allowlist");
    });

    it("allows MCP tools that are in the agent's allowlist", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(workspace, logger, claudeDir, {
        agentAllowedTools: ["mcp__sketch__SendFileToChat"],
      });

      const result = await agentTool("mcp__sketch__SendFileToChat", { file_path: `${workspace}/x` });
      expect(result.behavior).toBe("allow");
    });

    it("treats an empty allowlist as 'block every tool' (admin opted out of all capabilities)", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { agentAllowedTools: [] });

      const builtIn = await agentTool("Read", { file_path: `${workspace}/notes.md` });
      expect(builtIn.behavior).toBe("deny");

      const mcp = await agentTool("mcp__sketch__SendMessage", { message: "hi" });
      expect(mcp.behavior).toBe("deny");
    });

    it("treats null/undefined allowlist as 'no agent restriction' (legacy or non-agent run)", async () => {
      const logger = createTestLogger();
      const agentTool = createCanUseTool(workspace, logger, claudeDir, { agentAllowedTools: null });

      const builtIn = await agentTool("Read", { file_path: `${workspace}/notes.md` });
      expect(builtIn.behavior).toBe("allow");

      const mcp = await agentTool("mcp__sketch__SendMessage", { message: "hi" });
      expect(mcp.behavior).toBe("allow");
    });
  });
});
