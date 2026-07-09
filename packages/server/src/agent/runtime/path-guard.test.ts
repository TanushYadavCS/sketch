import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeWorkspaceToolScopePolicy } from "./contracts";
import {
  createAgentRuntimeWorkspaceToolScopePolicy,
  decideRuntimePathContainment,
  guardRuntimeGlob,
  guardRuntimePath,
  scanRuntimeBashCommand,
} from "./path-guard";

describe("agent runtime path guard", () => {
  let root: string;
  let workspace: string;
  let orgClaudeDir: string;
  let scope: AgentRuntimeWorkspaceToolScopePolicy;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-runtime-guard-"));
    workspace = join(root, "workspace");
    orgClaudeDir = join(root, "claude");
    await mkdir(workspace);
    await mkdir(orgClaudeDir);
    scope = await createAgentRuntimeWorkspaceToolScopePolicy({ workspaceRoot: workspace, orgClaudeDir });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("allows existing and not-yet-existing paths inside the workspace root", async () => {
    await writeFile(join(workspace, "notes.txt"), "notes");

    await expect(guardRuntimePath({ path: join(workspace, "notes.txt"), scope })).resolves.toMatchObject({
      root: { kind: "workspace-root" },
    });
    await expect(guardRuntimePath({ path: "new/deep/file.txt", scope })).resolves.toMatchObject({
      root: { kind: "workspace-root" },
    });
  });

  it("allows paths inside the org claude directory", async () => {
    await writeFile(join(orgClaudeDir, "CLAUDE.md"), "org memory");

    await expect(guardRuntimePath({ path: join(orgClaudeDir, "CLAUDE.md"), scope })).resolves.toMatchObject({
      root: { kind: "org-claude-dir" },
    });
  });

  it("skips a missing org claude directory without dropping the workspace root", async () => {
    const missingOrgClaudeDir = join(root, "missing-claude");
    const logger = { debug: vi.fn() };

    const tolerantScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir: missingOrgClaudeDir,
      logger,
    });

    expect(tolerantScope.allowedRoots.workspaceRoot).toMatchObject({ kind: "workspace-root", path: workspace });
    expect(tolerantScope.allowedRoots.orgClaudeDir).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      { kind: "org-claude-dir", path: missingOrgClaudeDir },
      "Org Claude dir absent, skipping runtime tool root",
    );
    await expect(guardRuntimePath({ path: "new/file.txt", scope: tolerantScope })).resolves.toMatchObject({
      root: { kind: "workspace-root" },
    });
  });

  it("still rejects a missing workspace root", async () => {
    const missingWorkspace = join(root, "missing-workspace");

    await expect(
      createAgentRuntimeWorkspaceToolScopePolicy({ workspaceRoot: missingWorkspace, orgClaudeDir }),
    ).rejects.toThrow(`Runtime tool root does not exist or cannot be resolved: ${missingWorkspace}`);
  });

  it("denies a sibling path that only shares the workspace prefix", async () => {
    const sibling = join(root, "workspace-evil", "secret.txt");

    await expect(guardRuntimePath({ path: sibling, scope })).rejects.toThrow("outside the allowed workspace roots");
  });

  it("denies a symlink inside the workspace when its target points outside", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "escape"), "dir");

    const decision = await decideRuntimePathContainment({
      path: join(workspace, "escape", "secret.txt"),
      scope,
    });

    expect(decision).toMatchObject({
      behavior: "deny",
      reason: "outside_allowed_roots",
    });
  });

  it("allows a symlink inside the workspace when its target stays inside the workspace", async () => {
    await writeFile(join(workspace, "target.txt"), "inside");
    await symlink(join(workspace, "target.txt"), join(workspace, "inside-link.txt"));

    await expect(guardRuntimePath({ path: join(workspace, "inside-link.txt"), scope })).resolves.toMatchObject({
      root: { kind: "workspace-root" },
    });
  });

  it("denies parent traversal after a symlinked directory component resolves outside", async () => {
    const outsideDir = join(root, "outside-repro");
    const outsideFile = join(root, "secret.txt");
    await mkdir(outsideDir);
    await writeFile(outsideFile, "secret");
    await symlink(outsideDir, join(workspace, "link"), "dir");
    const outsideFileRealpath = await realpath(outsideFile);

    const decision = await decideRuntimePathContainment({
      path: `${join(workspace, "link")}/../secret.txt`,
      scope,
    });

    expect(decision).toMatchObject({
      behavior: "deny",
      reason: "outside_allowed_roots",
      targetRealpath: outsideFileRealpath,
    });
  });

  it("denies missing-segment parent traversal before a symlink escape", async () => {
    const outsideDir = join(root, "outside-missing-repro");
    await mkdir(outsideDir);
    await symlink(outsideDir, join(workspace, "link"), "dir");
    const outsideDirRealpath = await realpath(outsideDir);

    const decision = await decideRuntimePathContainment({
      path: `${workspace}/missing/../link/new.txt`,
      scope,
    });

    expect(decision).toMatchObject({
      behavior: "deny",
      reason: "outside_allowed_roots",
      targetRealpath: join(outsideDirRealpath, "new.txt"),
    });
  });

  it("fails closed on dangling symlinks", async () => {
    await symlink(join(root, "missing-target"), join(workspace, "dangling"));

    const decision = await decideRuntimePathContainment({
      path: join(workspace, "dangling", "file.txt"),
      scope,
    });

    expect(decision).toMatchObject({
      behavior: "deny",
      reason: "invalid_path",
    });
  });

  it("records blocked read paths by real target so a direct symlink to a blocked path remains blocked", async () => {
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
    const guardedLink = await guardRuntimePath({ path: join(workspace, "image-link"), scope: blockedScope });

    expect(blockedScope.blockedReadPaths).toContain(guardedLink.realpath);
  });

  it("blocks Bash commands that reference a blocked root file by bare filename", async () => {
    const blockedPath = join(workspace, "image.png");
    await writeFile(blockedPath, "image");
    const blockedRealpath = await realpath(blockedPath);
    const blockedScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockedReadPaths: [blockedPath],
    });

    await expect(scanRuntimeBashCommand({ command: "cat image.png", scope: blockedScope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: blockedRealpath,
      message: expect.stringContaining("VisualAnalysis"),
    });
  });

  it("validates glob patterns without allowing parent segments or out-of-root absolute bases", async () => {
    await expect(guardRuntimeGlob({ pattern: "src/**/*.ts", scope })).resolves.toBeUndefined();
    await expect(guardRuntimeGlob({ pattern: "../*.ts", scope })).rejects.toThrow(
      "Glob patterns must not contain parent directory segments",
    );
    await expect(guardRuntimeGlob({ pattern: join(root, "outside/**/*.ts"), scope })).rejects.toThrow(
      "outside the allowed workspace roots",
    );
    await expect(guardRuntimeGlob({ pattern: join(workspace, "src/**/*.ts"), scope })).resolves.toBeUndefined();
  });

  it("denies absolute glob bases that resolve outside through a symlink", async () => {
    const outside = join(root, "outside-glob");
    await mkdir(outside);
    await symlink(outside, join(workspace, "glob-link"), "dir");

    await expect(guardRuntimeGlob({ pattern: join(workspace, "glob-link/**/*.ts"), scope })).rejects.toThrow(
      "outside the allowed workspace roots",
    );
  });

  it("blocks Bash commands that reference absolute paths outside allowed roots", async () => {
    await writeFile(join(workspace, "notes.txt"), "notes");

    await expect(scanRuntimeBashCommand({ command: `cat ${workspace}/notes.txt`, scope })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(scanRuntimeBashCommand({ command: "echo ok && cat /etc/passwd", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "/etc/passwd",
    });
    await expect(scanRuntimeBashCommand({ command: "cat</etc/passwd", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "/etc/passwd",
    });
    await expect(scanRuntimeBashCommand({ command: "echo x>/tmp/leak", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "/tmp/leak",
    });
    await expect(scanRuntimeBashCommand({ command: "cat >>/etc/hosts", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "/etc/hosts",
    });
    await expect(scanRuntimeBashCommand({ command: "echo x > ./out.txt", scope })).resolves.toMatchObject({
      behavior: "allow",
    });
  });

  it("denies Bash commands that construct paths through shell expansion", async () => {
    await expect(scanRuntimeBashCommand({ command: "cat $HOME/.ssh/id_rsa", scope })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(scanRuntimeBashCommand({ command: "cat $(printf /etc/passwd)", scope })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(scanRuntimeBashCommand({ command: "cat ${HOME}/x", scope })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(scanRuntimeBashCommand({ command: "cat ~/secret", scope })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(scanRuntimeBashCommand({ command: "cat `printf /etc`", scope })).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  it("allows literal workspace Bash commands after shell-expansion checks", async () => {
    const subdir = join(workspace, "sub");
    await mkdir(subdir);
    await writeFile(join(workspace, "notes.txt"), "notes");
    await writeFile(join(subdir, "inside.txt"), "inside");

    await expect(scanRuntimeBashCommand({ command: "cat notes.txt", scope })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(scanRuntimeBashCommand({ command: "ls ./sub", scope })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(
      scanRuntimeBashCommand({ command: `cat ${join(workspace, "notes.txt")}`, scope }),
    ).resolves.toMatchObject({
      behavior: "allow",
    });
  });

  it("blocks Bash image reads by extension only when image blocking is enabled", async () => {
    const imagePath = join(workspace, "chart.png");
    await writeFile(imagePath, "image");
    const imageBlockingScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockImageReads: true,
    });
    const imageAllowedScope = await createAgentRuntimeWorkspaceToolScopePolicy({
      workspaceRoot: workspace,
      orgClaudeDir,
      blockImageReads: false,
    });

    await expect(
      scanRuntimeBashCommand({ command: "cat chart.png", scope: imageBlockingScope }),
    ).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "chart.png",
      message: expect.stringContaining("VisualAnalysis"),
    });
    await expect(scanRuntimeBashCommand({ command: "cat chart.png", scope: imageAllowedScope })).resolves.toMatchObject(
      {
        behavior: "allow",
      },
    );
  });

  it("blocks Bash commands that reference relative paths outside allowed roots", async () => {
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    await writeFile(join(workspace, "notes.txt"), "notes");

    await expect(scanRuntimeBashCommand({ command: "cat ./notes.txt", scope })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(scanRuntimeBashCommand({ command: "cat ../outside/secret.txt", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "../outside/secret.txt",
    });
    await expect(scanRuntimeBashCommand({ command: "cat '..'", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "..",
    });
    await expect(scanRuntimeBashCommand({ command: "cat ../../etc/passwd", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "../../etc/passwd",
    });
    await expect(
      scanRuntimeBashCommand({ command: "printf leak > ../outside/leak.txt", scope }),
    ).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "../outside/leak.txt",
    });
  });

  it("tracks Bash cd cwd across OR and newline connectors", async () => {
    const subdir = join(workspace, "subdir");
    await mkdir(subdir);
    await writeFile(join(subdir, "notes.txt"), "notes");

    await expect(
      scanRuntimeBashCommand({ command: "false || cd .. && cat outside/secret.txt", scope }),
    ).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "..",
    });
    await expect(scanRuntimeBashCommand({ command: "cd ..\ncat outside/secret.txt", scope })).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "..",
    });
    await expect(scanRuntimeBashCommand({ command: "cd subdir\ncat ./notes.txt", scope })).resolves.toMatchObject({
      behavior: "allow",
    });
  });

  it("keeps genuine Canvas CLI invocations outside the generic absolute-path scan", async () => {
    await expect(
      scanRuntimeBashCommand({
        command: "$CANVAS_CLI search foo",
        scope,
        canvasCliEnvVar: "CANVAS_CLI",
      }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      scanRuntimeBashCommand({
        command:
          'CANVAS_LOG=debug "$CANVAS_CLI" direct-execute-action --configured-props \'{"text":"quoted \\"value\\"; pipe | ok","path":"/etc/passwd"}\' --output json',
        scope,
        canvasCliEnvVar: "CANVAS_CLI",
      }),
    ).resolves.toMatchObject({ behavior: "allow" });
  });

  it("scans commands that only mention Canvas CLI after the first executable", async () => {
    await expect(
      scanRuntimeBashCommand({
        command: "echo CANVAS_CLI; cat /etc/passwd",
        scope,
        canvasCliEnvVar: "CANVAS_CLI",
      }),
    ).resolves.toMatchObject({
      behavior: "deny",
      blockedPath: "/etc/passwd",
    });
  });

  it("denies non-carveout Canvas CLI variable expansion before literal path scanning", async () => {
    await expect(
      scanRuntimeBashCommand({
        command: 'CANVAS_NOTE="$CANVAS_CLI" echo CANVAS_CLI; cat /etc/passwd',
        scope,
        canvasCliEnvVar: "CANVAS_CLI",
      }),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("must use literal paths within the workspace"),
    });
  });
});
