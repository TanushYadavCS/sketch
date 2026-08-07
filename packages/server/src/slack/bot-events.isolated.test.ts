import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";

const mocks = vi.hoisted(() => ({
  messageHandler: undefined as undefined | ((event: { message: Record<string, unknown> }) => Promise<void>),
  mentionHandler: undefined as undefined | ((event: { event: Record<string, unknown> }) => Promise<void>),
  auth: { user_id: "U_SKETCH", bot_id: "B_SKETCH", team_id: "T_SKETCH" },
}));

vi.mock("@slack/bolt", () => ({
  App: class {
    client = { auth: { test: vi.fn(async () => mocks.auth) } };
    message(handler: (event: { message: Record<string, unknown> }) => Promise<void>) {
      mocks.messageHandler = handler;
    }
    event(name: string, handler: (event: { event: Record<string, unknown> }) => Promise<void>) {
      if (name === "app_mention") mocks.mentionHandler = handler;
    }
    action() {}
    async start() {}
    async stop() {}
  },
  verifySlackRequest: vi.fn(),
}));

import { SlackBot } from "./bot";

function makeBot() {
  return new SlackBot({ mode: "socket", botToken: "xoxb-test", appToken: "xapp-test", logger: createTestLogger() });
}

async function deliver(message: Record<string, unknown>) {
  if (!mocks.messageHandler) throw new Error("Message handler was not registered");
  await mocks.messageHandler({ message });
}

describe("SlackBot channel message normalization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mocks.messageHandler = undefined;
    mocks.mentionHandler = undefined;
    mocks.auth = { user_id: "U_SKETCH", bot_id: "B_SKETCH", team_id: "T_SKETCH" };
  });

  it("forwards an external userless bot message to the top-level channel handler", async () => {
    const bot = makeBot();
    const onChannelMessage = vi.fn().mockResolvedValue(undefined);
    bot.onChannelMessage(onChannelMessage);
    await bot.start();

    await deliver({
      type: "message",
      subtype: "bot_message",
      bot_id: "B_WORKFLOW",
      app_id: "A_WORKFLOW",
      channel: "C1",
      text: "Bug report",
      ts: "1.2",
    });

    expect(onChannelMessage).toHaveBeenCalledWith({
      type: "channel_message",
      text: "Bug report",
      botId: "B_WORKFLOW",
      appId: "A_WORKFLOW",
      subtype: "bot_message",
      channelId: "C1",
      teamId: "T_SKETCH",
      ts: "1.2",
    });
  });

  it("suppresses messages from Sketch by user ID or bot ID", async () => {
    const bot = makeBot();
    const onChannelMessage = vi.fn().mockResolvedValue(undefined);
    bot.onChannelMessage(onChannelMessage);
    await bot.start();

    await deliver({ type: "message", user: "U_SKETCH", channel: "C1", text: "self", ts: "1" });
    await deliver({ type: "message", bot_id: "B_SKETCH", channel: "C1", text: "self", ts: "2" });

    expect(onChannelMessage).not.toHaveBeenCalled();
  });

  it("forwards bot metadata on app mentions", async () => {
    const bot = makeBot();
    const onChannelMention = vi.fn().mockResolvedValue(undefined);
    bot.onChannelMention(onChannelMention);
    await bot.start();

    await mocks.mentionHandler?.({
      event: {
        user: "U_WORKFLOW",
        bot_id: "B_WORKFLOW",
        subtype: "bot_message",
        channel: "C1",
        text: "<@U_SKETCH> stop",
        ts: "1.2",
      },
    });

    expect(onChannelMention).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "channel_mention",
        userId: "U_WORKFLOW",
        botId: "B_WORKFLOW",
        subtype: "bot_message",
      }),
    );
  });

  it("does not forward a userless bot thread reply to the passive thread handler", async () => {
    const bot = makeBot();
    const onThreadMessage = vi.fn().mockResolvedValue(undefined);
    bot.onThreadMessage(onThreadMessage);
    await bot.start();

    await deliver({
      type: "message",
      subtype: "bot_message",
      bot_id: "B_WORKFLOW",
      channel: "C1",
      text: "thread bot message",
      ts: "2",
      thread_ts: "1",
    });

    expect(onThreadMessage).not.toHaveBeenCalled();
  });

  it("does not start lifecycle silence monitoring when lifecycle sync is disabled", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bot = new SlackBot({
      mode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      logger: logger as never,
      eventSilenceThresholdMs: 1,
      lifecycleEventsEnabled: false,
    });

    await bot.start();
    vi.advanceTimersByTime(60_000);

    expect(logger.warn).not.toHaveBeenCalled();
    await bot.stop();
  });

  it("emits one structured warning per silent lifecycle event when monitoring is enabled", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bot = new SlackBot({
      mode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      logger: logger as never,
      eventSilenceThresholdMs: 1,
    });

    await bot.start();
    vi.advanceTimersByTime(60_000);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "team_join", thresholdMs: 1 }),
      expect.stringContaining("manifest"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "user_change", thresholdMs: 1 }),
      expect.stringContaining("manifest"),
    );
    await bot.stop();
  });
});
