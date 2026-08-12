import { describe, expect, it } from "vitest";
import {
  type WhatsAppBoundarySegment,
  enforceWhatsAppBoundarySize,
  validateWhatsAppBoundarySegments,
} from "./whatsapp-llm-chunker";

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    providerMessageId: `m-${index + 1}`,
    effectiveAt: `2026-07-07T09:0${index}:00.000Z`,
    text: "four words",
    attachments: null,
    isBot: false,
    senderName: "Asha",
    effectiveMs: Date.parse(`2026-07-07T09:0${index}:00.000Z`),
    rawIndex: index,
  }));
}

describe("WhatsApp LLM boundary validation and size enforcement", () => {
  it("rejects a response with a coverage gap", () => {
    expect(() =>
      validateWhatsAppBoundarySegments(
        JSON.stringify({
          segments: [
            { start: 1, end: 1, threads: ["one"] },
            { start: 3, end: 3, threads: ["two"] },
          ],
        }),
        3,
      ),
    ).toThrow("gap or overlap");
  });

  it("force-splits an oversized segment while preserving its shared thread", () => {
    const input: WhatsAppBoundarySegment[] = [{ start: 1, end: 5, threads: ["same thread"] }];

    expect(
      enforceWhatsAppBoundarySize(input, messages(5), {
        minMessages: 2,
        targetMessages: 4,
        maxMessages: 2,
        maxTokens: 1500,
      }),
    ).toEqual([
      { start: 1, end: 2, threads: ["same thread"] },
      { start: 3, end: 4, threads: ["same thread"] },
      { start: 5, end: 5, threads: ["same thread"] },
    ]);
  });

  it("defers a below-floor break adjacent to the open tail", () => {
    expect(
      enforceWhatsAppBoundarySize(
        [
          { start: 1, end: 3, threads: ["one"] },
          { start: 4, end: 5, threads: ["two"] },
        ],
        messages(5),
        { minMessages: 4, targetMessages: 40, maxMessages: 80, maxTokens: 1500 },
      ),
    ).toEqual([{ start: 1, end: 5, threads: ["one", "two"] }]);
  });

  it("consolidates adjacent segments that share a thread", () => {
    expect(
      enforceWhatsAppBoundarySize(
        [
          { start: 1, end: 2, threads: ["same"] },
          { start: 3, end: 4, threads: ["same"] },
        ],
        messages(4),
        { minMessages: 1, targetMessages: 4, maxMessages: 80, maxTokens: 1500 },
      ),
    ).toEqual([{ start: 1, end: 4, threads: ["same"] }]);
  });
});
