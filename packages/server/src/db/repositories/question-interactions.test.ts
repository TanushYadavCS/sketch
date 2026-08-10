import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createQuestionInteractionsRepository } from "./question-interactions";

let db: Kysely<DB>;
let repository: ReturnType<typeof createQuestionInteractionsRepository>;

beforeEach(async () => {
  db = await createTestDb();
  repository = createQuestionInteractionsRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("question interaction public codes", () => {
  it("generates an opaque public code and scopes lookup to its target", async () => {
    const interaction = await repository.createPendingQuestionInteraction({
      sessionId: "session-1",
      target: {
        platform: "whatsapp",
        conversationKind: "dm",
        conversationId: "conversation-1",
        threadId: null,
        requesterPrincipalId: "principal-1",
        eligibleResponderPrincipalIds: ["principal-1"],
      },
      questions: [
        {
          questionId: "question-1",
          prompt: "Choose",
          options: [{ id: "one", label: "One" }],
          allowsCustomResponse: false,
        },
      ],
      resumeContext: {},
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    expect(interaction?.public_code).toMatch(/^[A-F0-9]{10}$/);
    await expect(
      repository.findActiveQuestionInteractionByPublicCode({
        platform: "whatsapp",
        conversationId: "conversation-1",
        threadId: null,
        publicCode: interaction?.public_code ?? "",
      }),
    ).resolves.toMatchObject({ id: interaction?.id });
    await expect(
      repository.findActiveQuestionInteractionByPublicCode({
        platform: "whatsapp",
        conversationId: "different-conversation",
        threadId: null,
        publicCode: interaction?.public_code ?? "",
      }),
    ).resolves.toBeUndefined();
    await expect(repository.getQuestionInteractionSnapshot(interaction?.id ?? "")).resolves.toMatchObject({
      interactionId: interaction?.id,
      publicCode: interaction?.public_code,
      target: { platform: "whatsapp", conversationId: "conversation-1", threadId: null },
      questions: [{ questionId: "question-1", options: [{ id: "one", label: "One" }], allowsCustomResponse: false }],
      deliveries: [],
    });
  });

  it("rejects a second pending interaction in the same requester conversation scope", async () => {
    const input = {
      sessionId: "session-1",
      target: {
        platform: "slack" as const,
        conversationKind: "channel" as const,
        conversationId: "conversation-1",
        threadId: "thread-1",
        requesterPrincipalId: "principal-1",
        eligibleResponderPrincipalIds: ["principal-1"],
      },
      questions: [
        {
          questionId: "question-1",
          prompt: "Choose",
          options: [{ id: "one", label: "One" }],
          allowsCustomResponse: false,
        },
      ],
      resumeContext: {},
      expiresAt: "2030-01-01T00:00:00.000Z",
    };

    await repository.createPendingQuestionInteraction(input);

    await expect(repository.createPendingQuestionInteraction(input)).rejects.toThrow("conversation scope");
  });

  it("claims a completed interaction resume once and releases a failed claim for retry", async () => {
    const interaction = await repository.createPendingQuestionInteraction({
      sessionId: "session-2",
      target: {
        platform: "web",
        conversationKind: "dm",
        conversationId: "conversation-2",
        threadId: null,
        requesterPrincipalId: "principal-2",
        eligibleResponderPrincipalIds: ["principal-2"],
      },
      questions: [
        {
          questionId: "question-2",
          prompt: "Choose",
          options: [{ id: "two", label: "Two" }],
          allowsCustomResponse: false,
        },
      ],
      resumeContext: {},
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const interactionId = interaction?.id ?? "";

    await repository.submitQuestionInteractionAnswer({
      interactionId,
      questionId: "question-2",
      optionId: "two",
      responderPrincipalId: "principal-2",
      inboundEventId: "event-2",
      receivedAt: "2026-08-10T00:00:00.000Z",
    });

    await expect(repository.claimQuestionInteractionResume(interactionId)).resolves.toMatchObject({ kind: "claimed" });
    await expect(repository.claimQuestionInteractionResume(interactionId)).resolves.toEqual({
      kind: "already_claimed",
    });
    await expect(repository.recordQuestionInteractionResumeResult({ interactionId, status: "failed" })).resolves.toBe(
      true,
    );
    await expect(repository.claimQuestionInteractionResume(interactionId)).resolves.toMatchObject({ kind: "claimed" });
    await expect(repository.recordQuestionInteractionResumeResult({ interactionId, status: "failed" })).resolves.toBe(
      true,
    );
    await expect(repository.claimQuestionInteractionResume(interactionId)).resolves.toMatchObject({ kind: "claimed" });
  });

  it("cancels only pending interactions owned by the target requester", async () => {
    const interaction = await repository.createPendingQuestionInteraction({
      sessionId: "session-3",
      target: {
        platform: "slack",
        conversationKind: "dm",
        conversationId: "conversation-3",
        threadId: null,
        requesterPrincipalId: "principal-3",
        eligibleResponderPrincipalIds: ["principal-3"],
      },
      questions: [
        {
          questionId: "question-3",
          prompt: "Choose",
          options: [{ id: "three", label: "Three" }],
          allowsCustomResponse: false,
        },
      ],
      resumeContext: {},
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    await expect(
      repository.cancelPendingQuestionInteractionsForTarget({
        platform: "slack",
        conversationId: "conversation-3",
        threadId: null,
        requesterPrincipalId: "principal-3",
      }),
    ).resolves.toEqual({ cancelledIds: [interaction?.id], count: 1 });
  });
});
