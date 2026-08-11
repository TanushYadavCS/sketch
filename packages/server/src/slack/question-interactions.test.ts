import { describe, expect, it, vi } from "vitest";
import {
  createSlackQuestionTransport,
  decodeSlackQuestionActionValue,
  encodeSlackQuestionActionValue,
  renderSlackNumberedQuestion,
} from "./question-interactions";

const interaction = {
  id: "interaction-1",
  publicCode: "ABC123",
  state: "pending" as const,
  target: {
    platform: "slack" as const,
    conversationKind: "dm" as const,
    conversationId: "D1",
    threadId: null,
    requesterPrincipalId: "user-1",
    eligibleResponderPrincipalIds: ["user-1"],
  },
  questions: [
    {
      questionId: "frequency",
      prompt: "How often?",
      options: [
        { id: "daily", label: "Daily", description: "Run once every day" },
        { id: "weekly", label: "Weekly" },
      ],
      allowsCustomResponse: true,
    },
  ],
  resumeContext: {
    sessionId: "session-1",
    taskId: null,
    agentRunId: null,
    workspaceId: "user-1",
    requesterPrincipalId: "user-1",
    platform: "slack" as const,
    conversationId: "D1",
    threadId: null,
  },
  expiresAt: "2026-01-01T00:00:00.000Z",
};

describe("Slack question interactions", () => {
  it("round-trips opaque action correlation values", () => {
    const value = encodeSlackQuestionActionValue({
      interactionId: "interaction-1",
      questionId: "frequency",
      optionId: "daily",
      version: 1,
    });
    expect(decodeSlackQuestionActionValue(value)).toEqual({
      interactionId: "interaction-1",
      questionId: "frequency",
      optionId: "daily",
      version: 1,
    });
  });

  it("renders a plain numbered question with descriptions and custom-answer guidance", () => {
    const question = interaction.questions[0];
    if (!question) throw new Error("Expected a question fixture");

    expect(renderSlackNumberedQuestion(question)).toBe(
      "*How often?*\n\n*1. Daily*\n_Run once every day_\n\n*2. Weekly*\n\n_Reply with a number from 1 to 2, or type your own answer._",
    );
  });

  it("delivers only the first question as text even when interactive capabilities are advertised", async () => {
    const batch = {
      ...interaction,
      questions: Array.from({ length: 4 }, (_, questionIndex) => ({
        questionId: `question-${questionIndex + 1}`,
        prompt: `Question prompt ${questionIndex + 1}`,
        options: Array.from({ length: 4 }, (_, optionIndex) => ({
          id: `option-${questionIndex + 1}-${optionIndex + 1}`,
          label: `Option ${optionIndex + 1}`,
          description: `Description ${optionIndex + 1}`,
        })),
        allowsCustomResponse: true,
      })),
    };
    const post = vi.fn().mockResolvedValue("message-1");
    await createSlackQuestionTransport({ post }).deliver(
      { interaction: batch, deliveryId: "delivery-1", requestKey: "request-1" },
      {
        available: true,
        interactiveSingleSelect: true,
        interactiveBatch: true,
        nativeCustomResponse: false,
        textFallback: false,
        cancelControl: false,
      },
    );
    expect(post).toHaveBeenCalledWith({
      channelId: "D1",
      threadTs: null,
      text: expect.stringContaining("Question prompt 1"),
    });
    const delivered = post.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(delivered).not.toHaveProperty("blocks");
    expect(delivered.text).toContain("*1. Option 1*\n_Description 1_");
    expect(delivered.text).not.toContain("Question prompt 2");
    expect(delivered.text).not.toMatch(/Reply:|#\w+|custom:|cancel/i);
  });
});
