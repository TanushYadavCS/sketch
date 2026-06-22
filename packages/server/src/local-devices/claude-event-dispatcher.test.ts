import { describe, expect, it, vi } from "vitest";
import { createLocalClaudeEventDispatcher } from "./claude-event-dispatcher";
import type { LocalClaudeEventDelivery } from "./claude-sessions";

function createDelivery(
  originOrgContextEnabled: number | null,
  sessionOverrides: Partial<LocalClaudeEventDelivery["session"]> = {},
): LocalClaudeEventDelivery {
  return {
    session: {
      id: "session-1",
      user_id: "user-1",
      device_id: "device-1",
      tmux_session_name: "sketch-session1",
      title: "Test",
      cwd: null,
      status: "completed_turn",
      event_token_hash: "hash",
      origin_platform: "whatsapp",
      origin_context_type: "dm",
      origin_delivery_target: "15551234567@s.whatsapp.net",
      origin_thread_ts: null,
      origin_workspace_key: "user-1",
      origin_workspace_dir: "/data/workspaces/user-1",
      origin_active_queue_key: "whatsapp:15551234567",
      origin_conversation_id: 42,
      origin_provider_thread_id: null,
      origin_agent_instructions: "External support agent",
      origin_agent_allowed_tools: JSON.stringify(["LocalClaudeSession"]),
      origin_org_context_enabled: originOrgContextEnabled,
      last_event_type: "Stop",
      last_event_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ended_at: null,
      ...sessionOverrides,
    },
    event: {
      id: "event-1",
      session_id: "session-1",
      event_type: "Stop",
      status: "completed_turn",
      message: "Claude Code completed a turn.",
      payload: JSON.stringify({ last_assistant_message: "Done" }),
      created_at: "2026-01-01T00:00:00.000Z",
    },
    status: "completed_turn",
    message: "Claude Code completed a turn.",
  };
}

describe("createLocalClaudeEventDispatcher", () => {
  it("replays fallback-origin events without org Claude config", async () => {
    const queued: Promise<void>[] = [];
    const runAgent = vi.fn().mockResolvedValue({ trace: { finalText: null }, pendingUploads: [] });
    const dispatcher = createLocalClaudeEventDispatcher({
      db: {} as never,
      config: {
        DATA_DIR: "/data",
        CLAUDE_CONFIG_DIR: "/data/.claude",
        BASE_URL: "https://sketch.test",
        PORT: 3000,
      } as never,
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      settingsRepo: {
        get: vi.fn().mockResolvedValue({ org_name: "Acme", org_context: null, bot_name: "Sketch" }),
      } as never,
      users: {
        findById: vi.fn().mockResolvedValue({
          id: "user-1",
          name: "A User",
          email: "user@example.com",
          whatsapp_number: "15551234567",
          timezone: "Asia/Kolkata",
        }),
      } as never,
      conversations: { insertMessage: vi.fn() } as never,
      queueManager: {
        getQueue: vi.fn().mockReturnValue({
          enqueue: (fn: () => Promise<void>) => {
            queued.push(fn());
          },
        }),
      } as never,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    dispatcher.enqueue(createDelivery(0));
    await queued[0];

    const call = runAgent.mock.calls[0]?.[0];
    expect(call.claudeConfigDir).toBeUndefined();
    expect(call.userMessage).not.toContain("org: /data/.claude");
  });

  it("replays legacy events with org Claude config enabled", async () => {
    const queued: Promise<void>[] = [];
    const runAgent = vi.fn().mockResolvedValue({ trace: { finalText: null }, pendingUploads: [] });
    const dispatcher = createLocalClaudeEventDispatcher({
      db: {} as never,
      config: {
        DATA_DIR: "/data",
        CLAUDE_CONFIG_DIR: "/data/.claude",
        BASE_URL: "https://sketch.test",
        PORT: 3000,
      } as never,
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      settingsRepo: {
        get: vi.fn().mockResolvedValue({ org_name: "Acme", org_context: null, bot_name: "Sketch" }),
      } as never,
      users: {
        findById: vi.fn().mockResolvedValue({
          id: "user-1",
          name: "A User",
          email: "user@example.com",
          whatsapp_number: "15551234567",
          timezone: "Asia/Kolkata",
        }),
      } as never,
      conversations: { insertMessage: vi.fn() } as never,
      queueManager: {
        getQueue: vi.fn().mockReturnValue({
          enqueue: (fn: () => Promise<void>) => {
            queued.push(fn());
          },
        }),
      } as never,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
    });

    dispatcher.enqueue(createDelivery(null));
    await queued[0];

    const call = runAgent.mock.calls[0]?.[0];
    expect(call.claudeConfigDir).toBe("/data/.claude");
    expect(call.userMessage).toContain("org: /data/.claude");
  });

  it("appends integration connection links when replaying WhatsApp results", async () => {
    const queued: Promise<void>[] = [];
    const finalText =
      "GitHub needs connection\n\nTo continue, connect GitHub: https://sketch.test/integrations?connect=github";
    const runAgent = vi.fn().mockResolvedValue({
      trace: { finalText: "GitHub needs connection" },
      pendingUploads: [],
      pendingIntegrationConnections: [
        {
          requestId: "req-1",
          appId: "github",
          appName: "GitHub",
          state: "connect",
          connectUrl: "https://canvas.example.com/connect/secrets?token=github",
        },
      ],
    });
    const conversations = { insertMessage: vi.fn() };
    const whatsapp = {
      isConnected: true,
      sendText: vi.fn().mockResolvedValue({
        key: { id: "sent-1" },
        messageTimestamp: 1767225600,
      }),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const dispatcher = createLocalClaudeEventDispatcher({
      db: {} as never,
      config: {
        DATA_DIR: "/data",
        CLAUDE_CONFIG_DIR: "/data/.claude",
        BASE_URL: "https://sketch.test",
        PORT: 3000,
      } as never,
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      settingsRepo: {
        get: vi.fn().mockResolvedValue({ org_name: "Acme", org_context: null, bot_name: "Sketch" }),
      } as never,
      users: {
        findById: vi.fn().mockResolvedValue({
          id: "user-1",
          name: "A User",
          email: "user@example.com",
          whatsapp_number: "15551234567",
          timezone: "Asia/Kolkata",
        }),
      } as never,
      conversations: conversations as never,
      queueManager: {
        getQueue: vi.fn().mockReturnValue({
          enqueue: (fn: () => Promise<void>) => {
            queued.push(fn());
          },
        }),
      } as never,
      runAgent,
      buildMcpServers: vi.fn().mockResolvedValue({}),
      whatsapp: whatsapp as never,
    });

    dispatcher.enqueue(createDelivery(0));
    await queued[0];

    expect(whatsapp.sendText).toHaveBeenCalledWith("15551234567@s.whatsapp.net", finalText);
    expect(conversations.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ text: finalText }));
  });
});
