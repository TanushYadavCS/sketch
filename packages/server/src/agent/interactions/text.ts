import { WEB_CHAT_QUESTION_MAX_CUSTOM_RESPONSE_LENGTH } from "@sketch/shared";
import type { PendingQuestionInteractionStep, QuestionInteractionQuestion } from "./types";

export type NumberedQuestionAnswer =
  | { questionId: string; optionId: string }
  | { questionId: string; customResponse: string };

export type NumberedQuestionAnswerParseOutcome =
  | { kind: "answer"; answer: NumberedQuestionAnswer }
  | { kind: "invalid"; message: string };

export function numberedQuestionReplyInstruction(question: QuestionInteractionQuestion): string {
  if (question.options.length === 0) return "Type your answer.";
  const range = question.options.length === 1 ? "1" : `1 to ${question.options.length}`;
  return question.allowsCustomResponse
    ? `Reply with a number from ${range}, or type your own answer.`
    : `Reply with a number from ${range}.`;
}

export function renderNumberedQuestionStep(
  step: Pick<PendingQuestionInteractionStep, "question" | "questionNumber" | "questionCount">,
): string {
  const progress = step.questionCount > 1 ? `*Question ${step.questionNumber} of ${step.questionCount}*` : "";
  const options = step.question.options
    .map((option, index) => {
      const description = option.description ? `\n_${option.description}_` : "";
      return `*${index + 1}. ${option.label}*${description}`;
    })
    .join("\n\n");
  return [
    progress,
    `*${step.question.prompt}*`,
    options,
    `_${numberedQuestionReplyInstruction(step.question)}_`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseNumberedQuestionAnswer(
  text: string,
  question: QuestionInteractionQuestion,
): NumberedQuestionAnswerParseOutcome {
  const response = text.trim();
  const instruction = numberedQuestionReplyInstruction(question);
  if (!response) return { kind: "invalid", message: instruction };

  if (/^[+-]?\d+(?:\.\d+)?$/.test(response)) {
    const optionNumber = Number(response);
    const option = Number.isInteger(optionNumber) ? question.options[optionNumber - 1] : undefined;
    return option
      ? { kind: "answer", answer: { questionId: question.questionId, optionId: option.id } }
      : { kind: "invalid", message: instruction };
  }

  if (!question.allowsCustomResponse) return { kind: "invalid", message: instruction };
  if (response.length > WEB_CHAT_QUESTION_MAX_CUSTOM_RESPONSE_LENGTH) {
    return {
      kind: "invalid",
      message: `Keep your answer under ${WEB_CHAT_QUESTION_MAX_CUSTOM_RESPONSE_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }
  return {
    kind: "answer",
    answer: { questionId: question.questionId, customResponse: response },
  };
}
