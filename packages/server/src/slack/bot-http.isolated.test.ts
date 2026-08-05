/**
 * Tests for SlackBot HTTP mode: constructor validation, processHttpRequest signature
 * verification, url_verification challenge, ssl_check, and regular event dispatch.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../test-utils";
import { SlackBot, parseSlackHttpBody } from "./bot";

const TEST_SIGNING_SECRET = "test-signing-secret-abc123";

function signSlackRequest(signingSecret: string, body: string, timestamp: number): string {
  const baseString = `v0:${timestamp}:${body}`;
  const signature = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return `v0=${signature}`;
}

function makeHeaders(body: string, signingSecret = TEST_SIGNING_SECRET, timestamp?: number) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  return {
    "x-slack-signature": signSlackRequest(signingSecret, body, ts),
    "x-slack-request-timestamp": String(ts),
    "content-type": "application/json",
  };
}

describe("SlackBot constructor validation", () => {
  const logger = createTestLogger();

  it("does not throw for socket mode with appToken", () => {
    expect(
      () =>
        new SlackBot({
          mode: "socket",
          botToken: "xoxb-test",
          appToken: "xapp-test",
          logger,
        }),
    ).not.toThrow();
  });

  it("does not throw for http mode with signingSecret", () => {
    expect(
      () =>
        new SlackBot({
          mode: "http",
          botToken: "xoxb-test",
          signingSecret: "secret123",
          logger,
        }),
    ).not.toThrow();
  });

  it("throws when http mode is used without signingSecret", () => {
    expect(
      () =>
        new SlackBot({
          mode: "http",
          botToken: "xoxb-test",
          logger,
        }),
    ).toThrow();
  });

  it("throws when socket mode is used without appToken", () => {
    expect(
      () =>
        new SlackBot({
          mode: "socket",
          botToken: "xoxb-test",
          logger,
        }),
    ).toThrow();
  });
});

describe("parseSlackHttpBody", () => {
  it("parses application/json bodies as JSON", () => {
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev123" });
    expect(parseSlackHttpBody(body, "application/json")).toEqual({ type: "event_callback", event_id: "Ev123" });
  });

  it("parses application/x-www-form-urlencoded bodies by extracting and JSON-parsing the payload field", () => {
    const interactive = {
      type: "block_actions",
      actions: [{ action_id: "home:set_tool_progress", value: "friendly" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(interactive))}`;
    expect(parseSlackHttpBody(body, "application/x-www-form-urlencoded")).toEqual(interactive);
  });

  it("respects a charset parameter on the form-encoded content-type header", () => {
    const interactive = { type: "block_actions" };
    const body = `payload=${encodeURIComponent(JSON.stringify(interactive))}`;
    expect(parseSlackHttpBody(body, "application/x-www-form-urlencoded; charset=utf-8")).toEqual(interactive);
  });

  it("throws when a form-encoded body is missing the payload field", () => {
    expect(() => parseSlackHttpBody("not_payload=oops", "application/x-www-form-urlencoded")).toThrow(
      /missing 'payload' field/,
    );
  });

  it("falls back to JSON.parse when no content-type header is provided", () => {
    const body = JSON.stringify({ type: "event_callback" });
    expect(parseSlackHttpBody(body, undefined)).toEqual({ type: "event_callback" });
  });
});

describe("SlackBot.processHttpRequest", () => {
  const logger = createTestLogger();

  function makeBot() {
    return new SlackBot({
      mode: "http",
      botToken: "xoxb-test",
      signingSecret: TEST_SIGNING_SECRET,
      logger,
    });
  }

  describe("url_verification", () => {
    it("returns the challenge for url_verification events", async () => {
      const bot = makeBot();
      const body = JSON.stringify({
        type: "url_verification",
        challenge: "test-challenge",
        token: "verification-token",
      });
      const headers = makeHeaders(body);
      const result = await bot.processHttpRequest(body, headers);
      expect(result).toEqual({ challenge: "test-challenge" });
    });
  });

  describe("ssl_check", () => {
    it("returns empty object for ssl_check events", async () => {
      const bot = makeBot();
      const body = JSON.stringify({ type: "ssl_check", token: "verification-token" });
      const headers = makeHeaders(body);
      const result = await bot.processHttpRequest(body, headers);
      expect(result).toEqual({});
    });
  });

  describe("regular events", () => {
    it("does not throw for a valid event_callback payload", async () => {
      const bot = makeBot();
      const body = JSON.stringify({
        type: "event_callback",
        event: { type: "message", channel: "C123", user: "U123", text: "hello", ts: "1234567890.123456" },
      });
      const headers = makeHeaders(body);
      await expect(bot.processHttpRequest(body, headers)).resolves.not.toThrow();
    });

    it("dispatches channel membership events through the HTTP Bolt path", async () => {
      const bot = makeBot();
      const eventHandlers = new Map<string, (args: { event: Record<string, unknown> }) => Promise<void>>();
      const app = {
        client: { auth: { test: async () => ({ user_id: "U-BOT", bot_id: "B-BOT", team_id: "T-BOT" }) } },
        message: () => undefined,
        event: (name: string, handler: (args: { event: Record<string, unknown> }) => Promise<void>) => {
          eventHandlers.set(name, handler);
        },
        action: () => undefined,
        processEvent: async ({ body }: { body: { event?: Record<string, unknown> } }) => {
          const event = body.event;
          const type = event?.type;
          if (event && typeof type === "string") await eventHandlers.get(type)?.({ event });
        },
        stop: async () => undefined,
      };
      (bot as unknown as { app: typeof app }).app = app;
      const joined = vi.fn(async () => undefined);
      const left = vi.fn(async () => undefined);
      bot.onMemberJoinedChannel(joined);
      bot.onMemberLeftChannel(left);
      await bot.start();

      for (const [eventId, eventType] of [
        ["EvJoin", "member_joined_channel"],
        ["EvLeave", "member_left_channel"],
      ]) {
        const body = JSON.stringify({
          type: "event_callback",
          event_id: eventId,
          event: { type: eventType, channel: "C123", user: "U123", team: "T-BOT", team_id: "T-WRONG" },
        });
        await expect(bot.processHttpRequest(body, makeHeaders(body))).resolves.toEqual({});
      }

      await vi.waitFor(() => {
        expect(joined).toHaveBeenCalledWith({ channelId: "C123", slackUserId: "U123", teamId: "T-BOT" });
        expect(left).toHaveBeenCalledWith({ channelId: "C123", slackUserId: "U123", teamId: "T-BOT" });
      });
      await bot.stop();
    });

    it("dispatches a foreign-team member join using the active workspace", async () => {
      const bot = makeBot();
      const eventHandlers = new Map<string, (args: { event: Record<string, unknown> }) => Promise<void>>();
      const app = {
        client: { auth: { test: async () => ({ user_id: "U-BOT", bot_id: "B-BOT", team_id: "T-BOT" }) } },
        message: () => undefined,
        event: (name: string, handler: (args: { event: Record<string, unknown> }) => Promise<void>) => {
          eventHandlers.set(name, handler);
        },
        action: () => undefined,
        processEvent: async ({ body }: { body: { event?: Record<string, unknown> } }) => {
          const event = body.event;
          const type = event?.type;
          if (event && typeof type === "string") await eventHandlers.get(type)?.({ event });
        },
        stop: async () => undefined,
      };
      (bot as unknown as { app: typeof app }).app = app;
      const joined = vi.fn(async () => undefined);
      bot.onMemberJoinedChannel(joined);
      await bot.start();

      await eventHandlers.get("member_joined_channel")?.({
        event: {
          type: "member_joined_channel",
          channel: "C123",
          user: "U-FOREIGN",
          team: "T-USER-HOME",
          team_id: "T-WRONG",
        },
      });

      expect(joined).toHaveBeenCalledWith({
        channelId: "C123",
        slackUserId: "U-FOREIGN",
        teamId: "T-BOT",
      });
      await bot.stop();
    });
  });

  describe("interactive payloads", () => {
    it("accepts a form-encoded block_actions payload from a Home tab dropdown", async () => {
      const bot = makeBot();
      const interactive = {
        type: "block_actions",
        user: { id: "U123" },
        actions: [{ action_id: "home:set_tool_progress", selected_option: { value: "friendly" } }],
      };
      const body = `payload=${encodeURIComponent(JSON.stringify(interactive))}`;
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        "x-slack-signature": signSlackRequest(TEST_SIGNING_SECRET, body, ts),
        "x-slack-request-timestamp": String(ts),
        "content-type": "application/x-www-form-urlencoded",
      };
      await expect(bot.processHttpRequest(body, headers)).resolves.not.toThrow();
    });
  });

  describe("signature verification", () => {
    it("throws when x-slack-signature is invalid", async () => {
      const bot = makeBot();
      const body = JSON.stringify({ type: "url_verification", challenge: "c", token: "t" });
      const timestamp = Math.floor(Date.now() / 1000);
      const headers = {
        "x-slack-signature": "v0=invalidsignature",
        "x-slack-request-timestamp": String(timestamp),
        "content-type": "application/json",
      };
      await expect(bot.processHttpRequest(body, headers)).rejects.toThrow();
    });

    it("throws when x-slack-signature is signed with a different secret", async () => {
      const bot = makeBot();
      const body = JSON.stringify({ type: "url_verification", challenge: "c", token: "t" });
      const headers = makeHeaders(body, "wrong-secret");
      await expect(bot.processHttpRequest(body, headers)).rejects.toThrow();
    });

    it("throws when x-slack-request-timestamp is missing", async () => {
      const bot = makeBot();
      const body = JSON.stringify({ type: "url_verification", challenge: "c", token: "t" });
      const headers = {
        "x-slack-signature": signSlackRequest(TEST_SIGNING_SECRET, body, Math.floor(Date.now() / 1000)),
        "content-type": "application/json",
      };
      await expect(bot.processHttpRequest(body, headers)).rejects.toThrow();
    });

    it("throws when x-slack-signature header is missing", async () => {
      const bot = makeBot();
      const body = JSON.stringify({ type: "url_verification", challenge: "c", token: "t" });
      const timestamp = Math.floor(Date.now() / 1000);
      const headers = {
        "x-slack-request-timestamp": String(timestamp),
        "content-type": "application/json",
      };
      await expect(bot.processHttpRequest(body, headers)).rejects.toThrow();
    });

    it("throws for stale timestamps (>5 minutes old)", async () => {
      const bot = makeBot();
      const body = JSON.stringify({ type: "url_verification", challenge: "c", token: "t" });
      const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
      const headers = makeHeaders(body, TEST_SIGNING_SECRET, sixMinutesAgo);
      await expect(bot.processHttpRequest(body, headers)).rejects.toThrow();
    });
  });
});
