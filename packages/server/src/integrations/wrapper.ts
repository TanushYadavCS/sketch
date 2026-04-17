/**
 * Per-run integration CLI access broker.
 *
 * The agent still invokes a CLI through Bash via $CANVAS_CLI, but that path now
 * points to a harmless launcher. The launcher forwards argv/stdin over a local
 * Unix socket to a broker owned by the trusted server process. The broker then
 * spawns the real CLI with credential env vars.
 *
 * This preserves the Bash UX while removing the secret-bearing wrapper file.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger";

interface SkillModeProvider {
  type: string;
  credentials: string;
}

export interface IntegrationAccessResult {
  envVars: Record<string, string>;
  runtimePaths: string[];
  cleanup: () => Promise<void>;
}

interface BrokerMessage {
  type: "start" | "stdin" | "stdin_end" | "stdout" | "stderr" | "exit" | "error";
  token?: string;
  argv?: string[];
  data?: string;
  code?: number | null;
  message?: string;
}

/**
 * Start per-run brokered access for skill-mode integration CLIs.
 * The agent receives only harmless launcher env vars; credentials stay in the
 * trusted broker process and are injected only into the real CLI child.
 */
export async function startIntegrationAccess(params: {
  userEmail: string | null;
  claudeConfigDir: string;
  workspaceDir: string;
  findIntegrationProvider: () => Promise<SkillModeProvider | null>;
  logger: Logger;
}): Promise<IntegrationAccessResult> {
  const { userEmail, logger, claudeConfigDir, workspaceDir } = params;
  const envVars: Record<string, string> = {};

  const provider = await params.findIntegrationProvider();
  if (!provider) {
    return { envVars, runtimePaths: [], cleanup: async () => {} };
  }

  if (provider.type !== "canvas") {
    return { envVars, runtimePaths: [], cleanup: async () => {} };
  }

  const creds = JSON.parse(provider.credentials) as Record<string, string>;
  const cliPath = join(claudeConfigDir, "skills", "canvas", "canvas-cli.js");
  const credentialEnv: Record<string, string> = {};
  if (creds.apiKey) credentialEnv.CANVAS_API_KEY_MCP = creds.apiKey;
  if (userEmail) credentialEnv.CANVAS_USER_EMAIL = userEmail;

  const runtimeDir = await mkdtemp(join(tmpdir(), "sk-int-"));
  await chmod(runtimeDir, 0o700);

  const socketPath = join(runtimeDir, "s.sock");
  const token = randomBytes(24).toString("hex");
  const clientPath = join(runtimeDir, "launcher-client.cjs");
  const launcherPath = join(runtimeDir, "canvas-cli.sh");
  let closeBroker: (() => Promise<void>) | null = null;

  try {
    await writeFile(clientPath, buildLauncherClientSource(), { mode: 0o600 });
    await writeFile(launcherPath, buildLauncherShellSource(clientPath), { mode: 0o700 });

    closeBroker = await startCanvasBroker({
      socketPath,
      token,
      cliPath,
      credentialEnv,
      workspaceDir,
      logger,
    });
  } catch (err) {
    if (closeBroker) {
      try {
        await closeBroker();
      } catch {}
    }
    try {
      await rm(runtimeDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }

  envVars.CANVAS_CLI = launcherPath;
  envVars.SKETCH_INT_SOCKET = socketPath;
  envVars.SKETCH_INT_TOKEN = token;

  logger.debug({ runtimeDir, launcherPath, socketPath }, "Integration access: started brokered launcher");

  return {
    envVars,
    runtimePaths: [runtimeDir, launcherPath, clientPath, socketPath],
    cleanup: async () => {
      await closeBroker();
      try {
        await rm(runtimeDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function cleanupIntegrationAccess(result: IntegrationAccessResult): Promise<void> {
  await result.cleanup();
}

function buildLauncherShellSource(clientPath: string): string {
  return `#!/bin/sh
exec "${process.execPath}" "${clientPath}" "$@"
`;
}

function buildLauncherClientSource(): string {
  return `'use strict';

const net = require('node:net');

const socketPath = process.env.SKETCH_INT_SOCKET;
const token = process.env.SKETCH_INT_TOKEN;

if (!socketPath || !token) {
  process.stderr.write('Missing broker configuration\\n');
  process.exit(1);
}

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

process.stderr.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

const socket = net.createConnection(socketPath);
let buffer = '';
let exited = false;

function send(msg) {
  socket.write(JSON.stringify(msg) + '\\n');
}

function flushLines(chunk) {
  buffer += chunk.toString('utf8');
  while (true) {
    const idx = buffer.indexOf('\\n');
    if (idx === -1) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'stdout' && msg.data) {
      process.stdout.write(Buffer.from(msg.data, 'base64'));
      continue;
    }
    if (msg.type === 'stderr' && msg.data) {
      process.stderr.write(Buffer.from(msg.data, 'base64'));
      continue;
    }
    if (msg.type === 'error') {
      if (msg.message) process.stderr.write(msg.message + '\\n');
      exited = true;
      process.exit(1);
    }
    if (msg.type === 'exit') {
      exited = true;
      process.exit(typeof msg.code === 'number' ? msg.code : 1);
    }
  }
}

socket.on('connect', () => {
  send({ type: 'start', token, argv: process.argv.slice(2) });
  process.stdin.on('data', (chunk) => send({ type: 'stdin', data: chunk.toString('base64') }));
  process.stdin.on('end', () => send({ type: 'stdin_end' }));
  process.stdin.resume();
});

socket.on('data', flushLines);
socket.on('error', (err) => {
  process.stderr.write((err && err.message) ? err.message + '\\n' : 'Broker connection failed\\n');
  process.exit(1);
});
socket.on('close', () => {
  if (!exited) process.exit(1);
});
`;
}

async function startCanvasBroker(params: {
  socketPath: string;
  token: string;
  cliPath: string;
  credentialEnv: Record<string, string>;
  workspaceDir: string;
  logger: Logger;
}): Promise<() => Promise<void>> {
  const { socketPath, token, cliPath, credentialEnv, workspaceDir, logger } = params;
  const sockets = new Set<Socket>();
  const children = new Set<ChildProcessWithoutNullStreams>();

  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    let buffer = "";
    let child: ChildProcessWithoutNullStreams | null = null;
    let started = false;

    const send = (message: BrokerMessage) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };

    const killChild = () => {
      if (child && child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        const forceKillTimer = setTimeout(() => {
          if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
        }, 1000);
        forceKillTimer.unref();
      }
    };

    const startChild = (message: BrokerMessage) => {
      if (started) {
        send({ type: "error", message: "Integration broker already started for this connection" });
        socket.end();
        return;
      }
      if (message.token !== token) {
        send({ type: "error", message: "Integration broker token mismatch" });
        socket.end();
        return;
      }
      if (!Array.isArray(message.argv) || !message.argv.every((v) => typeof v === "string")) {
        send({ type: "error", message: "Integration broker received invalid argv" });
        socket.end();
        return;
      }

      started = true;
      child = spawn(process.execPath, [cliPath, ...message.argv], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          ...credentialEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const currentChild = child;

      currentChild.stdout.on("data", (chunk: Buffer) => send({ type: "stdout", data: chunk.toString("base64") }));
      currentChild.stderr.on("data", (chunk: Buffer) => send({ type: "stderr", data: chunk.toString("base64") }));
      currentChild.on("error", (err: Error) => {
        logger.warn({ err }, "Integration broker child failed");
        send({ type: "error", message: err.message });
        socket.end();
      });
      currentChild.on("close", (code: number | null) => {
        children.delete(currentChild);
        send({ type: "exit", code });
        socket.end();
      });
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;

        let message: BrokerMessage;
        try {
          message = JSON.parse(line) as BrokerMessage;
        } catch {
          send({ type: "error", message: "Integration broker received invalid JSON" });
          socket.end();
          return;
        }

        if (message.type === "start") {
          startChild(message);
          continue;
        }
        if (message.type === "stdin" && child?.stdin.writable && message.data) {
          child.stdin.write(Buffer.from(message.data, "base64"));
          continue;
        }
        if (message.type === "stdin_end" && child?.stdin.writable) {
          child.stdin.end();
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      killChild();
    });
    socket.on("error", () => {
      sockets.delete(socket);
      killChild();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await unlink(socketPath);
    } catch {}
  };
}
