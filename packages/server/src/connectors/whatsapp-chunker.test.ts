import { describe, expect, it } from "vitest";
import {
  type WhatsAppChunkerKnobs,
  type WhatsAppChunkerMessage,
  type WhatsAppLlmChunkerKnobs,
  planWhatsAppConversationSlices,
  resolveWhatsAppChunkerKnobs,
  resolveWhatsAppLlmChunkerKnobs,
} from "./whatsapp-chunker";

const knobs: WhatsAppChunkerKnobs = {
  gapMinutes: 25,
  maxAgeMinutes: 120,
  maxMessages: 50,
};

function message(id: number, minute: number, overrides: Partial<WhatsAppChunkerMessage> = {}): WhatsAppChunkerMessage {
  return {
    id,
    providerMessageId: `m-${id}`,
    effectiveAt: `2026-07-07T09:${String(minute).padStart(2, "0")}:00.000Z`,
    text: `message ${id}`,
    attachments: null,
    isBot: false,
    ...overrides,
  };
}

describe("planWhatsAppConversationSlices", () => {
  it("cuts a single lull and leaves the new active tail uncut", () => {
    const plan = planWhatsAppConversationSlices(
      [message(1, 0), message(2, 5), message(3, 35)],
      knobs,
      new Date("2026-07-07T09:40:00.000Z"),
    );

    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]).toMatchObject({
      firstMessageId: 1,
      lastMessageId: 2,
      messageCount: 2,
      denoisedMessageIds: [1, 2],
      flushReason: "gap",
    });
    expect(plan.activeTailMessageIds).toEqual([3]);
  });

  it("splits bursts at max size into bounded slices", () => {
    const burst = Array.from({ length: 6 }, (_, index) => message(index + 1, index));
    const plan = planWhatsAppConversationSlices(
      burst,
      { ...knobs, maxMessages: 3 },
      new Date("2026-07-07T09:10:00.000Z"),
    );

    expect(plan.slices.map((slice) => slice.flushReason)).toEqual(["max_size", "max_size"]);
    expect(plan.slices.map((slice) => slice.messageCount)).toEqual([3, 3]);
    expect(plan.slices.map((slice) => slice.denoisedMessageIds)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(plan.activeTailMessageIds).toEqual([]);
  });

  it("force flushes continuous activity at max age", () => {
    const plan = planWhatsAppConversationSlices(
      [message(1, 0), message(2, 5), message(3, 10)],
      { ...knobs, maxAgeMinutes: 10 },
      new Date("2026-07-07T09:12:00.000Z"),
    );

    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]).toMatchObject({
      messageCount: 3,
      flushReason: "max_age",
      denoisedMessageIds: [1, 2, 3],
    });
  });

  it("leaves a still-active tail uncut", () => {
    const plan = planWhatsAppConversationSlices(
      [message(1, 0), message(2, 5)],
      knobs,
      new Date("2026-07-07T09:20:00.000Z"),
    );

    expect(plan.slices).toEqual([]);
    expect(plan.activeTailMessageIds).toEqual([1, 2]);
  });

  it("no-ops for an empty conversation", () => {
    const plan = planWhatsAppConversationSlices([], knobs, new Date("2026-07-07T09:20:00.000Z"));

    expect(plan.slices).toEqual([]);
    expect(plan.activeTailMessageIds).toEqual([]);
  });

  it("drops deterministic noise before slicing while preserving a contiguous raw range", () => {
    const plan = planWhatsAppConversationSlices(
      [
        message(1, 0, { text: "real start" }),
        message(2, 1, { isBot: true }),
        message(3, 2, { text: "👍" }),
        message(4, 3, {
          text: "",
          attachments: JSON.stringify([{ originalName: "photo.jpg", mimeType: "image/jpeg" }]),
        }),
        message(5, 4, { text: "/new" }),
        message(6, 5, { text: "real end" }),
      ],
      knobs,
      new Date("2026-07-07T09:40:00.000Z"),
    );

    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]).toMatchObject({
      firstMessageId: 1,
      lastMessageId: 6,
      messageCount: 2,
      denoisedMessageIds: [1, 6],
      flushReason: "gap",
    });
  });
});

