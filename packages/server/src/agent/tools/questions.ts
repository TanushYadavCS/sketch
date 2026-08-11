import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS,
  WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS,
  WEB_CHAT_QUESTION_MAX_OPTIONS,
  WEB_CHAT_QUESTION_MIN_OPTIONS,
  type WebChatQuestion,
  type WebChatQuestionBatch,
  webChatQuestionBatchIdSchema,
  webChatQuestionIdSchema,
  webChatQuestionOptionSchema,
  webChatQuestionPromptSchema,
} from "@sketch/shared";
import { z } from "zod/v4";
import type { SketchMcpDeps, ToolResult } from "./types";

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export const askUserQuestionInputSchema = z
  .object({
    questionId: webChatQuestionIdSchema,
    question: webChatQuestionPromptSchema,
    options: z.array(webChatQuestionOptionSchema).min(WEB_CHAT_QUESTION_MIN_OPTIONS).max(WEB_CHAT_QUESTION_MAX_OPTIONS),
  })
  .strict()
  .superRefine((question, ctx) => {
    const optionIds = new Set<string>();
    for (const [index, option] of question.options.entries()) {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "id"],
          message: "Question option IDs must be unique.",
        });
      }
      optionIds.add(option.id);
    }
  });

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;

function formatQuestionPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

const askUserQuestionDescription = `Ask the user one bounded multiple-choice question when you cannot proceed without a decision. In the automation builder, use AskUserQuestions when several independent bounded setup choices are known; use this tool when only one choice is ready. This ends the current run and creates a pending chat-surface question; after calling it, stop and wait for the user's selection. Provide exactly ${WEB_CHAT_QUESTION_MIN_OPTIONS}–${WEB_CHAT_QUESTION_MAX_OPTIONS} options. Every option must have a stable id that is not its array position; reuse the same questionId and option ids if the question is retried.`;

export const ASK_USER_QUESTIONS_TOOL_NAME = "AskUserQuestions";

export const askUserQuestionsInputSchema = z
  .object({
    batchId: webChatQuestionBatchIdSchema,
    questions: z
      .array(
        z.object({
          questionId: webChatQuestionIdSchema,
          question: webChatQuestionPromptSchema,
          options: z
            .array(webChatQuestionOptionSchema)
            .min(WEB_CHAT_QUESTION_MIN_OPTIONS)
            .max(WEB_CHAT_QUESTION_MAX_OPTIONS),
        }),
      )
      .min(WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS)
      .max(WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const questionIds = new Set<string>();
    for (const [index, question] of batch.questions.entries()) {
      if (questionIds.has(question.questionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", index, "questionId"],
          message: "Question IDs must be unique within a batch.",
        });
      }
      questionIds.add(question.questionId);
      const optionIds = new Set<string>();
      for (const [optionIndex, option] of question.options.entries()) {
        if (optionIds.has(option.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", index, "options", optionIndex, "id"],
            message: "Question option IDs must be unique.",
          });
        }
        optionIds.add(option.id);
      }
    }
  });

export type AskUserQuestionsInput = z.infer<typeof askUserQuestionsInputSchema>;

const askUserQuestionsDescription = `Ask the user a bounded batch of independent multiple-choice questions when the automation builder needs several setup choices before it can proceed. Use this only when all questions are ready together; otherwise use AskUserQuestion. For a new automation that needs setup, execution mode must be the first question unless the user already selected it; do not add that question for a simple reminder that can be created directly. Provide ${WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS}–${WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS} questions, exactly ${WEB_CHAT_QUESTION_MIN_OPTIONS}–${WEB_CHAT_QUESTION_MAX_OPTIONS} options per question, stable question and option IDs, and no duplicate IDs. This ends the current run and creates a pending chat-surface interaction; after calling it, stop and wait for the user's selections.`;

export function createAskUserQuestionTool(deps: Pick<SketchMcpDeps, "questionCollector">) {
  return tool(
    ASK_USER_QUESTION_TOOL_NAME,
    askUserQuestionDescription,
    askUserQuestionInputSchema.shape,
    async (args): Promise<ToolResult> => {
      if (!deps.questionCollector) {
        return { content: [{ type: "text", text: "Asking a user question is not available in this context." }] };
      }

      const input = askUserQuestionInputSchema.parse(args);
      const question: WebChatQuestion = {
        id: input.questionId,
        prompt: formatQuestionPrompt(input.question),
        options: input.options,
      };
      deps.questionCollector.collect(question);
      return {
        content: [{ type: "text", text: "Question is pending. Stop this run and wait for the user's selection." }],
      };
    },
  );
}

export function createAskUserQuestionsTool(deps: Pick<SketchMcpDeps, "questionCollector">) {
  return tool(
    ASK_USER_QUESTIONS_TOOL_NAME,
    askUserQuestionsDescription,
    askUserQuestionsInputSchema.shape,
    async (args): Promise<ToolResult> => {
      if (!deps.questionCollector) {
        return { content: [{ type: "text", text: "Asking user questions is not available in this context." }] };
      }

      const input = askUserQuestionsInputSchema.parse(args);
      const batch: WebChatQuestionBatch = {
        batchId: input.batchId,
        questions: input.questions.map((question) => ({
          id: question.questionId,
          prompt: formatQuestionPrompt(question.question),
          options: question.options,
        })),
      };
      deps.questionCollector.collectBatch(batch);
      return {
        content: [{ type: "text", text: "Questions are pending. Stop this run and wait for the user's selections." }],
      };
    },
  );
}
