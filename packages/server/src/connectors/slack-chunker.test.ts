import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLACK_SLICE_MAX_MESSAGES,
  type SlackChunkerMessage,
  isIndexableSlackChunkMessage,
  planSlackStreamSlices,
} from "./slack-chunker";

const T0 = Date.parse("2026-07-17T08:00:00.000Z");

function msg(overrides: Partial<SlackChunkerMessage> & { id: number }): SlackChunkerMessage {
  return {
    effectiveAt: new Date(T0 + overrides.id * 1000).toISOString(),
    text: `message ${overrides.id}`,
    attachments: null,
    isBot: false,
    addressedToSketch: false,
    ...overrides,
  };
}

function atMinutes(id: number, minutes: number, overrides: Partial<SlackChunkerMessage> = {}): SlackChunkerMessage {
  return msg({ id, effectiveAt: new Date(T0 + minutes * 60_000).toISOString(), ...overrides });
}

describe("isIndexableSlackChunkMessage", () => {
  it("drops bot rows, Sketch chatter, placeholders, join/leave, and emoji-only", () => {
    expect(isIndexableSlackChunkMessage(msg({ id: 1, isBot: true }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 2, addressedToSketch: true }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 3, text: "   " }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 4, text: "See attached files." }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 5, text: "<@U0123ABC> has joined the channel" }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 6, text: "<@U0123ABC> has left the channel." }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 7, text: "👍" }))).toBe(false);
    expect(isIndexableSlackChunkMessage(msg({ id: 8, text: ":thumbsup: 🎉" }))).toBe(false);
  });

  it("keeps ordinary user messages, including ones that mention joining", () => {
    expect(isIndexableSlackChunkMessage(msg({ id: 1, text: "ship it 🚀" }))).toBe(true);
    expect(isIndexableSlackChunkMessage(msg({ id: 2, text: "Priya has joined the channel team today" }))).toBe(true);
  });
});

describe("planSlackStreamSlices", () => {
  const channelKnobs = { gapMinutes: 25, maxAgeMinutes: 120, maxMessages: 50 };
  const threadKnobs = { gapMinutes: 480, maxAgeMinutes: null, maxMessages: 50 };

  it("keeps an active tail open until the gap passes", () => {
    const now = new Date(T0 + 10 * 60_000);
    const plan = planSlackStreamSlices([atMinutes(1, 0), atMinutes(2, 5)], channelKnobs, now);
    expect(plan.slices).toHaveLength(0);
    expect(plan.activeTailMessageIds).toEqual([1, 2]);
  });

  it("flushes on the gap and starts the next slice", () => {
    const now = new Date(T0 + 200 * 60_000);
    const plan = planSlackStreamSlices([atMinutes(1, 0), atMinutes(2, 5), atMinutes(3, 60)], channelKnobs, now);
    expect(plan.slices.map((slice) => slice.flushReason)).toEqual(["gap", "gap"]);
    expect(plan.slices[0]?.denoisedMessageIds).toEqual([1, 2]);
    expect(plan.slices[1]?.denoisedMessageIds).toEqual([3]);
  });

  it("splits an over-long thread at the message cap and continues into slice 2", () => {
    const messages = Array.from({ length: DEFAULT_SLACK_SLICE_MAX_MESSAGES + 5 }, (_, index) =>
      atMinutes(index + 1, index),
    );
    const now = new Date(T0 + (DEFAULT_SLACK_SLICE_MAX_MESSAGES + 5 + 480) * 60_000);
    const plan = planSlackStreamSlices(messages, threadKnobs, now);
    expect(plan.slices).toHaveLength(2);
    expect(plan.slices[0]?.flushReason).toBe("max_size");
    expect(plan.slices[0]?.messageCount).toBe(DEFAULT_SLACK_SLICE_MAX_MESSAGES);
    expect(plan.slices[1]?.messageCount).toBe(5);
  });

  it("thread streams have no age flush — a slow thread stays open until idle", () => {
    const messages = [atMinutes(1, 0), atMinutes(2, 200), atMinutes(3, 400)];
    const stillActive = planSlackStreamSlices(messages, threadKnobs, new Date(T0 + 500 * 60_000));
    expect(stillActive.slices).toHaveLength(0);
    expect(stillActive.activeTailMessageIds).toEqual([1, 2, 3]);

    const afterIdle = planSlackStreamSlices(messages, threadKnobs, new Date(T0 + (400 + 481) * 60_000));
    expect(afterIdle.slices).toHaveLength(1);
    expect(afterIdle.slices[0]?.flushReason).toBe("gap");
  });

  it("channel streams flush on max age even while continuously active", () => {
    const messages = Array.from({ length: 13 }, (_, index) => atMinutes(index + 1, index * 10));
    const plan = planSlackStreamSlices(messages, channelKnobs, new Date(T0 + 130 * 60_000));
    expect(plan.slices[0]?.flushReason).toBe("max_age");
  });

  it("noise inside the window lands in the raw range but not the membership", () => {
    const now = new Date(T0 + 200 * 60_000);
    const messages = [atMinutes(1, 0), atMinutes(2, 1, { isBot: true }), atMinutes(3, 2), atMinutes(4, 90)];
    const plan = planSlackStreamSlices(messages, channelKnobs, now);
    expect(plan.slices[0]?.denoisedMessageIds).toEqual([1, 3]);
    expect(plan.slices[0]?.firstMessageId).toBe(1);
    expect(plan.slices[0]?.lastMessageId).toBe(3);
  });
});
