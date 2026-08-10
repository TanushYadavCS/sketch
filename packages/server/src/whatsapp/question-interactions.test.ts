import { describe, expect, it } from "vitest";
import {
  parseWhatsAppNumberedQuestionSubmission,
  parseWhatsAppTextQuestionSubmission,
  renderWhatsAppNumberedQuestion,
  renderWhatsAppTextQuestionInteraction,
  whatsappQuestionCode,
  whatsappSubmittedQuestionAnswer,
} from "./question-interactions";

describe("WhatsApp text question interactions", () => {
  const interaction = {
    id: "a1b2c3d4-e5f6-7890",
    publicCode: "a1b2c3d4e5",
    state: "pending" as const,
    target: {
      platform: "whatsapp" as const,
      conversationKind: "dm" as const,
      conversationId: "dm:+14155550100",
      threadId: null,
      requesterPrincipalId: "user-1",
      eligibleResponderPrincipalIds: ["user-1"],
    },
    questions: [
      {
        questionId: "frequency",
        prompt: "How often?",
        options: [
          { id: "daily", label: "Daily", description: "Run every day" },
          { id: "weekly", label: "Weekly" },
        ],
        allowsCustomResponse: true,
      },
    ],
    resumeContext: {
      sessionId: "session-1",
      taskId: null,
      agentRunId: null,
      workspaceId: null,
      requesterPrincipalId: "user-1",
      platform: "whatsapp" as const,
      conversationId: "dm:+14155550100",
      threadId: null,
    },
    expiresAt: "2030-01-01T00:00:00.000Z",
  };

  it("renders the current question as numbered plain text", () => {
    expect(renderWhatsAppTextQuestionInteraction(interaction)).toBe(
      [
        "*How often?*",
        "",
        "*1. Daily*",
        "_Run every day_",
        "",
        "*2. Weekly*",
        "",
        "_Reply with a number from 1 to 2, or type your own answer._",
      ].join("\n"),
    );
    expect(renderWhatsAppTextQuestionInteraction(interaction)).not.toContain(interaction.publicCode);
  });

  it("maps a numbered reply to the model option id and accepts custom text", () => {
    const question = interaction.questions[0];
    expect(parseWhatsAppNumberedQuestionSubmission(" 2 ", question)).toEqual({
      kind: "answer",
      optionId: "weekly",
    });
    expect(parseWhatsAppNumberedQuestionSubmission("Every weekday", question)).toEqual({
      kind: "answer",
      customResponse: "Every weekday",
    });
    expect(parseWhatsAppNumberedQuestionSubmission("3", question)).toEqual({ kind: "invalid_option" });
    expect(renderWhatsAppNumberedQuestion(question)).not.toContain("Cancel");
  });

  it("renders only the first question from a batch and shows progress", () => {
    const batch = {
      ...interaction,
      questions: [
        interaction.questions[0],
        {
          questionId: "action",
          prompt: "What should I do?",
          options: [{ id: "label", label: "Apply labels" }],
          allowsCustomResponse: true,
        },
      ],
    };
    const rendered = renderWhatsAppTextQuestionInteraction(batch);
    expect(rendered).toContain("Question 1 of 2");
    expect(rendered).toContain("How often?");
    expect(rendered).not.toContain("What should I do?");
  });

  it("parses case-insensitive commands and preserves custom-response content", () => {
    expect(parseWhatsAppTextQuestionSubmission(" ANSWER a1b2 frequency weekly ")).toEqual({
      kind: "answer",
      code: "a1b2",
      questionId: "frequency",
      optionId: "weekly",
    });
    expect(parseWhatsAppTextQuestionSubmission("answer a1b2 frequency custom: Keep  Exact Case ")).toEqual({
      kind: "answer",
      code: "a1b2",
      questionId: "frequency",
      customResponse: "Keep  Exact Case",
    });
  });

  it("does not claim ambiguous or malformed text", () => {
    expect(parseWhatsAppTextQuestionSubmission("answer a1b2 frequency weekly now")).toEqual({ kind: "unrecognized" });
    expect(parseWhatsAppTextQuestionSubmission("a1b2 frequency weekly")).toEqual({ kind: "unrecognized" });
  });

  it("parses only the exact cancellation command", () => {
    expect(parseWhatsAppTextQuestionSubmission(" cancel a1b2 ")).toEqual({ kind: "cancel", code: "a1b2" });
    expect(parseWhatsAppTextQuestionSubmission("cancel a1b2 please")).toEqual({ kind: "unrecognized" });
  });

  it("builds a submitted answer with immutable inbound correlation", () => {
    const submission = parseWhatsAppTextQuestionSubmission("answer a1b2 frequency custom: Fridays");
    if (submission.kind !== "answer") throw new Error("expected answer");
    expect(
      whatsappSubmittedQuestionAnswer({
        interactionId: interaction.id,
        submission,
        responderPrincipalId: "user-1",
        inboundEventId: "provider-message-1",
        receivedAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ interactionId: interaction.id, questionId: "frequency", customResponse: "Fridays" });
  });
});
