import { describe, expect, it } from "vitest";
import {
  NEW_SESSION_CONFIRMATIONS,
  getNewSessionConfirmation,
  getReasoningTextConfirmation,
  getReasoningTextCurrent,
  getToolProgressConfirmation,
  getToolProgressCurrent,
  getToolProgressSuggestion,
  parseSketchCommand,
} from "./commands";

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
    expect(parseSketchCommand("/toolprogress concise")).toBe("tool_progress_concise");
    expect(parseSketchCommand("/toolprogress technical")).toBe("tool_progress_technical");
    expect(parseSketchCommand("/toolprogress verbose")).toBe("tool_progress_verbose");
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
    expect(getToolProgressConfirmation("verbose", false)).toBe("🔍 Tool progress set to verbose.");
  });

  it("mentions live reasoning when turning tool progress off", () => {
    expect(getToolProgressConfirmation("off", true)).toBe(
      "🛑 Tool progress turned off. 🧠 Reasoning text is still on, so you may still see live updates.",
    );
  });

  it("formats the current settings message", () => {
    expect(getToolProgressCurrent({ toolProgress: "friendly", reasoningText: false })).toBe(
      "🛠️ Tool progress: friendly. 🧠 Reasoning text: off.\nUse /toolprogress off|friendly|concise|technical|verbose",
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
    expect(getReasoningTextCurrent({ toolProgress: "concise", reasoningText: true })).toBe(
      "🧠 Reasoning text: on. 🛠️ Tool progress: concise.\nUse /reasoningtext on|off",
    );
  });
});
