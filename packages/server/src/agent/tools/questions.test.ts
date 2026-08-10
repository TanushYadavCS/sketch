import {
  WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS,
  WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS,
  WEB_CHAT_QUESTION_MAX_OPTIONS,
  WEB_CHAT_QUESTION_MIN_OPTIONS,
  webChatQuestionBatchSchema,
  webChatQuestionSchema,
} from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  askUserQuestionInputSchema,
  askUserQuestionsInputSchema,
  createAskUserQuestionTool,
  createAskUserQuestionsTool,
} from "./questions";
import { QuestionCollector } from "./types";

describe("AskUserQuestion", () => {
  it("keeps stable IDs and bounds the number of choices", async () => {
    const collector = new QuestionCollector();
    const questionTool = createAskUserQuestionTool({ questionCollector: collector });
    const input = {
      questionId: "schedule-frequency",
      question: "How often should Sketch run this?",
      options: [
        { id: "daily", label: "Daily" },
        { id: "weekly", label: "Weekly", description: "Once each week." },
      ],
    };

    expect(z.object(questionTool.inputSchema).safeParse(input).success).toBe(true);
    await questionTool.handler(input, {});
    expect(collector.drain()).toEqual({
      id: "schedule-frequency",
      prompt: "How often should Sketch run this?",
      options: input.options,
    });
  });

  it("normalizes prompt whitespace without changing the question ID or options", async () => {
    const collector = new QuestionCollector();
    const questionTool = createAskUserQuestionTool({ questionCollector: collector });
    const options = [
      { id: "slack", label: "Slack" },
      { id: "email", label: "Email" },
    ];

    await questionTool.handler(
      {
        questionId: "delivery-mode",
        question: "\n  Where should\tSketch send the\nresult?  ",
        options,
      },
      {},
    );

    expect(collector.drain()).toEqual({
      id: "delivery-mode",
      prompt: "Where should Sketch send the result?",
      options,
    });
  });

  it("collects a bounded batch with stable question IDs", async () => {
    const collector = new QuestionCollector();
    const questionTool = createAskUserQuestionsTool({ questionCollector: collector });
    const input = {
      batchId: "automation-setup",
      questions: [
        {
          questionId: "input-source",
          question: "Where should the automation read from?",
          options: [
            { id: "gmail", label: "Gmail" },
            { id: "drive", label: "Google Drive" },
          ],
        },
        {
          questionId: "schedule",
          question: "How often should it run?",
          options: [
            { id: "daily", label: "Daily" },
            { id: "weekly", label: "Weekly" },
          ],
        },
      ],
    };

    await questionTool.handler(input, {});
    expect(collector.drain()).toEqual({
      batchId: input.batchId,
      questions: input.questions.map((question) => ({
        id: question.questionId,
        prompt: question.question,
        options: question.options,
      })),
    });
  });

  it("rejects duplicate batch question IDs and invalid batch sizes", () => {
    const duplicate = {
      batchId: "setup",
      questions: [
        {
          questionId: "same",
          question: "First",
          options: [
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ],
        },
        {
          questionId: "same",
          question: "Second",
          options: [
            { id: "three", label: "Three" },
            { id: "four", label: "Four" },
          ],
        },
      ],
    };

    expect(askUserQuestionsInputSchema.safeParse(duplicate).success).toBe(false);
    expect(webChatQuestionBatchSchema.safeParse(duplicate).success).toBe(false);
    expect(
      webChatQuestionBatchSchema.safeParse({ ...duplicate, questions: duplicate.questions.slice(0, 1) }).success,
    ).toBe(false);
    expect(WEB_CHAT_QUESTION_BATCH_MIN_QUESTIONS).toBe(2);
    expect(WEB_CHAT_QUESTION_BATCH_MAX_QUESTIONS).toBe(4);
  });

  it("rejects duplicate IDs and option counts outside the bound", () => {
    const duplicate = {
      questionId: "choice",
      question: "Pick one",
      options: [
        { id: "same", label: "First" },
        { id: "same", label: "Second" },
      ],
    };
    const tooFew = { ...duplicate, options: [{ id: "one", label: "Only one" }] };
    const tooMany = {
      ...duplicate,
      options: Array.from({ length: WEB_CHAT_QUESTION_MAX_OPTIONS + 1 }, (_, index) => ({
        id: `option-${index}`,
        label: `Option ${index}`,
      })),
    };

    expect(askUserQuestionInputSchema.safeParse(duplicate).success).toBe(false);
    expect(askUserQuestionInputSchema.safeParse(tooFew).success).toBe(false);
    expect(askUserQuestionInputSchema.safeParse(tooMany).success).toBe(false);
    expect(WEB_CHAT_QUESTION_MIN_OPTIONS).toBe(2);
    expect(
      webChatQuestionSchema.safeParse({ id: "choice", prompt: "Pick one", options: duplicate.options }).success,
    ).toBe(false);
  });
});
