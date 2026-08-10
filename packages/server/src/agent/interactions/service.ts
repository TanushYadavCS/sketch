import {
  webChatQuestionAnswerSchema,
  type WebChatQuestion,
  type WebChatQuestionInteraction,
} from "@sketch/shared";
import type { QuestionInteractionSnapshot, QuestionInteractionsRepository } from "../../db/repositories/question-interactions";
import type {
  CanonicalQuestionAnswer,
  PendingQuestionInteraction,
  QuestionInteractionAnswerOutcome,
  QuestionInteractionCapabilities,
  QuestionInteractionCancelByCodeOutcome,
  QuestionInteractionCollector,
  QuestionInteractionDeliveryReceipt,
  QuestionInteractionLookupOutcome,
  QuestionInteractionRepository,
  QuestionInteractionResumeContext,
  QuestionInteractionResumeOutcome,
  QuestionInteractionResumeWork,
  QuestionInteractionStepLookupOutcome,
  QuestionInteractionTarget,
  QuestionInteractionTerminalOutcome,
  QuestionInteractionTransport,
  SubmittedQuestionAnswer,
  SubmittedQuestionBatchAnswer,
  SubmittedTextQuestionAnswer,
} from "./types";

function questionsFromInteraction(interaction: WebChatQuestionInteraction) {
  const questions = "batchId" in interaction ? interaction.questions : [interaction];
  return questions.map((question) => ({
    questionId: question.id,
    prompt: question.prompt,
    options: question.options,
    allowsCustomResponse: true,
  }));
}

function immutableResumeContext(input: QuestionInteractionResumeContext): QuestionInteractionResumeContext {
  return Object.freeze({ ...input, threadId: input.threadId ?? null, taskId: input.taskId ?? null, agentRunId: input.agentRunId ?? null, workspaceId: input.workspaceId ?? null, sourceConversationId: input.sourceConversationId ?? null });
}

function canonicalContinuationText(
  answers: readonly CanonicalQuestionAnswer[],
  questions: readonly PendingQuestionInteraction["questions"][number][] = [],
): string {
  const answersByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const orderedQuestions = questions.length > 0 ? questions : answers.map((answer) => ({ questionId: answer.questionId }));
  return orderedQuestions
    .flatMap((question) => {
      const answer = answersByQuestionId.get(question.questionId);
      if (!answer) return [];
      if ("customResponse" in answer && answer.customResponse !== undefined) {
        return [`${"prompt" in question ? question.prompt : question.questionId}: ${answer.customResponse}`];
      }
      const label = "options" in question ? question.options.find((option) => option.id === answer.optionId)?.label : undefined;
      return [`${"prompt" in question ? question.prompt : question.questionId}: ${label ?? answer.optionId ?? ""}`];
    })
    .join("\n");
}

function withCanonicalContinuation(
  outcome: QuestionInteractionAnswerOutcome,
  questions?: readonly PendingQuestionInteraction["questions"][number][],
): QuestionInteractionAnswerOutcome {
  if (outcome.kind !== "completed") return outcome;
  const answers = outcome.resumeWork.answers.map((answer) => ({ ...answer }));
  return {
    ...outcome,
    resumeWork: {
      ...outcome.resumeWork,
      answers,
      continuationText: questions ? canonicalContinuationText(answers, questions) : outcome.resumeWork.continuationText || canonicalContinuationText(answers),
    },
  };
}

function resumeContextFromSnapshot(snapshot: QuestionInteractionSnapshot): QuestionInteractionResumeContext {
  const source = snapshot.resumeContext;
  const record = source && typeof source === "object" ? source : {};
  return {
    sessionId: snapshot.sessionId,
    taskId: snapshot.taskId,
    agentRunId: snapshot.agentRunId,
    workspaceId: typeof (record as { workspaceId?: unknown }).workspaceId === "string" ? (record as { workspaceId: string }).workspaceId : null,
    sourceConversationId: typeof (record as { sourceConversationId?: unknown }).sourceConversationId === "string" ? (record as { sourceConversationId: string }).sourceConversationId : null,
    requesterPrincipalId: snapshot.target.requesterPrincipalId,
    platform: snapshot.target.platform,
    conversationKind: snapshot.target.conversationKind,
    conversationId: snapshot.target.conversationId,
    threadId: snapshot.target.threadId,
  };
}

