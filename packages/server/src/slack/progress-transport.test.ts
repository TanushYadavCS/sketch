import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackProgressTransport } from "./progress-transport";

function createMockSlackBot() {
  return {
    postMessage: vi.fn().mockResolvedValueOnce("ts-1").mockResolvedValueOnce("ts-2"),
    postThreadReply: vi.fn().mockResolvedValueOnce("thread-1").mockResolvedValueOnce("thread-2"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createSlackProgressTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accumulates progress into a single edited message", async () => {
    const bot = createMockSlackBot();
    const transport = createSlackProgressTransport(bot as never, "C123", "accumulate");

    await transport.pushLines(["📖 Read"]);
    await transport.pushLines(["🔧 Edit"]);
    await vi.advanceTimersByTimeAsync(1_500);
    await transport.flush();

    expect(bot.postMessage).toHaveBeenCalledWith("C123", "📖 Read");
    expect(bot.updateMessage).toHaveBeenCalledWith("C123", "ts-1", "📖 Read\n🔧 Edit");
  });

  it("starts a new progress message when the current segment would overflow", async () => {
    const bot = createMockSlackBot();
    const transport = createSlackProgressTransport(bot as never, "C123", "accumulate");

    await transport.pushLines(["a".repeat(38_995)]);
    await transport.pushLines(["second line"]);
    await transport.flush();

    expect(bot.postMessage).toHaveBeenNthCalledWith(1, "C123", "a".repeat(38_995));
    expect(bot.postMessage).toHaveBeenNthCalledWith(2, "C123", "second line");
    expect(bot.updateMessage).not.toHaveBeenCalled();
  });

  it("replaces the same message in concise mode", async () => {
    const bot = createMockSlackBot();
    const transport = createSlackProgressTransport(bot as never, "C123", "replace");

    await transport.pushLines(["📖 Checking"]);
    await transport.pushLines(["🔧 Updating"]);
    await vi.advanceTimersByTimeAsync(1_500);
    await transport.flush();

    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith("C123", "ts-1", "🔧 Updating");
  });
});
