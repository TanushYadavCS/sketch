import { describe, expect, it, vi } from "vitest";
import type { LocalClaudeSessionRow } from "../db/repositories/local-claude-sessions";
import { LocalClaudeSessionService } from "./claude-sessions";

const baseSession: LocalClaudeSessionRow = {
  id: "session-1",
  user_id: "user-1",
  device_id: "device-1",
  tmux_session_name: "sketch-session1",
  title: "Test",
  cwd: null,
  status: "running",
  event_token_hash: "hash",
  origin_platform: "slack",
  origin_context_type: "channel",
  origin_delivery_target: "C123",
  origin_thread_ts: "111.222",
  origin_workspace_key: "channel-C123",
  origin_workspace_dir: "/data/workspaces/channel-C123",
  origin_active_queue_key: "C123:111.222",
  origin_conversation_id: 42,
  origin_provider_thread_id: "111.222",
  origin_agent_instructions: null,
  origin_agent_allowed_tools: null,
  origin_org_context_enabled: 1,
  last_event_type: null,
  last_event_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ended_at: null,
};

function createRepo() {
  let session = { ...baseSession };
  return {
    create: vi.fn(async (input) => {
      session = {
        ...session,
        id: input.id,
        user_id: input.userId,
        device_id: input.deviceId,
        tmux_session_name: input.tmuxSessionName,
        title: input.title,
        cwd: input.cwd ?? null,
        event_token_hash: input.eventTokenHash,
        origin_platform: input.origin?.platform ?? null,
        origin_context_type: input.origin?.contextType ?? null,
        origin_delivery_target: input.origin?.deliveryTarget ?? null,
        origin_thread_ts: input.origin?.threadTs ?? null,
        origin_workspace_key: input.origin?.workspaceKey ?? null,
        origin_workspace_dir: input.origin?.workspaceDir ?? null,
        origin_active_queue_key: input.origin?.activeQueueKey ?? null,
        origin_conversation_id: input.origin?.conversationId ?? null,
        origin_provider_thread_id: input.origin?.providerThreadId ?? null,
        origin_agent_instructions: input.origin?.agentInstructions ?? null,
        origin_agent_allowed_tools: null,
        origin_org_context_enabled: 1,
      };
      if (input.origin?.agentAllowedTools) {
        session.origin_agent_allowed_tools = JSON.stringify(input.origin.agentAllowedTools);
      }
      if (input.origin?.orgContextEnabled === false) {
        session.origin_org_context_enabled = 0;
      }
      return session;
    }),
    findForUser: vi.fn(async () => session),
    findByEventTokenHash: vi.fn(async () => session),
    listForUser: vi.fn(async () => [session]),
    updateStatus: vi.fn(async (_id, input) => {
      session = {
        ...session,
        status: input.status,
        last_event_type: input.lastEventType ?? session.last_event_type,
        ended_at: input.endedAt === undefined ? session.ended_at : input.endedAt,
      };
      return session;
    }),
    recordEvent: vi.fn(async (input) => {
      session = {
        ...session,
        status: input.status,
        last_event_type: input.eventType,
      };
      return {
        id: "event-1",
        session_id: input.sessionId,
        event_type: input.eventType,
        status: input.status,
        message: input.message ?? null,
        payload: JSON.stringify(input.payload),
        created_at: "2026-01-01T00:00:00.000Z",
      };
    }),
  };
}

describe("LocalClaudeSessionService", () => {
  it("preflights dependencies and launches Claude Code in tmux with redacted audits", async () => {
    const repo = createRepo();
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        deviceId: "device-1",
        exitCode: 0,
        timedOut: false,
        errorMessage: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      })
      .mockResolvedValueOnce({
        deviceId: "device-1",
        exitCode: 0,
        timedOut: false,
        errorMessage: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    const service = new LocalClaudeSessionService(
      repo as never,
      { invoke },
      { baseUrl: "https://sketch.test", port: 3000 },
    );

    const result = await service.create({
      userId: "user-1",
      prompt: "Fix the tests",
      cwd: "/Users/alice/repo",
      origin: { platform: "slack", contextType: "channel", deliveryTarget: "C123", threadTs: "111.222" },
    });

    expect(result.session.status).toBe("running");
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "user-1",
      expect.objectContaining({ auditCommand: "local_claude_session preflight" }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "user-1",
      expect.objectContaining({
        deviceId: "device-1",
        auditCommand: "local_claude_session create",
      }),
    );
    const launchCommand = invoke.mock.calls[1]?.[1].command as string;
    expect(launchCommand).toContain("tmux new-session -d -s");
    expect(launchCommand).toContain("claude --permission-mode bypassPermissions");
    expect(launchCommand).toContain('--settings "$HOME/.sketch/local-claude/');
    expect(launchCommand).not.toContain("CLAUDE_CONFIG_DIR=");
    expect(launchCommand).toContain("https://sketch.test/api/local-claude-sessions/");
    expect(launchCommand).toContain("Fix the tests");
  });

  it("maps permission notifications to needs_permission", async () => {
    const repo = createRepo();
    const service = new LocalClaudeSessionService(repo as never, { invoke: vi.fn() }, { port: 3000 });

    const result = await service.recordEvent({
      token: "token",
      eventType: "Notification",
      payload: { notification_type: "permission_prompt", message: "Allow Bash?" },
    });

    expect(result.status).toBe("needs_permission");
    expect(result.message).toContain("Allow Bash?");
    expect(repo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "needs_permission",
        eventType: "Notification",
      }),
    );
    expect(result.event.id).toBe("event-1");
  });
});
