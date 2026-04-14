import { describe, expect, it } from "vitest";
import { getNewSessionConfirmation, NEW_SESSION_CONFIRMATIONS, parseSketchCommand } from "./commands";

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