function pendingFromSnapshot(snapshot: QuestionInteractionSnapshot): PendingQuestionInteraction {
  return {
    id: snapshot.interactionId,
    publicCode: snapshot.publicCode,
    state: snapshot.state,
    target: snapshot.target,
    questions: snapshot.questions,
    resumeContext: resumeContextFromSnapshot(snapshot),
    expiresAt: snapshot.expiresAt,
  };
}

export function createQuestionInteractionService(deps: {
  repository: QuestionInteractionRepository;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  return {
    supports(capabilities: QuestionInteractionCapabilities): boolean {
      return capabilities.available && (capabilities.interactiveSingleSelect || capabilities.textFallback);
    },

    async createFromInteraction(input: {
      interaction: WebChatQuestionInteraction;
      target: QuestionInteractionTarget;
      resumeContext: QuestionInteractionResumeContext;
      expiresAt: string;
    }): Promise<PendingQuestionInteraction | null> {
      return deps.repository.createPendingQuestionInteraction({
        target: { ...input.target, eligibleResponderPrincipalIds: [...input.target.eligibleResponderPrincipalIds] },
        questions: questionsFromInteraction(input.interaction),
        resumeContext: immutableResumeContext(input.resumeContext),
        expiresAt: input.expiresAt,
      });
    },

    async createFromCollector(input: {
      collector: QuestionInteractionCollector;
      target: QuestionInteractionTarget;
      resumeContext: QuestionInteractionResumeContext;
      expiresAt: string;
    }): Promise<PendingQuestionInteraction | null> {
      const interaction = input.collector.drain();
      if (!interaction) return null;
      return deps.repository.createPendingQuestionInteraction({
        target: { ...input.target, eligibleResponderPrincipalIds: [...input.target.eligibleResponderPrincipalIds] },
        questions: questionsFromInteraction(interaction),
        resumeContext: immutableResumeContext(input.resumeContext),
        expiresAt: input.expiresAt,
      });
    },

    async deliver(input: {
      interactionId: string;
      requestKey: string;
      transportName?: string;
      capabilityName?: string;
      capabilities: QuestionInteractionCapabilities;
      transport: QuestionInteractionTransport;
    }): Promise<QuestionInteractionDeliveryReceipt> {
      const claimed = await deps.repository.claimQuestionInteractionDelivery({
        interactionId: input.interactionId,
        requestKey: input.requestKey,
        transport: input.transportName ?? "channel",
        capability: input.capabilityName ?? "interaction",
      });
      if (claimed.kind === "already_sent") return claimed.receipt;
      if (claimed.kind === "not_pending") {
        return { interactionId: input.interactionId, deliveryId: "", requestKey: input.requestKey, status: "not_pending", providerMessageRefs: [] };
      }
      try {
        const receipt = await input.transport.deliver(claimed.attempt, input.capabilities);
        return deps.repository.recordQuestionInteractionDeliveryResult({
          deliveryId: claimed.attempt.deliveryId,
          providerMessageRefs: receipt.providerMessageRefs,
        });
      } catch (error) {
        const receipt = await deps.repository.recordQuestionInteractionDeliveryResult({
          deliveryId: claimed.attempt.deliveryId,
          providerMessageRefs: [],
          errorCode: error instanceof Error ? error.name : "delivery_error",
        });
        await deps.repository.markQuestionInteractionDeliveryFailed(claimed.attempt.interaction.id);
        return receipt;
      }
    },

    async submitAnswer(input: SubmittedQuestionAnswer): Promise<QuestionInteractionAnswerOutcome> {
      const parsed = webChatQuestionAnswerSchema.safeParse(
        "optionId" in input
          ? { questionId: input.questionId, optionId: input.optionId }
          : { questionId: input.questionId, customResponse: input.customResponse },
      );
      if (!parsed.success) {
        return { kind: "invalid", interactionId: input.interactionId, reason: "invalid_answer" };
      }
      return withCanonicalContinuation(
        await deps.repository.submitQuestionInteractionAnswer({ ...input, ...parsed.data }),
      );
    },

    async submitBatchAnswer(input: SubmittedQuestionBatchAnswer): Promise<QuestionInteractionAnswerOutcome> {
      const valid = input.answers.every((answer) => webChatQuestionAnswerSchema.safeParse(answer).success);
      if (!valid) return { kind: "invalid", interactionId: input.interactionId, reason: "invalid_answer" };
      return withCanonicalContinuation(await deps.repository.submitQuestionInteractionBatchAnswer(input));
    },

    async resumeQuestionInteraction(
      resumeWork: QuestionInteractionResumeWork,
      execute: (claimedResumeWork: QuestionInteractionResumeWork) => Promise<void>,
    ): Promise<QuestionInteractionResumeOutcome> {
      const claim = await deps.repository.claimQuestionInteractionResume(resumeWork.interactionId);
      if (claim.kind === "already_claimed") return { kind: "already_claimed", interactionId: resumeWork.interactionId };
      if (claim.kind === "not_ready") return { kind: "not_ready", interactionId: resumeWork.interactionId };
      try {
        await execute(claim.resumeWork);
        await deps.repository.recordQuestionInteractionResumeResult({
          interactionId: claim.resumeWork.interactionId,
          status: "completed",
        });
        return { kind: "executed", interactionId: claim.resumeWork.interactionId };
      } catch (error) {
        await deps.repository.recordQuestionInteractionResumeResult({
          interactionId: claim.resumeWork.interactionId,
          status: "failed",
        });
        throw error;
      }
    },

    async getPending(interactionId: string): Promise<QuestionInteractionLookupOutcome> {
      const interaction = await deps.repository.getPendingQuestionInteraction(interactionId);
      return interaction ? { kind: "found", interaction } : { kind: "not_found" };
    },

    async findPendingByCode(input: {
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      publicCode: string;
    }): Promise<QuestionInteractionLookupOutcome> {
      const interaction = await deps.repository.findPendingQuestionInteractionByPublicCode(input);
      return interaction ? { kind: "found", interaction } : { kind: "not_found" };
    },

    async findPendingForTarget(input: {
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      responderPrincipalId: string;
    }): Promise<QuestionInteractionStepLookupOutcome> {
      if (!deps.repository.findPendingQuestionInteractionForTarget) return { kind: "not_found" };
      return deps.repository.findPendingQuestionInteractionForTarget(input);
    },

    async submitTextAnswer(
      input: SubmittedTextQuestionAnswer,
    ): Promise<QuestionInteractionAnswerOutcome | { kind: "not_found" }> {
      const interaction = await deps.repository.findPendingQuestionInteractionByPublicCode(input);
      if (!interaction) return { kind: "not_found" };
      const { platform: _platform, conversationId: _conversationId, threadId: _threadId, publicCode: _publicCode, ...answer } = input;
      const parsed = webChatQuestionAnswerSchema.safeParse(
        "optionId" in answer
          ? { questionId: answer.questionId, optionId: answer.optionId }
          : { questionId: answer.questionId, customResponse: answer.customResponse },
      );
      if (!parsed.success) return { kind: "invalid", interactionId: interaction.id, reason: "invalid_answer" };
      return withCanonicalContinuation(
        await deps.repository.submitQuestionInteractionAnswer({ ...answer, ...parsed.data, interactionId: interaction.id }),
      );
    },

    async cancel(input: { interactionId: string; requesterPrincipalId: string; inboundEventId: string }): Promise<QuestionInteractionTerminalOutcome> {
      return deps.repository.cancelQuestionInteraction({ ...input, cancelledAt: now().toISOString() });
    },

    async cancelByCode(input: {
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      publicCode: string;
      responderPrincipalId: string;
      inboundEventId: string;
    }): Promise<QuestionInteractionCancelByCodeOutcome> {
      const interaction = await deps.repository.findPendingQuestionInteractionByPublicCode(input);
      if (!interaction) return { kind: "not_found" };
      const outcome = await deps.repository.cancelQuestionInteraction({
        interactionId: interaction.id,
        requesterPrincipalId: input.responderPrincipalId,
        inboundEventId: input.inboundEventId,
        cancelledAt: now().toISOString(),
      });
      if (outcome.kind === "cancelled") return { kind: "cancelled", interactionId: interaction.id };
      if (outcome.kind === "unauthorized") return { kind: "unauthorized", interactionId: interaction.id };
      return { kind: "not_pending", interactionId: interaction.id };
    },

    async cancelPendingForTarget(input: {
      target: Pick<QuestionInteractionTarget, "platform" | "conversationId" | "threadId">;
      requesterPrincipalId: string;
    }): Promise<{ kind: "cancelled"; interactionIds: readonly string[] } | { kind: "unsupported" }> {
      if (!deps.repository.cancelPendingQuestionInteractionsForTarget) return { kind: "unsupported" };
      const interactionIds = await deps.repository.cancelPendingQuestionInteractionsForTarget({
        ...input,
        cancelledAt: now().toISOString(),
      });
      return { kind: "cancelled", interactionIds };
    },

    async expire(interactionId: string): Promise<QuestionInteractionTerminalOutcome> {
      return deps.repository.expireQuestionInteraction({ interactionId, expiredAt: now().toISOString() });
    },
  };
}

export function createQuestionInteractionServiceFromRepository(repository: QuestionInteractionsRepository) {
  const deliveryMetadata = new Map<string, { interactionId: string; requestKey: string }>();
  return createQuestionInteractionService({
    repository: {
      async createPendingQuestionInteraction(input) {
        const created = await repository.createPendingQuestionInteraction({
          sessionId: input.resumeContext.sessionId,
          taskId: input.resumeContext.taskId,
          agentRunId: input.resumeContext.agentRunId,
          target: { ...input.target, eligibleResponderPrincipalIds: [...input.target.eligibleResponderPrincipalIds] },
          questions: input.questions.map((question) => ({ ...question, options: [...question.options] })),
          resumeContext: input.resumeContext,
          expiresAt: input.expiresAt,
        });
        const snapshot = created ? await repository.getQuestionInteractionSnapshot(created.id) : undefined;
        if (!snapshot) throw new Error("Created question interaction could not be loaded.");
        return pendingFromSnapshot(snapshot);
      },
      async claimQuestionInteractionDelivery(input) {
        const claimed = await repository.claimQuestionInteractionDelivery({
          interactionId: input.interactionId,
          requestKey: input.requestKey,
          transport: input.transport,
          capability: input.capability,
        });
        if (claimed.kind === "not_pending") return claimed;
        if (claimed.kind === "already_claimed") {
          return {
            kind: "already_sent" as const,
            receipt: {
              interactionId: input.interactionId,
              deliveryId: claimed.delivery.id,
              requestKey: input.requestKey,
              status: claimed.delivery.status === "failed" ? "failed" : "already_sent",
              providerMessageRefs: claimed.delivery.provider_message_ref ? [claimed.delivery.provider_message_ref] : [],
            },
          };
        }
        const snapshot = await repository.getQuestionInteractionSnapshot(input.interactionId);
        if (!snapshot || snapshot.state !== "pending") return { kind: "not_pending" as const };
        deliveryMetadata.set(claimed.delivery.id, {
          interactionId: input.interactionId,
          requestKey: input.requestKey,
        });
        return {
          kind: "claimed" as const,
          attempt: {
            interaction: pendingFromSnapshot(snapshot),
            deliveryId: claimed.delivery.id,
            requestKey: input.requestKey,
          },
        };
      },
      async recordQuestionInteractionDeliveryResult(input) {
        const metadata = deliveryMetadata.get(input.deliveryId);
        const status = input.errorCode ? "failed" : "sent";
        await repository.recordQuestionInteractionDeliveryResult({
          deliveryId: input.deliveryId,
          status,
          providerMessageRef: input.providerMessageRefs[0] ?? null,
          errorCode: input.errorCode ?? null,
        });
        return {
          interactionId: metadata?.interactionId ?? "",
          deliveryId: input.deliveryId,
          requestKey: metadata?.requestKey ?? "",
          status,
          providerMessageRefs: input.providerMessageRefs,
        };
      },
      async markQuestionInteractionDeliveryFailed(interactionId) {
        await repository.markQuestionInteractionDeliveryFailed(interactionId);
      },
      async submitQuestionInteractionAnswer(input) {
        const result = await repository.submitQuestionInteractionAnswer(input);
        if (result.kind === "accepted_pending") {
          return {
            kind: "accepted_pending" as const,
            interactionId: input.interactionId,
            answeredQuestionId: input.questionId,
            answerKind: "optionId" in input ? "option" : "custom",
          };
        }
        if (result.kind === "answered" && result.resumeWork) {
          const snapshot = await repository.getQuestionInteractionSnapshot(input.interactionId);
          if (!snapshot) return { kind: "not_pending" as const, interactionId: input.interactionId, state: "answered" as const };
          return {
            kind: "completed" as const,
            interactionId: input.interactionId,
            resumeWork: {
              interactionId: input.interactionId,
              context: resumeContextFromSnapshot(snapshot),
              answers: result.resumeWork.answers,
              continuationText: canonicalContinuationText(result.resumeWork.answers, snapshot.questions),
            },
          };
        }
        if (result.kind === "duplicate") return { kind: "duplicate" as const, interactionId: input.interactionId };
        if (result.kind === "stale") return { kind: "stale" as const, interactionId: input.interactionId };
        if (result.kind === "unauthorized") return { kind: "unauthorized" as const, interactionId: input.interactionId };
        if (result.kind === "invalid") return { kind: "invalid" as const, interactionId: input.interactionId, reason: "invalid_answer" as const };
        return { kind: "not_pending" as const, interactionId: input.interactionId, state: result.kind === "expired" ? "expired" : "delivery_failed" };
      },
      async submitQuestionInteractionBatchAnswer(input) {
        const result = await repository.submitQuestionInteractionBatchAnswer({ ...input, answers: [...input.answers] });
        if (result.kind === "answered" && result.resumeWork) {
          const snapshot = await repository.getQuestionInteractionSnapshot(input.interactionId);
          if (!snapshot) return { kind: "not_pending" as const, interactionId: input.interactionId, state: "answered" as const };
          return {
            kind: "completed" as const,
            interactionId: input.interactionId,
            resumeWork: {
              interactionId: input.interactionId,
              context: resumeContextFromSnapshot(snapshot),
              answers: result.resumeWork.answers,
              continuationText: canonicalContinuationText(result.resumeWork.answers, snapshot.questions),
            },
          };
        }
        if (result.kind === "duplicate") return { kind: "duplicate" as const, interactionId: input.interactionId };
        if (result.kind === "invalid") return { kind: "invalid" as const, interactionId: input.interactionId, reason: "invalid_answer" as const };
        return { kind: "not_pending" as const, interactionId: input.interactionId, state: "delivery_failed" as const };
      },
      async claimQuestionInteractionResume(interactionId) {
        const claim = await repository.claimQuestionInteractionResume(interactionId);
        if (claim.kind !== "claimed") return claim;
        const snapshot = await repository.getQuestionInteractionSnapshot(interactionId);
        if (!snapshot) return { kind: "not_ready" as const };
        return {
          kind: "claimed" as const,
          resumeWork: {
            interactionId,
            context: resumeContextFromSnapshot(snapshot),
            answers: claim.resumeWork.answers,
            continuationText: canonicalContinuationText(claim.resumeWork.answers, snapshot.questions),
          },
        };
      },
      async recordQuestionInteractionResumeResult(input) {
        await repository.recordQuestionInteractionResumeResult(input);
      },
      async cancelQuestionInteraction(input) {
        const before = await repository.getQuestionInteractionSnapshot(input.interactionId);
        if (!before) return { kind: "not_pending" as const, interactionId: input.interactionId, state: "delivery_failed" as const };
        if (!(await repository.cancelQuestionInteraction(input.interactionId, input.requesterPrincipalId, input.inboundEventId))) {
          return before.state === "pending"
            ? { kind: "unauthorized" as const, interactionId: input.interactionId }
            : { kind: "not_pending" as const, interactionId: input.interactionId, state: before.state };
        }
        return { kind: "cancelled" as const, interaction: { ...pendingFromSnapshot(before), state: "cancelled" } };
      },
      async expireQuestionInteraction(input) {
        await repository.expireDue(input.expiredAt);
        const snapshot = await repository.getQuestionInteractionSnapshot(input.interactionId);
        if (snapshot?.state === "expired") return { kind: "expired" as const, interaction: pendingFromSnapshot(snapshot) };
        return { kind: "not_pending" as const, interactionId: input.interactionId, state: snapshot?.state ?? "delivery_failed" };
      },
      async getPendingQuestionInteraction(interactionId) {
        const snapshot = await repository.getQuestionInteractionSnapshot(interactionId);
        return snapshot?.state === "pending" ? pendingFromSnapshot(snapshot) : null;
      },
      async findPendingQuestionInteractionByPublicCode(input) {
        const snapshot = await repository.getQuestionInteractionSnapshotByPublicCode(input);
        return snapshot?.state === "pending" ? pendingFromSnapshot(snapshot) : null;
      },
      async findPendingQuestionInteractionForTarget(input) {
        const result = await repository.findPendingQuestionInteractionForTarget(input);
        if (result.kind !== "found") return result;
        return {
          kind: "found" as const,
          interaction: pendingFromSnapshot(result.interaction),
          question: result.question,
          questionNumber: result.questionNumber,
          questionCount: result.questionCount,
        };
      },
      async cancelPendingQuestionInteractionsForTarget(input) {
        const result = await repository.cancelPendingQuestionInteractionsForTarget({
          platform: input.target.platform,
          conversationId: input.target.conversationId,
          threadId: input.target.threadId,
          requesterPrincipalId: input.requesterPrincipalId,
        });
        return result.cancelledIds;
      },
    },
  });
}

export type QuestionInteractionService = ReturnType<typeof createQuestionInteractionService>;
