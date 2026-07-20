import { describe, expect, it } from "vitest";
import {
  NEW_SESSION_CONFIRMATIONS,
  getNewSessionConfirmation,
  getReasoningTextConfirmation,
  getReasoningTextCurrent,
  getToolProgressConfirmation,
  getToolProgressCurrent,
  getToolProgressSuggestion,
  parseFollowupReviewCommand,
  parseSketchCommand,
} from "./commands";

describe("parseFollowupReviewCommand", () => {
  it.each([
    ["Confirm done A1B2", { action: "confirm_done", code: "A1B2" }],
    ["Keep open ZX90", { action: "keep_open", code: "ZX90" }],
    ["Track TASK123", { action: "track", code: "TASK123" }],
    ["Dismiss ABCD5678EFGH", { action: "dismiss", code: "ABCD5678EFGH" }],
  ] as const)("parses %s", (input, expected) => {
    expect(parseFollowupReviewCommand(input)).toEqual(expected);
  });

  it("is case-insensitive and normalizes codes to uppercase", () => {
    expect(parseFollowupReviewCommand("confirm DONE ab12")).toEqual({
      action: "confirm_done",
      code: "AB12",
    });
    expect(parseFollowupReviewCommand("KEEP open z9y8")).toEqual({
      action: "keep_open",
      code: "Z9Y8",
    });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseFollowupReviewCommand(" \t Track a1b2c3 \t ")).toEqual({
      action: "track",
      code: "A1B2C3",
    });
  });

  it("accepts only 4-12 character alphanumeric codes", () => {
    expect(parseFollowupReviewCommand("Track ABC1")).toEqual({ action: "track", code: "ABC1" });
    expect(parseFollowupReviewCommand("Track ABCD5678EFGH")).toEqual({
      action: "track",
      code: "ABCD5678EFGH",
    });

    expect(parseFollowupReviewCommand("Track ABC")).toBeNull();
    expect(parseFollowupReviewCommand("Track ABCD5678EFGHI")).toBeNull();
    expect(parseFollowupReviewCommand("Track AB-12")).toBeNull();
    expect(parseFollowupReviewCommand("Track AB_12")).toBeNull();
  });

  it.each([
    "",
    "Confirm done",
    "Keep open",
    "Track",
    "Dismiss",
    "Confirm ABCD",
    "Done ABCD",
    "Keep ABCD",
    "Open ABCD",
    "Track ABCD please",
    "please Dismiss ABCD",
    "Confirm done ABCD Keep open EFGH",
    "Confirm\ndone ABCD",
  ])("rejects missing, ambiguous, or free text: %j", (input) => {
    expect(parseFollowupReviewCommand(input)).toBeNull();
  });

  it("returns null for nullish input", () => {
    expect(parseFollowupReviewCommand(null)).toBeNull();
    expect(parseFollowupReviewCommand(undefined)).toBeNull();
  });

  it("does not change sketch slash-command parsing", () => {
    expect(parseSketchCommand("Confirm done A1B2")).toBeNull();
    expect(parseSketchCommand("Keep open A1B2")).toBeNull();
    expect(parseSketchCommand("Track A1B2")).toBeNull();
    expect(parseSketchCommand("Dismiss A1B2")).toBeNull();
  });
});

