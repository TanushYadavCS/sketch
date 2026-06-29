import { describe, expect, it } from "vitest";
import type { GeminiGenerator } from "./gemini-generate";
import { extractLlmTaskCandidates } from "./llm-task-extraction";

describe("extractLlmTaskCandidates", () => {
  it("uses the injected Gemini generator and validates task candidates", async () => {
    const generateJSONCalls: Array<{ prompt: string; opts?: Parameters<GeminiGenerator["generateJSON"]>[1] }> = [];
    const generateJSON: GeminiGenerator["generateJSON"] = async <T>(
      prompt: string,
      opts?: Parameters<GeminiGenerator["generateJSON"]>[1],
    ) => {
      generateJSONCalls.push({ prompt, opts });
      return {
        tasks: [
          {
            title: "Ship Slack capture",
            owner: { name: "Alice", email: "alice@example.com" },
            dueDate: "2025-04-30",
            hasOwnerVerbObject: true,
            sourceExcerpt: "Alice will ship the Slack capture by Friday.",
          },
          {
            title: "Discuss roadmap",
            owner: { name: "Bob" },
            dueDate: "not-a-date",
            hasOwnerVerbObject: false,
          },
          { title: "", hasOwnerVerbObject: true },
          { title: "Missing validation flag" },
        ],
      } as T;
    };

    const candidates = await extractLlmTaskCandidates({
      content: "Alice will ship the Slack capture by Friday.",
      sourceDate: "2025-04-25",
      attendees: [{ name: "Alice", email: "alice@example.com" }],
      parentRefs: [{ source: "linear", sourceId: "project-a" }],
      generator: fakeGenerator(generateJSON),
      dumpDir: "tmp/dumps",
    });

    expect(generateJSONCalls).toEqual([
      {
        prompt: expect.stringContaining("Alice will ship the Slack capture"),
        opts: { maxTokens: 8192, label: "extractLlmTask", dumpDir: "tmp/dumps" },
      },
    ]);
    expect(candidates).toEqual([
      {
        title: "Ship Slack capture",
        owner: { name: "Alice", email: "alice@example.com" },
        dueDate: "2025-04-30",
        hasOwnerVerbObject: true,
        sourceExcerpt: "Alice will ship the Slack capture by Friday.",
      },
      {
        title: "Discuss roadmap",
        owner: { name: "Bob" },
        hasOwnerVerbObject: false,
        sourceExcerpt: undefined,
      },
    ]);
  });

  it("returns no candidates when Gemini returns a non-array tasks field", async () => {
    const candidates = await extractLlmTaskCandidates({
      content: "No action items.",
      generator: fakeGenerator(async <T>() => ({ tasks: null }) as T),
    });

    expect(candidates).toEqual([]);
  });

  it("adds prior title reuse rules only when prior titles are present", async () => {
    const prompts: string[] = [];
    const generator = fakeGenerator(async <T>(prompt: string) => {
      prompts.push(prompt);
      return { tasks: [] } as T;
    });

    await extractLlmTaskCandidates({
      content: "Alice will ship the Slack capture by Friday.",
      generator,
    });
    await extractLlmTaskCandidates({
      content: "Alice will ship the Slack capture by Friday.",
      priorTitles: ["Ship Slack capture"],
      generator,
    });

    expect(prompts[0]).not.toContain("Previously extracted action-items from this source");
    expect(prompts[1]).toContain("Previously extracted action-items from this source:\n- Ship Slack capture");
    expect(prompts[1]).toContain("REUSE ITS EXACT TITLE verbatim — do not rephrase");
  });
});

function fakeGenerator(generateJSON: GeminiGenerator["generateJSON"]): GeminiGenerator {
  return {
    async generate() {
      return "{}";
    },
    generateJSON,
  };
}
