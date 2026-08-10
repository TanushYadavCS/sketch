import type { WebChatQuestion, WebChatQuestionInteraction } from "@sketch/shared";

export type QuestionInteractionPlatform = "web" | "slack" | "whatsapp";
export type QuestionInteractionConversationKind = "dm" | "channel" | "group";
export type QuestionInteractionState = "pending" | "answered" | "cancelled" | "expired" | "delivery_failed";
export type QuestionAnswerKind = "option" | "custom";

export interface QuestionInteractionTarget {
  platform: QuestionInteractionPlatform;
  conversationKind: QuestionInteractionConversationKind;
  conversationId: string;
  threadId: string | null;
  requesterPrincipalId: string;
  eligibleResponderPrincipalIds: readonly string[];
}

export interface QuestionInteractionCapabilities {
  available: boolean;
  interactiveSingleSelect: boolean;
  interactiveBatch: boolean;
  nativeCustomResponse: boolean;
  textFallback: boolean;
  cancelControl: boolean;
}

export interface QuestionInteractionResumeContext {
  sessionId: string;
  taskId: string | null;
  agentRunId: string | null;
  workspaceId: string | null;
  sourceConversationId?: string | null;
  requesterPrincipalId: string;
  platform: QuestionInteractionPlatform;
  conversationKind?: QuestionInteractionConversationKind;
  conversationId: string;
  threadId: string | null;
}

export interface QuestionInteractionQuestion {
  questionId: string;
  prompt: string;
  options: WebChatQuestion["options"];
  allowsCustomResponse: boolean;
}

export interface PendingQuestionInteraction {
  id: string;
  publicCode: string;
  state: QuestionInteractionState;
  target: QuestionInteractionTarget;
  questions: readonly QuestionInteractionQuestion[];
  resumeContext: QuestionInteractionResumeContext;
  expiresAt: string;
}

export interface PendingQuestionInteractionStep {
  interaction: PendingQuestionInteraction;
  question: QuestionInteractionQuestion;
  questionNumber: number;
  questionCount: number;
}

export type SubmittedQuestionAnswer =
  | {
      interactionId: string;
      questionId: string;
      optionId: string;
      responderPrincipalId: string;
      inboundEventId: string;
      receivedAt: string;
    }
  | {
      interactionId: string;
      questionId: string;
      customResponse: string;
      responderPrincipalId: string;
      inboundEventId: string;
      receivedAt: string;
    };

export type SubmittedTextQuestionAnswer =
  | ({
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      publicCode: string;
    } & Omit<Extract<SubmittedQuestionAnswer, { optionId: string }>, "interactionId">)
  | ({
      platform: "slack" | "whatsapp";
      conversationId: string;
      threadId: string | null;
      publicCode: string;
    } & Omit<Extract<SubmittedQuestionAnswer, { customResponse: string }>, "interactionId">);

export interface SubmittedQuestionBatchAnswer {
  interactionId: string;
  answers: readonly ({ questionId: string; optionId: string } | { questionId: string; customResponse: string })[];
  responderPrincipalId: string;
  inboundEventId: string;
  receivedAt: string;
}

export interface CanonicalQuestionAnswer {
  questionId: string;
  optionId?: string;
  customResponse?: string;
}

export interface QuestionInteractionResumeWork {
  interactionId: string;
  context: QuestionInteractionResumeContext;
  answers: readonly CanonicalQuestionAnswer[];
  continuationText: string;
}

export type QuestionInteractionResumeOutcome =
  | { kind: "executed"; interactionId: string }
  | { kind: "already_claimed"; interactionId: string }
  | { kind: "not_ready"; interactionId: string };

export interface QuestionInteractionDeliveryReceipt {
  interactionId: string;
  deliveryId: string;
  requestKey: string;
  status: "sent" | "already_sent" | "not_pending" | "failed";
  providerMessageRefs: readonly string[];
}

export interface QuestionInteractionDeliveryAttempt {
  interaction: PendingQuestionInteraction;
  deliveryId: string;
  requestKey: string;
}

export type QuestionInteractionAnswerOutcome =
  | { kind: "accepted_pending"; interactionId: string; answeredQuestionId: string; answerKind: QuestionAnswerKind }
  | { kind: "completed"; interactionId: string; resumeWork: QuestionInteractionResumeWork }
  | { kind: "duplicate"; interactionId: string }
  | { kind: "stale"; interactionId: string }
  | { kind: "unauthorized"; interactionId: string }
  | {
      kind: "invalid";
      interactionId: string;
      reason: "unknown_question" | "invalid_option" | "custom_not_allowed" | "invalid_answer";
    }
  | { kind: "not_pending"; interactionId: string; state: Exclude<QuestionInteractionState, "pending"> };

