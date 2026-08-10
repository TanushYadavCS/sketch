import type { WebChatQuestion } from "@sketch/shared";
import { describe, expect, it, vi } from "vitest";
import { createQuestionInteractionService } from "./service";
import type {
  PendingQuestionInteraction,
  QuestionInteractionRepository,
  QuestionInteractionTarget,
} from "./types";

const target: QuestionInteractionTarget = {
  platform: "slack",
  conversationKind: "dm",
  conversationId: "D1",
  threadId: null,
  requesterPrincipalId: "user-1",
  eligibleResponderPrincipalIds: ["user-1"],
};

const question: WebChatQuestion = {
  id: "delivery-mode",
  prompt: "Where should this go?",
  options: [
    { id: "slack", label: "Slack" },
    { id: "email", label: "Email" },
  ],
};

function pending(): PendingQuestionInteraction {
  return {
    id: "interaction-1",
    publicCode: "A1B2C3D4E5",
    state: "pending",
    target,
    questions: [{ questionId: question.id, prompt: question.prompt, options: question.options, allowsCustomResponse: true }],
    resumeContext: {
      sessionId: "session-1",
      taskId: null,
      agentRunId: null,
      workspaceId: "workspace-1",
      requesterPrincipalId: "user-1",
      platform: "slack",
      conversationId: "D1",
      threadId: null,
    },
    expiresAt: "2026-08-11T00:00:00.000Z",
  };
}

function repository(overrides: Partial<QuestionInteractionRepository> = {}): QuestionInteractionRepository {
  return {
    createPendingQuestionInteraction: vi.fn(async () => pending()),
    claimQuestionInteractionDelivery: vi.fn(async () => ({ kind: "not_pending" as const })),
    recordQuestionInteractionDeliveryResult: vi.fn(),
    markQuestionInteractionDeliveryFailed: vi.fn(async () => undefined),
    submitQuestionInteractionAnswer: vi.fn(async () => ({ kind: "duplicate" as const, interactionId: "interaction-1" })),
    submitQuestionInteractionBatchAnswer: vi.fn(async () => ({ kind: "duplicate" as const, interactionId: "interaction-1" })),
    claimQuestionInteractionResume: vi.fn(async () => ({ kind: "not_ready" as const })),
    recordQuestionInteractionResumeResult: vi.fn(async () => undefined),
    cancelQuestionInteraction: vi.fn(),
    expireQuestionInteraction: vi.fn(),
    getPendingQuestionInteraction: vi.fn(async () => null),
    findPendingQuestionInteractionByPublicCode: vi.fn(async () => null),
    ...overrides,
  };
}

