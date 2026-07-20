import { describe, expect, it } from "vitest";
import { SYSTEM_MESSAGE_SUBTYPES, SlackBot, clipForSlackLoading } from "./bot";

describe("SYSTEM_MESSAGE_SUBTYPES", () => {
  it("blocks channel-membership system messages that carry a user field", () => {
    for (const subtype of [
      "channel_join",
      "channel_leave",
      "channel_topic",
      "channel_purpose",
      "channel_name",
      "channel_archive",
      "channel_unarchive",
      "channel_posting_permissions",
    ]) {
      expect(SYSTEM_MESSAGE_SUBTYPES.has(subtype)).toBe(true);
    }
  });

  it("lets user-content subtypes through", () => {
    expect(SYSTEM_MESSAGE_SUBTYPES.has("file_share")).toBe(false);
    expect(SYSTEM_MESSAGE_SUBTYPES.has("thread_broadcast")).toBe(false);
  });
});

describe("clipForSlackLoading", () => {
  it("returns text unchanged when within the 50-code-point limit", () => {
    const input = '📖 Read: "a.ts"';
    expect(clipForSlackLoading(input)).toBe(input);
  });

  it("returns text unchanged at exactly 50 code points", () => {
    const input = "a".repeat(50);
    expect(clipForSlackLoading(input)).toBe(input);
  });

  it("clips to 50 code points with a trailing ellipsis when over the limit", () => {
    const input = `📖 Read: "${"x".repeat(60)}"`;
    const result = clipForSlackLoading(input);
    expect(Array.from(result)).toHaveLength(50);
    expect(result.endsWith("…")).toBe(true);
  });

  it("counts emojis as single code points so the clip is grapheme-safe", () => {
    const input = `${"📖".repeat(60)}`;
    const result = clipForSlackLoading(input);
    expect(Array.from(result)).toHaveLength(50);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("SlackBot.stripBotMention", () => {
  const botId = "U123BOT";

  it("strips mention at start of message", () => {
    expect(SlackBot.stripBotMention("<@U123BOT> hello", botId)).toBe("hello");
  });

  it("strips mention in middle of message", () => {
    expect(SlackBot.stripBotMention("hey <@U123BOT> hello", botId)).toBe("hey hello");
  });

  it("returns original text when no mention present", () => {
    expect(SlackBot.stripBotMention("hello", botId)).toBe("hello");
  });

  it("returns empty string when message is only a mention", () => {
    expect(SlackBot.stripBotMention("<@U123BOT>", botId)).toBe("");
  });

  it("strips multiple mentions", () => {
    expect(SlackBot.stripBotMention("<@U123BOT> do <@U123BOT> this", botId)).toBe("do this");
  });

  it("does not strip mentions of other users", () => {
    expect(SlackBot.stripBotMention("<@U999OTHER> hello", botId)).toBe("<@U999OTHER> hello");
  });
});
