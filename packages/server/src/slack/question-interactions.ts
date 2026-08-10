import { renderNumberedQuestionStep } from "../agent/interactions/text";
import type {
  PendingQuestionInteraction,
  QuestionInteractionCapabilities,
  QuestionInteractionDeliveryAttempt,
  QuestionInteractionQuestion,
  QuestionInteractionTransport,
} from "../agent/interactions/types";

export type SlackQuestionActionValue = {
  interactionId: string;
  questionId?: string;
  optionId?: string;
  version: 1;
};

export function encodeSlackQuestionActionValue(value: SlackQuestionActionValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeSlackQuestionActionValue(value: string): SlackQuestionActionValue | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.interactionId !== "string" ||
      (parsed.questionId !== undefined && typeof parsed.questionId !== "string") ||
      (parsed.optionId !== undefined && typeof parsed.optionId !== "string")
    ) {
      return null;
    }
    return parsed as SlackQuestionActionValue;
  } catch {
    return null;
  }
}

function plainText(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text: text.slice(0, 3_000) };
}

export function renderSlackNumberedQuestion(question: QuestionInteractionQuestion): string {
  return renderNumberedQuestionStep({ question, questionNumber: 1, questionCount: 1 });
}

export function buildSlackQuestionModal(interaction: PendingQuestionInteraction): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "question_batch_submit",
    private_metadata: encodeSlackQuestionActionValue({ interactionId: interaction.id, version: 1 }),
    title: plainText("Questions"),
    submit: plainText("Submit"),
    close: plainText("Cancel"),
    blocks: interaction.questions.flatMap((question) => [
      {
        type: "input",
        block_id: `question:${question.questionId}`,
        optional: question.allowsCustomResponse,
        label: plainText(question.prompt),
        element: {
          type: "static_select",
          action_id: "answer",
          placeholder: plainText("Choose an answer"),
          options: question.options.map((option) => ({ text: plainText(option.label), value: option.id })),
        },
      },
      ...(question.allowsCustomResponse
        ? [
            {
              type: "input",
              block_id: `custom:${question.questionId}`,
              optional: true,
              label: plainText("Or write your own answer"),
              element: {
                type: "plain_text_input",
                action_id: "custom",
                max_length: 2_000,
              },
            },
          ]
        : []),
    ]),
  };
}

export function createSlackQuestionTransport(deps: {
  post: (input: { channelId: string; threadTs: string | null; text: string }) => Promise<string>;
}): QuestionInteractionTransport {
  return {
    async deliver(attempt: QuestionInteractionDeliveryAttempt, _capabilities: QuestionInteractionCapabilities) {
      const { interaction } = attempt;
      const question = interaction.questions[0];
      if (!question) throw new Error("Question interaction has no questions to deliver");
      const messageRef = await deps.post({
        channelId: interaction.target.conversationId,
        threadTs: interaction.target.threadId,
        text: renderNumberedQuestionStep({
          question,
          questionNumber: 1,
          questionCount: interaction.questions.length,
        }),
      });
      return { providerMessageRefs: messageRef ? [messageRef] : [] };
    },
  };
}
