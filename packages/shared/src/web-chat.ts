import { z } from "zod";

export const WEB_CHAT_PROGRESS_RENDERER_MODES = ["off", "friendly", "technical"] as const;

export type WebChatProgressRendererMode = (typeof WEB_CHAT_PROGRESS_RENDERER_MODES)[number];

export const WEB_CHAT_QUESTION_MIN_OPTIONS = 2;
export const WEB_CHAT_QUESTION_MAX_OPTIONS = 4;
export const WEB_CHAT_QUESTION_MAX_PROMPT_LENGTH = 500;
export const WEB_CHAT_QUESTION_MAX_OPTION_LABEL_LENGTH = 160;
export const WEB_CHAT_QUESTION_MAX_OPTION_DESCRIPTION_LENGTH = 240;
export const WEB_CHAT_QUESTION_MAX_ID_LENGTH = 80;
export const WEB_CHAT_QUESTION_MAX_CUSTOM_RESPONSE_LENGTH = 2_000;
export const WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS = 2;
export const WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS = 4;

const WEB_CHAT_QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const webChatQuestionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(WEB_CHAT_QUESTION_MAX_ID_LENGTH)
  .regex(WEB_CHAT_QUESTION_ID_PATTERN);

export const webChatQuestionPromptSchema = z.string().trim().min(1).max(WEB_CHAT_QUESTION_MAX_PROMPT_LENGTH);

export const webChatQuestionOptionSchema = z
  .object({
    id: webChatQuestionIdSchema,
    label: z.string().trim().min(1).max(WEB_CHAT_QUESTION_MAX_OPTION_LABEL_LENGTH),
    description: z.string().trim().min(1).max(WEB_CHAT_QUESTION_MAX_OPTION_DESCRIPTION_LENGTH).optional(),
  })
  .strict();

export const webChatQuestionSchema = z
  .object({
    id: webChatQuestionIdSchema,
    prompt: webChatQuestionPromptSchema,
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

export type WebChatQuestionOption = z.infer<typeof webChatQuestionOptionSchema>;
export type WebChatQuestion = z.infer<typeof webChatQuestionSchema>;

export const webChatQuestionBatchIdSchema = webChatQuestionIdSchema;

export const webChatQuestionBatchSchema = z
  .object({
    batchId: webChatQuestionBatchIdSchema,
    questions: z
      .array(webChatQuestionSchema)
      .min(WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS)
      .max(WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const questionIds = new Set<string>();
    for (const [index, question] of batch.questions.entries()) {
      if (questionIds.has(question.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", index, "id"],
          message: "Question IDs must be unique within a batch.",
        });
      }
      questionIds.add(question.id);
    }
  });

export type WebChatQuestionBatch = z.infer<typeof webChatQuestionBatchSchema>;
export type WebChatQuestionInteraction = WebChatQuestion | WebChatQuestionBatch;

export const webChatQuestionAnswerSchema = z.union([
  z
    .object({
      questionId: webChatQuestionIdSchema,
      optionId: webChatQuestionIdSchema,
    })
    .strict(),
  z
    .object({
      questionId: webChatQuestionIdSchema,
      customResponse: z.string().trim().min(1).max(WEB_CHAT_QUESTION_MAX_CUSTOM_RESPONSE_LENGTH),
    })
    .strict(),
]);

export type WebChatQuestionAnswer = z.infer<typeof webChatQuestionAnswerSchema>;

export const webChatQuestionBatchAnswerSchema = z
  .object({
    batchId: webChatQuestionBatchIdSchema,
    answers: z
      .array(webChatQuestionAnswerSchema)
      .min(WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS)
      .max(WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const questionIds = new Set<string>();
    for (const [index, answer] of batch.answers.entries()) {
      if (questionIds.has(answer.questionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answers", index, "questionId"],
          message: "Question answers must be unique within a batch.",
        });
      }
      questionIds.add(answer.questionId);
    }
  });

export type WebChatQuestionBatchAnswer = z.infer<typeof webChatQuestionBatchAnswerSchema>;

export type WebChatPendingInteraction =
  | { kind: "question"; question: WebChatQuestion }
  | { kind: "question_batch"; batch: WebChatQuestionBatch };

export interface WebChatProgressSettings {
  toolProgress: WebChatProgressRendererMode;
}

export type WebProgressItemKind =
  | "reasoning"
  | "file"
  | "search"
  | "shell"
  | "web"
  | "canvas"
  | "skill"
  | "integration"
  | "attachment"
  | "audio"
  | "image"
  | "schedule"
  | "entity"
  | "chat"
  | "delivery"
  | "local"
  | "tool";

export type WebProgressIconType = "tool" | "skill" | "canvas" | "generic";

export interface WebProgressIcon {
  type: WebProgressIconType;
  name?: string;
}

export interface WebProgressItem {
  kind: WebProgressItemKind;
  label: string;
  icon: WebProgressIcon;
  detail?: string;
  toolName?: string;
}

export interface WebChatProgressData {
  lines: string[];
  items?: WebProgressItem[];
}

export interface WebChatIntegrationConnectionData {
  requestId: string;
  appId: string;
  appName: string;
  state?: "connect" | "connected";
  icon?: string;
  reason?: string;
  connectUrl?: string;
  accountName?: string;
  connectionId?: string | null;
}