describe("resolveWhatsAppChunkerKnobs", () => {
  const group = {
    jid: "group@g.us",
    name: "Group",
    description: null,
    indexEnabled: true,
    sliceGapMinutes: null,
    sliceMaxAgeMinutes: null,
    sliceMaxMessages: null,
  };

  it("resolves group overrides before global defaults before built-in defaults", () => {
    expect(
      resolveWhatsAppChunkerKnobs(
        { ...group, sliceGapMinutes: 7, sliceMaxAgeMinutes: 60, sliceMaxMessages: 12 },
        { gapMinutes: 10, maxAgeMinutes: 90, maxMessages: 25 },
      ),
    ).toEqual({ gapMinutes: 7, maxAgeMinutes: 60, maxMessages: 12 });

    expect(resolveWhatsAppChunkerKnobs(group, { gapMinutes: 10, maxAgeMinutes: 90, maxMessages: 25 })).toEqual({
      gapMinutes: 10,
      maxAgeMinutes: 90,
      maxMessages: 25,
    });

    expect(resolveWhatsAppChunkerKnobs(group)).toEqual({ gapMinutes: 25, maxAgeMinutes: 120, maxMessages: 50 });
  });
});

describe("resolveWhatsAppLlmChunkerKnobs", () => {
  const group = {
    jid: "group@g.us",
    name: "Group",
    description: null,
    indexEnabled: true,
    sliceGapMinutes: null,
    sliceMaxAgeMinutes: null,
    sliceMaxMessages: null,
  };

  it("resolves group overrides before global defaults before built-in defaults", () => {
    const overrides = {
      chunkWindowMessages: 200,
      chunkWindowTokens: 6000,
      chunkMinMessages: 12,
      chunkTargetMessages: 35,
      chunkMaxMessages: 75,
      chunkMaxTokens: 1400,
      chunkTickMinutes: 45,
      chunkIdleCloseHours: 72,
      chunkProvisionalRefreshMessages: 20,
      chunkModel: "gpt-5.6-luna",
      chunkReasoningEffort: "medium" as const,
      chunkBurstThresholdMessages: 50,
      chunkTopicRegistryCap: 25,
      chunkGroupWorkerPool: 3,
    };
    const defaults: Partial<WhatsAppLlmChunkerKnobs> = {
      windowMessages: 210,
      windowTokens: 6500,
      minMessages: 11,
      targetMessages: 36,
      maxMessages: 76,
      maxTokens: 1450,
      tickMinutes: 40,
      idleCloseHours: 80,
      provisionalRefreshMessages: 18,
      model: "fallback-model",
      reasoningEffort: "low",
      burstThresholdMessages: 60,
      topicRegistryCap: 26,
      groupWorkerPool: 2,
    };

    expect(resolveWhatsAppLlmChunkerKnobs({ ...group, ...overrides }, defaults)).toEqual({
      windowMessages: 200,
      windowTokens: 6000,
      minMessages: 12,
      targetMessages: 35,
      maxMessages: 75,
      maxTokens: 1400,
      tickMinutes: 45,
      idleCloseHours: 72,
      provisionalRefreshMessages: 20,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      burstThresholdMessages: 50,
      topicRegistryCap: 25,
      groupWorkerPool: 3,
    });
    expect(resolveWhatsAppLlmChunkerKnobs(group, defaults)).toEqual({
      windowMessages: 210,
      windowTokens: 6500,
      minMessages: 11,
      targetMessages: 36,
      maxMessages: 76,
      maxTokens: 1450,
      tickMinutes: 40,
      idleCloseHours: 80,
      provisionalRefreshMessages: 18,
      model: "fallback-model",
      reasoningEffort: "low",
      burstThresholdMessages: 60,
      topicRegistryCap: 26,
      groupWorkerPool: 2,
    });
    expect(resolveWhatsAppLlmChunkerKnobs(group)).toEqual({
      windowMessages: 250,
      windowTokens: 7500,
      minMessages: 10,
      targetMessages: 40,
      maxMessages: 80,
      maxTokens: 1500,
      tickMinutes: 30,
      idleCloseHours: 96,
      provisionalRefreshMessages: 15,
      model: null,
      reasoningEffort: "high",
      burstThresholdMessages: null,
      topicRegistryCap: 30,
      groupWorkerPool: 4,
    });
  });
});