export type QuestionInteractionLookupOutcome =
  | { kind: "found"; interaction: PendingQuestionInteraction }
  | { kind: "not_found" };

export type QuestionInteractionStepLookupOutcome =
  | ({ kind: "found" } & PendingQuestionInteractionStep)
  | { kind: "not_found" };

export type QuestionInteractionTerminalOutcome =
  | { kind: "cancelled"; interaction: PendingQuestionInteraction }
  | { kind: "expired"; interaction: PendingQuestionInteraction }
  | { kind: "not_pending"; interactionId: string; state: Exclude<QuestionInteractionState, "pending"> }
  | { kind: "unauthorized"; interactionId: string };

export type QuestionInteractionCancelByCodeOutcome =
  | { kind: "cancelled"; interactionId: string }
  | { kind: "not_found" }
  | { kind: "not_pending"; interactionId: string }
  | { kind: "unauthorized"; interactionId: string };

export interface QuestionInteractionRepository {
  createPendingQuestionInteraction(input: {
    target: QuestionInteractionTarget;
    questions: readonly QuestionInteractionQuestion[];
    resumeContext: QuestionInteractionResumeContext;
    expiresAt: string;
  }): Promise<PendingQuestionInteraction>;
  claimQuestionInteractionDelivery(input: {
    interactionId: string;
    requestKey: string;
    transport: string;
    capability: string;
  }): Promise<
    | { kind: "claimed"; attempt: QuestionInteractionDeliveryAttempt }
    | { kind: "already_sent"; receipt: QuestionInteractionDeliveryReceipt }
    | { kind: "not_pending" }
  >;
  recordQuestionInteractionDeliveryResult(input: {
    deliveryId: string;
    providerMessageRefs: readonly string[];
    errorCode?: string;
  }): Promise<QuestionInteractionDeliveryReceipt>;
  markQuestionInteractionDeliveryFailed(interactionId: string): Promise<void>;
  submitQuestionInteractionAnswer(input: SubmittedQuestionAnswer): Promise<QuestionInteractionAnswerOutcome>;
  submitQuestionInteractionBatchAnswer(input: SubmittedQuestionBatchAnswer): Promise<QuestionInteractionAnswerOutcome>;
  claimQuestionInteractionResume(
    interactionId: string,
  ): Promise<
    { kind: "claimed"; resumeWork: QuestionInteractionResumeWork } | { kind: "already_claimed" } | { kind: "not_ready" }
  >;
  recordQuestionInteractionResumeResult(input: {
    interactionId: string;
    status: "completed" | "failed";
  }): Promise<void>;
  cancelQuestionInteraction(input: {
    interactionId: string;
    requesterPrincipalId: string;
    inboundEventId: string;
    cancelledAt: string;
  }): Promise<QuestionInteractionTerminalOutcome>;
  expireQuestionInteraction(input: {
    interactionId: string;
    expiredAt: string;
  }): Promise<QuestionInteractionTerminalOutcome>;
  getPendingQuestionInteraction(interactionId: string): Promise<PendingQuestionInteraction | null>;
  findPendingQuestionInteractionByPublicCode(input: {
    platform: Extract<QuestionInteractionPlatform, "slack" | "whatsapp">;
    conversationId: string;
    threadId: string | null;
    publicCode: string;
  }): Promise<PendingQuestionInteraction | null>;
  findPendingQuestionInteractionForTarget?(input: {
    platform: Extract<QuestionInteractionPlatform, "slack" | "whatsapp">;
    conversationId: string;
    threadId: string | null;
    responderPrincipalId: string;
  }): Promise<QuestionInteractionStepLookupOutcome>;
  cancelPendingQuestionInteractionsForTarget?(input: {
    target: Pick<QuestionInteractionTarget, "platform" | "conversationId" | "threadId">;
    requesterPrincipalId: string;
    cancelledAt: string;
  }): Promise<readonly string[]>;
}

export interface QuestionInteractionTransport {
  deliver(
    input: QuestionInteractionDeliveryAttempt,
    capabilities: QuestionInteractionCapabilities,
  ): Promise<{
    providerMessageRefs: readonly string[];
  }>;
}

export interface QuestionInteractionCollector {
  drain(): WebChatQuestionInteraction | null;
}
