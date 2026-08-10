import type {
  PendingQuestionInteraction,
  QuestionInteractionCapabilities,
  QuestionInteractionQuestion,
  SubmittedQuestionAnswer,
} from "../agent/interactions/types";
import { parseNumberedQuestionAnswer, renderNumberedQuestionStep } from "../agent/interactions/text";
import type { WhatsAppInboundMessage, WhatsAppTarget } from "./provider";
import type { WhatsAppRuntime } from "./runtime";

export const WHATSAPP_TEXT_QUESTION_CAPABILITIES: QuestionInteractionCapabilities = {
  available: true,
  interactiveSingleSelect: false,
  interactiveBatch: false,
  nativeCustomResponse: true,
  textFallback: true,
  cancelControl: false,
};

export type WhatsAppNumberedQuestionSubmission =
  | { kind: "answer"; optionId: string }
  | { kind: "answer"; customResponse: string }
  | { kind: "invalid_option" }
  | { kind: "unrecognized" };

export type WhatsAppTextQuestionSubmission =
  | { kind: "answer"; code: string; questionId: string; optionId: string }
  | { kind: "answer"; code: string; questionId: string; customResponse: string }
  | { kind: "cancel"; code: string }
  | { kind: "unrecognized" };

export function whatsappQuestionCode(publicCode: string): string {
  return publicCode.trim().toUpperCase();
}

export function renderWhatsAppTextQuestionInteraction(interaction: PendingQuestionInteraction): string {
  const question = interaction.questions[0];
  if (!question) throw new Error("WhatsApp question interaction has no questions");
  return renderNumberedQuestionStep({ question, questionNumber: 1, questionCount: interaction.questions.length });
}

export function renderWhatsAppNumberedQuestion(question: QuestionInteractionQuestion): string {
  return renderNumberedQuestionStep({ question, questionNumber: 1, questionCount: 1 });
}

export function parseWhatsAppNumberedQuestionSubmission(
  text: string,
  question: QuestionInteractionQuestion,
): WhatsAppNumberedQuestionSubmission {
  if (!text.trim()) return { kind: "unrecognized" };
  const parsed = parseNumberedQuestionAnswer(text, question);
  if (parsed.kind === "invalid") return { kind: "invalid_option" };
  return "optionId" in parsed.answer
    ? { kind: "answer", optionId: parsed.answer.optionId }
    : { kind: "answer", customResponse: parsed.answer.customResponse };
}

export function parseWhatsAppTextQuestionSubmission(text: string): WhatsAppTextQuestionSubmission {
  const cancel = /^\s*cancel\s+([A-Za-z0-9]+)\s*$/iu.exec(text);
  if (cancel) return { kind: "cancel", code: cancel[1] };
  const match = /^\s*answer\s+([A-Za-z0-9]+)\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+(.+?)\s*$/iu.exec(text);
  if (!match) return { kind: "unrecognized" };
  const [, code, questionId, rawAnswer] = match;
  const custom = /^custom\s*:\s*(.*)$/isu.exec(rawAnswer);
  if (custom) {
    return { kind: "answer", code, questionId, customResponse: custom[1] };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(rawAnswer)) return { kind: "unrecognized" };
  return { kind: "answer", code, questionId, optionId: rawAnswer };
}

export function whatsappSubmittedQuestionAnswer(params: {
  interactionId: string;
  submission: Extract<WhatsAppTextQuestionSubmission, { kind: "answer" }>;
  responderPrincipalId: string;
  inboundEventId: string;
  receivedAt: string;
}): SubmittedQuestionAnswer {
  const base = {
    interactionId: params.interactionId,
    questionId: params.submission.questionId,
    responderPrincipalId: params.responderPrincipalId,
    inboundEventId: params.inboundEventId,
    receivedAt: params.receivedAt,
  };
  return "customResponse" in params.submission
    ? { ...base, customResponse: params.submission.customResponse }
    : { ...base, optionId: params.submission.optionId };
}

export function createWhatsAppTextQuestionTransport(params: {
  whatsapp: WhatsAppRuntime;
  target: WhatsAppTarget;
  quotedMessage?: WhatsAppInboundMessage;
}) {
  return {
    async deliver(input: {
      interaction: PendingQuestionInteraction;
    }): Promise<{ providerMessageRefs: readonly string[] }> {
      if (!params.whatsapp.isConnected) throw new Error("WhatsApp is not connected");
      const sent = await params.whatsapp.sendText(
        params.target,
        renderWhatsAppTextQuestionInteraction(input.interaction),
        params.quotedMessage ? { quotedMessage: params.quotedMessage } : undefined,
      );
      return { providerMessageRefs: sent?.providerMessageId ? [sent.providerMessageId] : [] };
    },
  };
}
