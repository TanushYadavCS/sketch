import { WEB_CHAT_QUESTION_MAX_OPTIONS, WEB_CHAT_QUESTION_MIN_OPTIONS, webChatQuestionSchema } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { askUserQuestionInputSchema, createAskUserQuestionTool } from "./questions";
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
