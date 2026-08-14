/**
 * Isolated tests for SlackBot steal-confirmation delivery: the
 * automation_lock_steal:* block-button action dispatcher, action id parsing,
 * and the holder-facing block-kit message with Approve/Deny buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import { SlackBot, parseSlackLockStealAction } from "./bot";

const mocks = vi.hoisted(() => ({
  actionHandlers: {} as Record<string, (args: Record<string, unknown>) => Promise<void>>,
  postMessage: vi.fn(async () => ({ ts: "111.222" })),
  auth: { user_id: "U_SKETCH", bot_id: "B_SKETCH", team_id: "T_SKETCH" },
}));

vi.mock("@slack/bolt", () => ({
  App: class {
    client = {
      auth: { test: vi.fn(async () => mocks.auth) },
      chat: { postMessage: mocks.postMessage },
    };
    message() {}
    event() {}
    action(pattern: RegExp | string, handler: (args: Record<string, unknown>) => Promise<void>) {
      mocks.actionHandlers[String(pattern)] = handler;
    }
    async start() {}
    async stop() {}
  },
  verifySlackRequest: vi.fn(),
}));

function makeBot() {
  return new SlackBot({ mode: "socket", botToken: "xoxb-test", appToken: "xapp-test", logger: createTestLogger() });
}

function lockStealActionHandler() {
  const handler = mocks.actionHandlers["/^automation_lock_steal:/"];
  if (!handler) throw new Error("automation_lock_steal action handler was not registered");
  return handler;
}

describe("parseSlackLockStealAction", () => {
  it("parses approve and deny action ids with the task id", () => {
    expect(parseSlackLockStealAction("automation_lock_steal:task-1:approve")).toEqual({
      taskId: "task-1",
      action: "approve",
    });
    expect(parseSlackLockStealAction("automation_lock_steal:123e4567-e89b-12d3-a456-426614174000:deny")).toEqual({
      taskId: "123e4567-e89b-12d3-a456-426614174000",
      action: "deny",
    });
  });

  it("rejects malformed action ids", () => {
    expect(parseSlackLockStealAction("automation_lock_steal:task-1")).toBeNull();
    expect(parseSlackLockStealAction("automation_lock_steal:task-1:approve:extra")).toBeNull();
    expect(parseSlackLockStealAction("automation_lock_steal::approve")).toBeNull();
    expect(parseSlackLockStealAction("question_option")).toBeNull();
    expect(parseSlackLockStealAction("")).toBeNull();
  });
});

describe("SlackBot lock steal delivery", () => {
  beforeEach(() => {
    mocks.actionHandlers = {};
    mocks.postMessage.mockClear();
    mocks.auth = { user_id: "U_SKETCH", bot_id: "B_SKETCH", team_id: "T_SKETCH" };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts a block-kit steal request with Approve and Deny buttons", async () => {
    const bot = makeBot();
    await bot.start();

    const ts = await bot.postLockStealRequestMessage("C1", {
      taskId: "task-1",
      requesterName: "Bob",
      taskTitle: "Monthly Report",
    });

    expect(ts).toBe("111.222");
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: 'Bob wants to take over editing "Monthly Report"',
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: '*Bob* wants to take over editing *"Monthly Report"*.' },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              action_id: "automation_lock_steal:task-1:approve",
              value: "task-1",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              style: "danger",
              action_id: "automation_lock_steal:task-1:deny",
              value: "task-1",
            },
          ],
        },
      ],
    });
  });

  it("forwards block-button clicks to the onLockStealAction handler with a dedupe event id", async () => {
    const bot = makeBot();
    const onLockStealAction = vi.fn().mockResolvedValue(undefined);
    bot.onLockStealAction(onLockStealAction);
    await bot.start();

    const ack = vi.fn().mockResolvedValue(undefined);
    await lockStealActionHandler()({
      body: { user: { id: "U_HOLDER" }, container: { channel_id: "C1", message_ts: "100.200" } },
      action: { action_id: "automation_lock_steal:task-1:deny", action_ts: "100.201" },
      ack,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(onLockStealAction).toHaveBeenCalledWith({
      slackUserId: "U_HOLDER",
      channelId: "C1",
      actionId: "automation_lock_steal:task-1:deny",
      eventId: "slack-action:100.201:U_HOLDER:automation_lock_steal:task-1:deny",
    });
  });

  it("acks but drops incomplete block-button payloads", async () => {
    const bot = makeBot();
    const onLockStealAction = vi.fn().mockResolvedValue(undefined);
    bot.onLockStealAction(onLockStealAction);
    await bot.start();

    const ack = vi.fn().mockResolvedValue(undefined);
    await lockStealActionHandler()({ body: {}, action: {}, ack });

    expect(ack).toHaveBeenCalledOnce();
    expect(onLockStealAction).not.toHaveBeenCalled();
  });

  it("logs handler failures without throwing to Bolt", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bot = new SlackBot({
      mode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      logger: logger as never,
    });
    bot.onLockStealAction(vi.fn().mockRejectedValue(new Error("boom")));
    await bot.start();

    await lockStealActionHandler()({
      body: { user: { id: "U_HOLDER" }, container: { channel_id: "C1" } },
      action: { action_id: "automation_lock_steal:task-1:approve", action_ts: "100.201" },
      ack: vi.fn().mockResolvedValue(undefined),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "automation_lock_steal:task-1:approve" }),
      "lock steal action handler failed",
    );
  });
});
