import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  WEB_CHAT_QUESTION_MAX_OPTIONS,
  WEB_CHAT_QUESTION_MIN_OPTIONS,
  type WebChatQuestion,
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

const askUserQuestionDescription = `Ask the user one bounded multiple-choice question when you cannot proceed without a decision. This ends the current run and creates a pending web-chat question; after calling it, stop and wait for the user's selection. Provide exactly ${WEB_CHAT_QUESTION_MIN_OPTIONS}–${WEB_CHAT_QUESTION_MAX_OPTIONS} options. Every option must have a stable id that is not its array position; reuse the same questionId and option ids if the question is retried.`;

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
        prompt: input.question,
        options: input.options,
      };
      deps.questionCollector.collect(question);
      return {
        content: [{ type: "text", text: "Question is pending. Stop this run and wait for the user's selection." }],
      };
    },
  );
}
