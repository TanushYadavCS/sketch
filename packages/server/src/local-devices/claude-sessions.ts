import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  LocalClaudeSessionOrigin,
  LocalClaudeSessionRow,
  LocalClaudeSessionStatus,
  createLocalClaudeSessionRepository,
} from "../db/repositories/local-claude-sessions";
import type { LocalCommandResult, LocalDeviceGateway } from "./gateway";

type LocalClaudeSessionRepository = ReturnType<typeof createLocalClaudeSessionRepository>;

export interface LocalClaudeSessionServiceConfig {
  baseUrl?: string;
  port: number;
}

export interface LocalClaudeSessionCreateInput {
  userId: string;
  prompt: string;
  title?: string;
  cwd?: string;
  deviceId?: string;
  origin?: LocalClaudeSessionOrigin;
}

export interface LocalClaudeSessionEventInput {
  token: string;
  expectedSessionId?: string;
  eventType: string;
  payload: unknown;
}

export interface LocalClaudeEventDelivery {
  session: LocalClaudeSessionRow;
  status: LocalClaudeSessionStatus;
  message: string;
}

const SAFE_KEY_NAMES = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "BSpace",
  "C-c",
  "C-d",
  "Up",
  "Down",
  "Left",
  "Right",
]);

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function publicBaseUrl(config: LocalClaudeSessionServiceConfig): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/$/, "");
  return `http://localhost:${config.port}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function jsonForShell(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sessionName(id: string): string {
  return `sketch-${id.replaceAll("-", "").slice(0, 24)}`;
}

function titleFromPrompt(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .find((part) => part.trim())
      ?.trim() ?? "Claude Code session";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function textFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "title", "last_assistant_message", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function notificationType(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const value = record.notification_type ?? record.notificationType ?? record.type;
  return typeof value === "string" ? value : null;
}

function statusForEvent(eventType: string, payload: unknown): LocalClaudeSessionStatus {
  if (eventType === "Stop") return "completed_turn";
  if (eventType === "StopFailure") return "failed";
  if (eventType === "SessionEnd") return "ended";
  if (eventType === "Notification") {
    const type = notificationType(payload);
    if (type === "permission_prompt") return "needs_permission";
    return "waiting_for_input";
  }
  return "running";
}

function eventMessage(eventType: string, status: LocalClaudeSessionStatus, payload: unknown): string {
  const text = textFromPayload(payload);
  if (status === "needs_permission")
    return text ? `Claude Code needs permission: ${text}` : "Claude Code needs permission.";
  if (status === "waiting_for_input") return text ? `Claude Code needs input: ${text}` : "Claude Code needs input.";
  if (status === "completed_turn")
    return text ? `Claude Code completed a turn: ${text}` : "Claude Code completed a turn.";
  if (status === "failed") return text ? `Claude Code failed: ${text}` : "Claude Code failed.";
  if (status === "ended") return "Claude Code session ended.";
  return text ? `${eventType}: ${text}` : `${eventType} received.`;
}

function hookCommand(eventUrl: string, token: string, eventType: string): string {
  const url = `${eventUrl}?type=${encodeURIComponent(eventType)}`;
  return `/usr/bin/curl -fsS -X POST -H ${shellQuote(`Authorization: Bearer ${token}`)} -H ${shellQuote(
    "Content-Type: application/json",
  )} --data-binary @- ${shellQuote(url)} >/dev/null || true`;
}

function settingsJson(eventUrl: string, token: string) {
  const hook = (eventType: string) => [
    {
      matcher: "",
      hooks: [{ type: "command", command: hookCommand(eventUrl, token, eventType) }],
    },
  ];
  return {
    hooks: {
      Notification: hook("Notification"),
      Stop: hook("Stop"),
      StopFailure: hook("StopFailure"),
      SessionEnd: hook("SessionEnd"),
    },
  };
}

function createLaunchCommand(input: {
  sessionId: string;
  tmuxSessionName: string;
  prompt: string;
  cwd?: string;
  eventUrl: string;
  eventToken: string;
}): string {
  const rootDirExpr = `"$HOME/.sketch/local-claude/${input.sessionId}"`;
  const settingsPathExpr = `"$HOME/.sketch/local-claude/${input.sessionId}/settings.json"`;
  const promptPathExpr = `"$HOME/.sketch/local-claude/${input.sessionId}/prompt.txt"`;
  const promptDelimiter = `SKETCH_CLAUDE_PROMPT_${input.sessionId.replaceAll("-", "_")}`;
  const settings = jsonForShell(settingsJson(input.eventUrl, input.eventToken));
  const innerCommand = [
    `exec claude --permission-mode bypassPermissions --settings ${settingsPathExpr} "$(cat ${promptPathExpr})"`,
  ].join("; ");
  const cwdPart = input.cwd?.trim() ? ` -c ${shellQuote(input.cwd.trim())}` : "";

  return [
    "set -euo pipefail",
    "command -v tmux >/dev/null",
    "command -v claude >/dev/null",
    `mkdir -p ${rootDirExpr}`,
    `cat > ${settingsPathExpr} <<'SKETCH_CLAUDE_SETTINGS'\n${settings}\nSKETCH_CLAUDE_SETTINGS`,
    `cat > ${promptPathExpr} <<'${promptDelimiter}'\n${input.prompt}\n${promptDelimiter}`,
    `tmux new-session -d -s ${shellQuote(input.tmuxSessionName)}${cwdPart} ${shellQuote(innerCommand)}`,
  ].join("\n");
}

function captureCommand(tmuxSessionName: string, lines: number): string {
  return `tmux capture-pane -p -S -${Math.max(1, Math.min(lines, 1000))} -t ${shellQuote(`${tmuxSessionName}:0.0`)}`;
}

function sendTextCommand(tmuxSessionName: string, text: string, submit: boolean): string {
  const commands = [`tmux send-keys -t ${shellQuote(`${tmuxSessionName}:0.0`)} -l ${shellQuote(text)}`];
  if (submit) commands.push(`tmux send-keys -t ${shellQuote(`${tmuxSessionName}:0.0`)} Enter`);
  return commands.join("\n");
}

function sendKeyCommand(tmuxSessionName: string, key: string): string {
  if (!SAFE_KEY_NAMES.has(key)) throw new Error(`Unsupported key: ${key}`);
  return `tmux send-keys -t ${shellQuote(`${tmuxSessionName}:0.0`)} ${shellQuote(key)}`;
}

function sessionStatusCommand(tmuxSessionName: string): string {
  return `tmux has-session -t ${shellQuote(tmuxSessionName)} 2>/dev/null`;
}

export class LocalClaudeSessionService {
  constructor(
    private repo: LocalClaudeSessionRepository,
    private localDeviceInvoker: Pick<LocalDeviceGateway, "invoke">,
    private config: LocalClaudeSessionServiceConfig,
  ) {}

  async create(
    input: LocalClaudeSessionCreateInput,
  ): Promise<{ session: LocalClaudeSessionRow; launch: LocalCommandResult }> {
    const preflight = await this.localDeviceInvoker.invoke(input.userId, {
      deviceId: input.deviceId,
      command: "command -v tmux >/dev/null && command -v claude >/dev/null",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      auditCommand: "local_claude_session preflight",
    });
    if (preflight.exitCode !== 0 || preflight.timedOut || preflight.errorMessage) {
      throw new Error("Sketch Local Claude sessions require both tmux and claude to be installed on the paired Mac.");
    }

    const id = randomUUID();
    const eventToken = `skc_${randomBytes(32).toString("base64url")}`;
    const tmuxSessionName = sessionName(id);
    const eventUrl = `${publicBaseUrl(this.config)}/api/local-claude-sessions/${id}/events`;
    const session = await this.repo.create({
      id,
      userId: input.userId,
      deviceId: preflight.deviceId,
      tmuxSessionName,
      title: input.title?.trim() || titleFromPrompt(input.prompt),
      cwd: input.cwd?.trim() || null,
      eventTokenHash: tokenHash(eventToken),
      origin: input.origin,
    });

    try {
      const launch = await this.localDeviceInvoker.invoke(input.userId, {
        deviceId: preflight.deviceId,
        command: createLaunchCommand({
          sessionId: id,
          tmuxSessionName,
          prompt: input.prompt,
          cwd: input.cwd,
          eventUrl,
          eventToken,
        }),
        timeoutMs: 30_000,
        maxOutputBytes: 20_000,
        auditCommand: "local_claude_session create",
      });
      const status: LocalClaudeSessionStatus =
        launch.exitCode === 0 && !launch.timedOut && !launch.errorMessage ? "running" : "failed";
      const updated = await this.repo.updateStatus(session.id, {
        status,
        endedAt: status === "failed" ? new Date().toISOString() : undefined,
      });
      return { session: updated, launch };
    } catch (err) {
      await this.repo.updateStatus(session.id, { status: "failed", endedAt: new Date().toISOString() });
      throw err;
    }
  }

  async list(userId: string): Promise<LocalClaudeSessionRow[]> {
    return this.repo.listForUser(userId);
  }

  async capture(
    userId: string,
    sessionId: string,
    lines = 200,
  ): Promise<{ session: LocalClaudeSessionRow; text: string }> {
    const session = await this.requireSession(userId, sessionId);
    const result = await this.localDeviceInvoker.invoke(userId, {
      deviceId: session.device_id,
      command: captureCommand(session.tmux_session_name, lines),
      timeoutMs: 15_000,
      maxOutputBytes: 200_000,
      auditCommand: "local_claude_session capture",
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr || result.errorMessage || "Failed to capture Claude session.");
    return { session, text: result.stdout };
  }

  async sendText(
    userId: string,
    sessionId: string,
    text: string,
    submit = true,
  ): Promise<{ session: LocalClaudeSessionRow; result: LocalCommandResult }> {
    const session = await this.requireSession(userId, sessionId);
    const result = await this.localDeviceInvoker.invoke(userId, {
      deviceId: session.device_id,
      command: sendTextCommand(session.tmux_session_name, text, submit),
      timeoutMs: 15_000,
      maxOutputBytes: 20_000,
      auditCommand: "local_claude_session send_text",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || result.errorMessage || "Failed to send text.");
    await this.repo.updateStatus(session.id, { status: "running" });
    return { session, result };
  }

  async sendKey(
    userId: string,
    sessionId: string,
    key: string,
  ): Promise<{ session: LocalClaudeSessionRow; result: LocalCommandResult }> {
    const session = await this.requireSession(userId, sessionId);
    const result = await this.localDeviceInvoker.invoke(userId, {
      deviceId: session.device_id,
      command: sendKeyCommand(session.tmux_session_name, key),
      timeoutMs: 15_000,
      maxOutputBytes: 20_000,
      auditCommand: "local_claude_session send_key",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || result.errorMessage || "Failed to send key.");
    return { session, result };
  }

  async interrupt(
    userId: string,
    sessionId: string,
  ): Promise<{ session: LocalClaudeSessionRow; result: LocalCommandResult }> {
    return this.sendKey(userId, sessionId, "C-c");
  }

  async kill(
    userId: string,
    sessionId: string,
  ): Promise<{ session: LocalClaudeSessionRow; result: LocalCommandResult }> {
    const session = await this.requireSession(userId, sessionId);
    const result = await this.localDeviceInvoker.invoke(userId, {
      deviceId: session.device_id,
      command: `tmux kill-session -t ${shellQuote(session.tmux_session_name)}`,
      timeoutMs: 15_000,
      maxOutputBytes: 20_000,
      auditCommand: "local_claude_session kill",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || result.errorMessage || "Failed to kill session.");
    const updated = await this.repo.updateStatus(session.id, { status: "killed", endedAt: new Date().toISOString() });
    return { session: updated, result };
  }

  async reconcile(userId: string, sessionId: string): Promise<LocalClaudeSessionRow> {
    const session = await this.requireSession(userId, sessionId);
    if (["failed", "ended", "killed"].includes(session.status)) return session;
    const result = await this.localDeviceInvoker.invoke(userId, {
      deviceId: session.device_id,
      command: sessionStatusCommand(session.tmux_session_name),
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      auditCommand: "local_claude_session reconcile",
    });
    if (result.exitCode === 0) return session;
    return this.repo.updateStatus(session.id, { status: "ended", endedAt: new Date().toISOString() });
  }

  async recordEvent(input: LocalClaudeSessionEventInput): Promise<LocalClaudeEventDelivery> {
    const session = await this.repo.findByEventTokenHash(tokenHash(input.token));
    if (!session) throw new Error("Local Claude session not found.");
    if (input.expectedSessionId && session.id !== input.expectedSessionId) {
      throw new Error("Local Claude session not found.");
    }
    const status = statusForEvent(input.eventType, input.payload);
    const message = eventMessage(input.eventType, status, input.payload);
    await this.repo.recordEvent({
      sessionId: session.id,
      eventType: input.eventType,
      status,
      message,
      payload: input.payload,
    });
    const updated = await this.repo.findByEventTokenHash(tokenHash(input.token));
    return { session: updated ?? session, status, message };
  }

  private async requireSession(userId: string, sessionId: string): Promise<LocalClaudeSessionRow> {
    const session = await this.repo.findForUser(userId, sessionId);
    if (!session) throw new Error("Local Claude session not found.");
    return session;
  }
}
