import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { cleanupIntegrationAccess, startIntegrationAccess } from "./wrapper";

function makeCanvasCliSource(): string {
  return `#!/usr/bin/env node
const mode = process.argv[2];

if (mode === 'env') {
  process.stdout.write(JSON.stringify({
    apiKey: process.env.CANVAS_API_KEY_MCP ?? null,
    email: process.env.CANVAS_USER_EMAIL ?? null,
    args: process.argv.slice(3),
  }));
  process.exit(0);
}

if (mode === 'stdin') {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { body += chunk; });
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ body }));
    process.exit(0);
  });
  process.stdin.resume();
  return;
}

if (mode === 'long') {
  process.stdout.write('abcdefghijklmnopqrstuvwxyz');
  process.exit(0);
}

if (mode === 'cwd') {
  process.stdout.write(JSON.stringify({ cwd: process.cwd() }));
  process.exit(0);
}

process.stderr.write('unknown mode');
process.exit(1);
`;
}

function spawnText(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

describe("startIntegrationAccess", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createAccess() {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-test-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "workspace-test-"));
    tempDirs.push(claudeDir);
    tempDirs.push(workspaceDir);
    const canvasDir = join(claudeDir, "skills", "canvas");
    mkdirSync(canvasDir, { recursive: true });
    writeFileSync(join(canvasDir, "canvas-cli.js"), makeCanvasCliSource(), { mode: 0o700 });

    const access = await startIntegrationAccess({
      userEmail: "agent@example.com",
      claudeConfigDir: claudeDir,
      workspaceDir,
      findIntegrationProvider: async () => ({
        type: "canvas",
        credentials: JSON.stringify({ apiKey: "secret-api-key-123" }),
      }),
      logger: createTestLogger(),
    });

    return { access, workspaceDir };
  }

  it("creates harmless launcher files and keeps raw credentials out of agent env", async () => {
    const { access } = await createAccess();

    expect(access.envVars.CANVAS_CLI).toBeTruthy();
    expect(access.envVars.CANVAS_API_KEY_MCP).toBeUndefined();
    expect(access.envVars.CANVAS_USER_EMAIL).toBeUndefined();

    for (const path of access.runtimePaths) {
      if (!existsSync(path)) continue;
      if (!path.endsWith(".sh") && !path.endsWith(".cjs")) continue;
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("secret-api-key-123");
      expect(content).not.toContain("agent@example.com");
    }

    await cleanupIntegrationAccess(access);
  });

  it("forwards argv and injects credentials only inside the brokered CLI child", async () => {
    const { access } = await createAccess();

    const result = await spawnText(access.envVars.CANVAS_CLI, ["env", "alpha", "beta"], {
      env: { ...process.env, ...access.envVars },
      cwd: tmpdir(),
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      apiKey: "secret-api-key-123",
      email: "agent@example.com",
      args: ["alpha", "beta"],
    });

    await cleanupIntegrationAccess(access);
  });

  it("forwards stdin through the launcher client to the real CLI", async () => {
    const { access } = await createAccess();

    const result = await spawnText(access.envVars.CANVAS_CLI, ["stdin"], {
      env: { ...process.env, ...access.envVars },
      cwd: tmpdir(),
      stdin: "hello broker",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ body: "hello broker" });

    await cleanupIntegrationAccess(access);
  });

  it("remains usable from Bash pipelines", async () => {
    const { access } = await createAccess();

    const result = await spawnText("/bin/bash", ["-lc", "$CANVAS_CLI long | head -c 8"], {
      env: { ...process.env, ...access.envVars },
      cwd: tmpdir(),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("abcdefgh");

    await cleanupIntegrationAccess(access);
  });

  it("pins the real CLI child cwd to the trusted workspace", async () => {
    const { access, workspaceDir } = await createAccess();

    const untrustedCwd = mkdtempSync(join(tmpdir(), "untrusted-cwd-"));
    tempDirs.push(untrustedCwd);

    const result = await spawnText(access.envVars.CANVAS_CLI, ["cwd"], {
      env: { ...process.env, ...access.envVars },
      cwd: untrustedCwd,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: realpathSync(workspaceDir) });

    await cleanupIntegrationAccess(access);
  });

  it("cleans up the runtime directory after the run", async () => {
    const { access } = await createAccess();
    const launcherPath = access.envVars.CANVAS_CLI;
    const runtimeDir = access.runtimePaths[0];

    expect(existsSync(launcherPath)).toBe(true);
    expect(existsSync(runtimeDir)).toBe(true);

    await cleanupIntegrationAccess(access);

    expect(existsSync(launcherPath)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
  });
});
