import { canonicalAgentToolName, isKnownAgentToolName, parseAllowedTools } from "@sketch/shared";
import { describe, expect, it } from "vitest";

describe("agent tool name canonicalization", () => {
  it("maps the retired SendMessageToUser name to SendMessage", () => {
    expect(canonicalAgentToolName("mcp__sketch__SendMessageToUser")).toBe("mcp__sketch__SendMessage");
  });

  it("leaves current and unknown names untouched", () => {
    expect(canonicalAgentToolName("mcp__sketch__SendMessage")).toBe("mcp__sketch__SendMessage");
    expect(canonicalAgentToolName("mcp__sketch__DoesNotExist")).toBe("mcp__sketch__DoesNotExist");
  });

  it("recognizes both the old and the new name as known tools", () => {
    expect(isKnownAgentToolName("mcp__sketch__SendMessageToUser")).toBe(true);
    expect(isKnownAgentToolName("mcp__sketch__SendMessage")).toBe(true);
    expect(isKnownAgentToolName("mcp__sketch__DoesNotExist")).toBe(false);
  });

  it("lets admins grant the delivery target lookup that channel sends depend on", () => {
    expect(isKnownAgentToolName("mcp__sketch__SearchDeliveryTargets")).toBe(true);
  });

  it("recognizes the separate shared-destination send tool", () => {
    expect(isKnownAgentToolName("mcp__sketch__SendMessageToTarget")).toBe(true);
  });

  it("canonicalizes and dedupes stored allowlists on read", () => {
    const stored = JSON.stringify([
      "mcp__sketch__SendMessageToUser",
      "mcp__sketch__SendMessage",
      "mcp__sketch__SearchUsers",
    ]);

    expect(parseAllowedTools(stored)).toEqual(["mcp__sketch__SendMessage", "mcp__sketch__SearchUsers"]);
  });

  it("still returns null for malformed allowlist values", () => {
    expect(parseAllowedTools("not json")).toBeNull();
    expect(parseAllowedTools(JSON.stringify({ nope: true }))).toBeNull();
    expect(parseAllowedTools(null)).toBeNull();
  });
});