describe("parseSketchCommand", () => {
  it("detects /new exactly", () => {
    expect(parseSketchCommand("/new")).toBe("new_session");
  });

  it("accepts Slack's leading-space workaround", () => {
    expect(parseSketchCommand(" /new")).toBe("new_session");
  });

  it("ignores surrounding whitespace", () => {
    expect(parseSketchCommand("   /new   ")).toBe("new_session");
  });

  it("matches /new followed by whitespace and extra text", () => {
    expect(parseSketchCommand("/new please")).toBe("new_session");
    expect(parseSketchCommand("/new session")).toBe("new_session");
  });

  it("does not match /new without a word boundary", () => {
    expect(parseSketchCommand("/newabc")).toBeNull();
    expect(parseSketchCommand("/new-feature")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(parseSketchCommand("   ")).toBeNull();
    expect(parseSketchCommand(null)).toBeNull();
    expect(parseSketchCommand(undefined)).toBeNull();
  });

  it("detects /toolprogress with all supported values", () => {
    expect(parseSketchCommand("/toolprogress off")).toBe("tool_progress_off");
    expect(parseSketchCommand("/toolprogress friendly")).toBe("tool_progress_friendly");
    expect(parseSketchCommand("/toolprogress technical")).toBe("tool_progress_technical");
  });

  it("treats /toolprogress without args as query", () => {
    expect(parseSketchCommand("/toolprogress")).toBe("tool_progress_query");
    expect(parseSketchCommand(" /toolprogress  ")).toBe("tool_progress_query");
  });

  it("returns null for unknown /toolprogress values", () => {
    expect(parseSketchCommand("/toolprogress friendy")).toBeNull();
    expect(parseSketchCommand("/toolprogress xyz")).toBeNull();
  });

  it("detects /reasoningtext values and synonyms", () => {
    expect(parseSketchCommand("/reasoningtext on")).toBe("reasoning_text_on");
    expect(parseSketchCommand("/reasoningtext off")).toBe("reasoning_text_off");
    expect(parseSketchCommand("/reasoningtext true")).toBe("reasoning_text_on");
    expect(parseSketchCommand("/reasoningtext false")).toBe("reasoning_text_off");
    expect(parseSketchCommand("/reasoningtext yes")).toBe("reasoning_text_on");
    expect(parseSketchCommand("/reasoningtext no")).toBe("reasoning_text_off");
  });

  it("treats /reasoningtext without args as query", () => {
    expect(parseSketchCommand("/reasoningtext")).toBe("reasoning_text_query");
  });

  it("returns null for unknown /reasoningtext values", () => {
    expect(parseSketchCommand("/reasoningtext maybe")).toBeNull();
  });
});

describe("getNewSessionConfirmation", () => {
  it("returns the first message for 0", () => {
    expect(getNewSessionConfirmation(0)).toBe(NEW_SESSION_CONFIRMATIONS[0]);
  });

  it("returns the last message for values near 1", () => {
    expect(getNewSessionConfirmation(0.999999)).toBe(NEW_SESSION_CONFIRMATIONS[NEW_SESSION_CONFIRMATIONS.length - 1]);
  });

  it("always returns one of the configured messages", () => {
    expect(NEW_SESSION_CONFIRMATIONS).toContain(getNewSessionConfirmation(0.4));
  });
});

describe("tool progress helpers", () => {
  it("formats the set confirmation", () => {
    expect(getToolProgressConfirmation("technical", false)).toBe("🛠️ Tool progress set to technical.");
  });

  it("mentions live reasoning when turning tool progress off", () => {
    expect(getToolProgressConfirmation("off", true)).toBe(
      "🛑 Tool progress turned off. 🧠 Reasoning text is still on, so you may still see live updates.",
    );
  });

  it("formats the current settings message", () => {
    expect(getToolProgressCurrent({ toolProgress: "friendly", reasoningText: false })).toBe(
      "🛠️ Tool progress: friendly. 🧠 Reasoning text: off.\nUse /toolprogress off|friendly|technical",
    );
  });

  it("suggests the closest tool progress mode for typos", () => {
    expect(getToolProgressSuggestion("friendy")).toBe("friendly");
    expect(getToolProgressSuggestion("tecnical")).toBe("technical");
  });
});

describe("reasoning text helpers", () => {
  it("formats the set confirmation", () => {
    expect(getReasoningTextConfirmation(true)).toBe("🧠 Reasoning text turned on.");
    expect(getReasoningTextConfirmation(false)).toBe("🔕 Reasoning text turned off.");
  });

  it("formats the current settings message", () => {
    expect(getReasoningTextCurrent({ toolProgress: "friendly", reasoningText: true })).toBe(
      "🧠 Reasoning text: on. 🛠️ Tool progress: friendly.\nUse /reasoningtext on|off",
    );
  });
});
