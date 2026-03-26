/**
 * Tests for SlackBot HTTP mode: constructor validation, processHttpRequest signature
 * verification, url_verification challenge, ssl_check, and regular event dispatch.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestLogger } from "../test-utils";
import { SlackBot } from "./bot";

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
