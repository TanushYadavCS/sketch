import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import type { ServerType } from "@hono/node-server";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import type { LocalDeviceRow, createLocalDeviceRepository } from "../db/repositories/local-devices";
import { hashLocalDeviceToken } from "./token";

type LocalDeviceRepository = ReturnType<typeof createLocalDeviceRepository>;

export interface LocalCommandRequest {
  deviceId?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  auditCommand?: string;
}

export interface LocalCommandResult {
  deviceId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  errorMessage?: string | null;
}

interface ConnectedDevice {
  row: LocalDeviceRow;
  socket: WebSocket;
  connectedAt: number;
}

interface PendingInvocation {
  resolve: (result: LocalCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  deviceId: string;
  userId: string;
  command: string;
  cwd?: string;
  startedAt: number;
}

function readToken(req: IncomingMessage, url: URL): string | null {
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return null;
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

export class LocalDeviceGateway {
  private connections = new Map<string, ConnectedDevice>();
  private pending = new Map<string, PendingInvocation>();
  private touchTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private repo: LocalDeviceRepository,
    private logger: Logger,
  ) {}

  attach(server: ServerType, path = "/api/local-devices/ws"): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", async (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const token = readToken(req, url);
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const device = await this.repo.findActiveByHash(hashLocalDeviceToken(token)).catch((err) => {
        this.logger.warn({ err }, "Failed to authenticate local device WebSocket");
        return undefined;
      });
      if (!device) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this.register(device, ws);
      });
    });
  }

  isOnline(deviceId: string): boolean {
    const connected = this.connections.get(deviceId);
    return Boolean(connected && isOpen(connected.socket));
  }

  disconnect(deviceId: string): void {
    const connected = this.connections.get(deviceId);
    if (connected) connected.socket.close(1000, "Device revoked");
  }

  async invoke(userId: string, request: LocalCommandRequest): Promise<LocalCommandResult> {
    const connected = await this.resolveDevice(userId, request.deviceId);
    const requestId = randomUUID();
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 120_000, 1_000), 300_000);
    const maxOutputBytes = Math.min(Math.max(request.maxOutputBytes ?? 200_000, 1_024), 1_000_000);
    const startedAt = Date.now();
    const auditBase = {
      deviceId: connected.row.id,
      userId,
      command: request.auditCommand ?? request.command,
      cwd: request.cwd,
      startedAt,
    };

    const result = await (async () => {
      try {
        return await new Promise<LocalCommandResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error("Local command timed out waiting for device response"));
          }, timeoutMs + 10_000);

          this.pending.set(requestId, {
            resolve,
            reject,
            timeout,
            deviceId: connected.row.id,
            userId,
            command: request.auditCommand ?? request.command,
            cwd: request.cwd,
            startedAt,
          });

          connected.socket.send(
            JSON.stringify({
              type: "command.request",
              requestId,
              command: request.command,
              cwd: request.cwd ?? null,
              timeoutMs,
              maxOutputBytes,
            }),
            (err) => {
              if (!err) return;
              clearTimeout(timeout);
              this.pending.delete(requestId);
              reject(err);
            },
          );
        });
      } catch (err) {
        await this.recordFailedLocalRunCommandAudit(auditBase, err);
        throw err;
      }
    })();

    await this.recordLocalRunCommandAudit({
      ...auditBase,
      success: result.exitCode === 0 && !result.timedOut && !result.errorMessage,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      errorMessage: result.errorMessage,
    });

    return result;
  }

  private async recordFailedLocalRunCommandAudit(
    input: {
      deviceId: string;
      userId: string;
      command: string;
      cwd?: string;
      startedAt: number;
    },
    err: unknown,
  ): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : "Local command invocation failed";
    try {
      await this.recordLocalRunCommandAudit({
        ...input,
        success: false,
        exitCode: null,
        timedOut: errorMessage.includes("timed out"),
        durationMs: Date.now() - input.startedAt,
        errorMessage,
      });
    } catch (auditErr) {
      this.logger.warn({ err: auditErr, deviceId: input.deviceId }, "Failed to audit local command failure");
    }
  }

  private async recordLocalRunCommandAudit(input: {
    deviceId: string;
    userId: string;
    command: string;
    cwd?: string | null;
    success: boolean;
    exitCode?: number | null;
    timedOut?: boolean;
    durationMs: number;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.repo.recordToolCall({
      deviceId: input.deviceId,
      userId: input.userId,
      toolName: "local_run_command",
      command: input.command,
      cwd: input.cwd,
      success: input.success,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      durationMs: input.durationMs,
      stdoutBytes: input.stdoutBytes,
      stderrBytes: input.stderrBytes,
      stdoutTruncated: input.stdoutTruncated,
      stderrTruncated: input.stderrTruncated,
      errorMessage: input.errorMessage,
    });
  }

  private register(row: LocalDeviceRow, socket: WebSocket): void {
    this.closeExisting(row.id, "Device reconnected");
    this.connections.set(row.id, { row, socket, connectedAt: Date.now() });
    this.repo.markConnected(row.id).catch((err) => this.logger.warn({ err, deviceId: row.id }, "Device mark failed"));
    socket.send(JSON.stringify({ type: "ready", deviceId: row.id }));

    const touchTimer = setInterval(() => {
      if (!isOpen(socket)) return;
      socket.ping();
      this.repo.touch(row.id).catch((err) => this.logger.warn({ err, deviceId: row.id }, "Device touch failed"));
    }, 30_000);
    this.touchTimers.set(row.id, touchTimer);

    socket.on("message", (data) => this.handleMessage(row.id, data.toString()));
    socket.on("close", () => this.unregister(row.id, socket));
    socket.on("error", (err) => {
      this.logger.warn({ err, deviceId: row.id }, "Local device WebSocket error");
      this.unregister(row.id, socket);
    });
  }

  private closeExisting(deviceId: string, reason: string): void {
    const connected = this.connections.get(deviceId);
    if (!connected) return;
    this.rejectPending(deviceId, reason);
    const timer = this.touchTimers.get(deviceId);
    if (timer) clearInterval(timer);
    this.touchTimers.delete(deviceId);
    this.connections.delete(deviceId);
    if (isOpen(connected.socket)) connected.socket.close(1000, reason);
  }

  private unregister(deviceId: string, socket?: WebSocket): void {
    const connected = this.connections.get(deviceId);
    if (socket && connected?.socket !== socket) return;
    const timer = this.touchTimers.get(deviceId);
    if (timer) clearInterval(timer);
    this.touchTimers.delete(deviceId);
    this.connections.delete(deviceId);
    this.rejectPending(deviceId, "Local device disconnected");
    this.repo.markDisconnected(deviceId).catch((err) => {
      this.logger.warn({ err, deviceId }, "Device disconnect mark failed");
    });
  }

  private rejectPending(deviceId: string, reason: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pending.delete(requestId);
    }
  }

  private async resolveDevice(userId: string, deviceId?: string): Promise<ConnectedDevice> {
    if (deviceId) {
      const row = await this.repo.findActiveById(userId, deviceId);
      if (!row) throw new Error("Requested local device was not found");
      const connected = this.connections.get(deviceId);
      if (connected?.row.user_id === userId && isOpen(connected.socket)) return connected;
      throw new Error("Requested local device is not online");
    }

    const candidates = [...this.connections.values()]
      .filter((device) => device.row.user_id === userId && isOpen(device.socket))
      .sort((a, b) => b.connectedAt - a.connectedAt);

    const connected = candidates[0];
    if (!connected) throw new Error("No local Mac is connected for this user");
    return connected;
  }

  private handleMessage(deviceId: string, raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.logger.warn({ deviceId }, "Invalid local device message");
      return;
    }

    if (message.type !== "command.result" || typeof message.requestId !== "string") return;

    const pending = this.pending.get(message.requestId);
    if (!pending || pending.deviceId !== deviceId) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);

    pending.resolve({
      deviceId,
      exitCode: typeof message.exitCode === "number" ? message.exitCode : null,
      stdout: typeof message.stdout === "string" ? message.stdout : "",
      stderr: typeof message.stderr === "string" ? message.stderr : "",
      timedOut: toBoolean(message.timedOut),
      durationMs: toNumber(message.durationMs, Date.now() - pending.startedAt),
      stdoutBytes: Math.max(0, Math.floor(toNumber(message.stdoutBytes, 0))),
      stderrBytes: Math.max(0, Math.floor(toNumber(message.stderrBytes, 0))),
      stdoutTruncated: toBoolean(message.stdoutTruncated),
      stderrTruncated: toBoolean(message.stderrTruncated),
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : null,
    });
  }
}