describe("createQuestionInteractionService", () => {
  it("persists a drained collector effect with an immutable resume snapshot", async () => {
    const repo = repository();
    const collector = { drain: vi.fn(() => question) };
    const service = createQuestionInteractionService({ repository: repo });
    const created = await service.createFromCollector({
      collector,
      target,
      resumeContext: pending().resumeContext,
      expiresAt: "2026-08-11T00:00:00.000Z",
    });

    expect(created?.id).toBe("interaction-1");
    expect(repo.createPendingQuestionInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ questionId: "delivery-mode", allowsCustomResponse: true })],
      }),
    );
  });

  it("persists an already-drained runner interaction at the adapter seam", async () => {
    const repo = repository();
    const service = createQuestionInteractionService({ repository: repo });

    await service.createFromInteraction({
      interaction: question,
      target,
      resumeContext: pending().resumeContext,
      expiresAt: "2026-08-11T00:00:00.000Z",
    });

    expect(repo.createPendingQuestionInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ questions: [expect.objectContaining({ questionId: "delivery-mode" })] }),
    );
  });

  it("delegates exact-one answer validation to the shared question schema", async () => {
    const repo = repository();
    const service = createQuestionInteractionService({ repository: repo });

    const outcome = await service.submitAnswer({
      interactionId: "interaction-1",
      questionId: "delivery-mode",
      customResponse: "  A dedicated webhook  ",
      responderPrincipalId: "user-1",
      inboundEventId: "event-1",
      receivedAt: "2026-08-10T00:00:00.000Z",
    });

    expect(outcome.kind).toBe("duplicate");
    expect(repo.submitQuestionInteractionAnswer).toHaveBeenCalledOnce();
  });

  it("creates deterministic ordered continuation text without parsing transport data", async () => {
    const repo = repository({
      submitQuestionInteractionAnswer: vi.fn(async () => ({
        kind: "completed" as const,
        interactionId: "interaction-1",
        resumeWork: {
          interactionId: "interaction-1",
          context: pending().resumeContext,
          answers: [
            { questionId: "source", customResponse: "Webhook" },
            { questionId: "schedule", optionId: "daily" },
          ],
          continuationText: "",
        },
      })),
    });
    const service = createQuestionInteractionService({ repository: repo });

    const outcome = await service.submitAnswer({
      interactionId: "interaction-1",
      questionId: "source",
      optionId: "webhook",
      responderPrincipalId: "user-1",
      inboundEventId: "event-2",
      receivedAt: "2026-08-10T00:00:00.000Z",
    });

    expect(outcome).toMatchObject({
      kind: "completed",
      resumeWork: {
        continuationText: "Question source: Webhook\nQuestion schedule: daily",
      },
    });
  });

  it("claims delivery before transport and records a failed receipt", async () => {
    const repo = repository({
      claimQuestionInteractionDelivery: vi.fn(async () => ({
        kind: "claimed" as const,
        attempt: { interaction: pending(), deliveryId: "delivery-1", requestKey: "request-1" },
      })),
      recordQuestionInteractionDeliveryResult: vi.fn(async (input) => ({
        interactionId: "interaction-1",
        deliveryId: input.deliveryId,
        requestKey: "request-1",
        status: "failed" as const,
        providerMessageRefs: input.providerMessageRefs,
      })),
    });
    const service = createQuestionInteractionService({ repository: repo });
    const receipt = await service.deliver({
      interactionId: "interaction-1",
      requestKey: "request-1",
      capabilities: {
        available: true,
        interactiveSingleSelect: false,
        interactiveBatch: false,
        nativeCustomResponse: false,
        textFallback: true,
        cancelControl: false,
      },
      transport: { deliver: vi.fn(async () => Promise.reject(new Error("offline"))) },
    });

    expect(receipt.status).toBe("failed");
    expect(repo.recordQuestionInteractionDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-1", errorCode: "Error" }),
    );
    expect(repo.markQuestionInteractionDeliveryFailed).toHaveBeenCalledWith("interaction-1");
  });

  it("resolves a text answer within its target before submitting it", async () => {
    const interaction = pending();
    const repo = repository({
      findPendingQuestionInteractionByPublicCode: vi.fn(async () => interaction),
    });
    const service = createQuestionInteractionService({ repository: repo });

    await service.submitTextAnswer({
      platform: "slack",
      conversationId: "D1",
      threadId: null,
      publicCode: "a1b2c3d4e5",
      questionId: "delivery-mode",
      optionId: "slack",
      responderPrincipalId: "user-1",
      inboundEventId: "event-3",
      receivedAt: "2026-08-10T00:00:00.000Z",
    });

    expect(repo.findPendingQuestionInteractionByPublicCode).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "slack", publicCode: "a1b2c3d4e5" }),
    );
    expect(repo.submitQuestionInteractionAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ interactionId: "interaction-1", optionId: "slack" }),
    );
  });

  it("claims a durable resume before executing and records completion", async () => {
    const work = {
      interactionId: "interaction-1",
      context: pending().resumeContext,
      answers: [{ questionId: "delivery-mode", optionId: "slack" }],
      continuationText: "Question delivery-mode: slack",
    };
    const repo = repository({ claimQuestionInteractionResume: vi.fn(async () => ({ kind: "claimed" as const, resumeWork: work })) });
    const service = createQuestionInteractionService({ repository: repo });
    const execute = vi.fn(async () => undefined);

    await expect(service.resumeQuestionInteraction(work, execute)).resolves.toEqual({ kind: "executed", interactionId: "interaction-1" });
    expect(execute).toHaveBeenCalledWith(work);
    expect(repo.recordQuestionInteractionResumeResult).toHaveBeenCalledWith({ interactionId: "interaction-1", status: "completed" });
  });

  it("cancels only a target-scoped public-code interaction without returning its prompt", async () => {
    const repo = repository({
      findPendingQuestionInteractionByPublicCode: vi.fn(async () => pending()),
      cancelQuestionInteraction: vi.fn(async () => ({ kind: "cancelled" as const, interaction: pending() })),
    });
    const service = createQuestionInteractionService({ repository: repo });

    await expect(
      service.cancelByCode({
        platform: "slack",
        conversationId: "D1",
        threadId: null,
        publicCode: "A1B2C3D4E5",
        responderPrincipalId: "user-1",
        inboundEventId: "event-cancel",
      }),
    ).resolves.toEqual({ kind: "cancelled", interactionId: "interaction-1" });
  });
});
