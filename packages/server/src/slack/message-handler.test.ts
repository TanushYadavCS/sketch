import { describe, expect, it, vi } from "vitest";
import { createSlackMessageHandler } from "./message-handler";

function createMockSlackBot() {
  return {
    postMessage: vi.fn().mockResolvedValue("new-ts"),
    postThreadReply: vi.fn().mockResolvedValue("reply-ts"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createSlackMessageHandler", () => {
  describe("DM mode (no threadTs)", () => {
    it("posts a new DM message", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123");

      await handler("Hello!");

      expect(bot.postMessage).toHaveBeenCalledWith("C123", "Hello!");
      expect(bot.postThreadReply).not.toHaveBeenCalled();
    });

    it("multiple calls each post a new DM message", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123");

      await handler("First");
      await handler("Second");

      expect(bot.postMessage).toHaveBeenCalledTimes(2);
      expect(bot.postMessage).toHaveBeenCalledWith("C123", "First");
      expect(bot.postMessage).toHaveBeenCalledWith("C123", "Second");
    });
  });

  describe("channel mode (with threadTs)", () => {
    it("posts a thread reply", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123", "thread-ts");

      await handler("Hello!");

      expect(bot.postThreadReply).toHaveBeenCalledWith("C123", "thread-ts", "Hello!");
      expect(bot.postMessage).not.toHaveBeenCalled();
    });

    it("multiple calls each post thread replies", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123", "thread-ts");

      await handler("First");
      await handler("Second");

      expect(bot.postThreadReply).toHaveBeenCalledTimes(2);
      expect(bot.postThreadReply).toHaveBeenCalledWith("C123", "thread-ts", "First");
      expect(bot.postThreadReply).toHaveBeenCalledWith("C123", "thread-ts", "Second");
    });
  });

  describe("chunking", () => {
    it("short message is sent as a single call", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123", "thread-ts");

      await handler("short message");

      expect(bot.postThreadReply).toHaveBeenCalledTimes(1);
    });

    it("oversized message: each chunk posted as separate thread reply", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123", "thread-ts");

      const part1 = "a".repeat(35_000);
      const part2 = "b".repeat(10_000);
      const longText = `${part1}\n${part2}`;

      await handler(longText);

      expect(bot.postThreadReply).toHaveBeenCalledTimes(2);
      expect(bot.postThreadReply.mock.calls[0][2]).toBe(part1);
      expect(bot.postThreadReply.mock.calls[1][2]).toBe(part2);
    });

    it("oversized DM message: each chunk posted as separate DM", async () => {
      const bot = createMockSlackBot();
      const handler = createSlackMessageHandler(bot as never, "C123");

      const part1 = "a".repeat(35_000);
      const part2 = "b".repeat(10_000);
      const longText = `${part1}\n${part2}`;

      await handler(longText);

      expect(bot.postMessage).toHaveBeenCalledTimes(2);
      expect(bot.postMessage.mock.calls[0][1]).toBe(part1);
      expect(bot.postMessage.mock.calls[1][1]).toBe(part2);
    });
  });
});
