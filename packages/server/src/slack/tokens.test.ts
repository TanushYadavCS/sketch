import { describe, expect, it } from "vitest";
import { resolveSlackTokens } from "./tokens";

describe("resolveSlackTokens", () => {
  it("returns null when getTokens returns null", async () => {
    const result = await resolveSlackTokens("socket", async () => null);
    expect(result).toBeNull();
  });

  it("returns null when botToken is missing", async () => {
    const result = await resolveSlackTokens("socket", async () => ({ botToken: null, appToken: "xapp-test" }));
    expect(result).toBeNull();
  });

  it("socket mode returns null when appToken is missing", async () => {
    const result = await resolveSlackTokens("socket", async () => ({ botToken: "xoxb-test", appToken: null }));
    expect(result).toBeNull();
  });

  it("socket mode returns both tokens when present", async () => {
    const result = await resolveSlackTokens("socket", async () => ({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    }));
    expect(result).toEqual({ botToken: "xoxb-test", appToken: "xapp-test" });
  });

  it("http mode returns botToken without appToken", async () => {
    const result = await resolveSlackTokens("http", async () => ({ botToken: "xoxb-test", appToken: null }));
    expect(result).toEqual({ botToken: "xoxb-test" });
  });

  it("http mode returns botToken even when appToken is present", async () => {
    const result = await resolveSlackTokens("http", async () => ({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    }));
    expect(result).toEqual({ botToken: "xoxb-test" });
  });
});
