import { describe, expect, it } from "vitest";
import {
  NEW_SESSION_CONFIRMATIONS,
  getNewSessionConfirmation,
  getOutputStyleConfirmation,
  getOutputStyleCurrent,
  getOutputStyleSuggestion,
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

  it("detects /outputstyle with long forms", () => {
    expect(parseSketchCommand("/outputstyle friendly")).toBe("output_style_friendly");
    expect(parseSketchCommand("/outputstyle concise")).toBe("output_style_concise");
    expect(parseSketchCommand("/outputstyle technical")).toBe("output_style_technical");
    expect(parseSketchCommand("/outputstyle verbose")).toBe("output_style_verbose");
  });

  it("detects /outputstyle with short forms", () => {
    expect(parseSketchCommand("/outputstyle f")).toBe("output_style_friendly");
    expect(parseSketchCommand("/outputstyle c")).toBe("output_style_concise");
    expect(parseSketchCommand("/outputstyle t")).toBe("output_style_technical");
    expect(parseSketchCommand("/outputstyle v")).toBe("output_style_verbose");
  });

  it("treats /outputstyle without args as query", () => {
    expect(parseSketchCommand("/outputstyle")).toBe("output_style_query");
    expect(parseSketchCommand(" /outputstyle  ")).toBe("output_style_query");
  });

  it("returns null for unknown /outputstyle values", () => {
    expect(parseSketchCommand("/outputstyle friendy")).toBeNull();
    expect(parseSketchCommand("/outputstyle xyz")).toBeNull();
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

describe("output style helpers", () => {
  it("formats the set confirmation", () => {
    expect(getOutputStyleConfirmation("verbose")).toBe("Output style set to verbose.");
  });

  it("formats the current style message", () => {
    expect(getOutputStyleCurrent("friendly")).toBe(
      "Current output style: friendly. Available: friendly, concise, technical, verbose.",
    );
  });

  it("suggests the closest output style for typos", () => {
    expect(getOutputStyleSuggestion("friendy")).toBe("friendly");
    expect(getOutputStyleSuggestion("concis")).toBe("concise");
  });

  it("returns null when no reasonable suggestion exists", () => {
    expect(getOutputStyleSuggestion("xyz")).toBeNull();
  });
});
