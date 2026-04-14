import { describe, expect, it } from "vitest";
import { parseSketchCommand } from "./commands";

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
