import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";

const mocks = vi.hoisted(() => ({
  messageHandler: undefined as undefined | ((event: { message: Record<string, unknown> }) => Promise<void>),
  auth: { user_id: "U_SKETCH", bot_id: "B_SKETCH", team_id: "T_SKETCH" },
}));

vi.mock("@slack/bolt", () => ({
  App: class {
    client = { auth: { test: vi.fn(async () => mocks.auth) } };
    message(handler: (event: { message: Record<string, unknown> }) => Promise<void>) {
      mocks.messageHandler = handler;
    }
    event() {}
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
  beforeEach(() => {
    mocks.messageHandler = undefined;
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
});
