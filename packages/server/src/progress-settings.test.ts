import { describe, expect, it } from "vitest";
import {
  progressDisplaySettingsForWebChatMode,
  resolveToolProgress,
  resolveWebChatProgressRendererMode,
} from "./progress-settings";

describe("resolveToolProgress", () => {
  it("keeps supported values", () => {
    expect(resolveToolProgress("off")).toBe("off");
    expect(resolveToolProgress("friendly")).toBe("friendly");
    expect(resolveToolProgress("technical")).toBe("technical");
  });

  it("resolves unsupported stored values to the safe default", () => {
    expect(resolveToolProgress("concise")).toBe("friendly");
    expect(resolveToolProgress("verbose")).toBe("friendly");
    expect(resolveToolProgress(null)).toBe("friendly");
  });
});

describe("resolveWebChatProgressRendererMode", () => {
  it("accepts web renderer aliases and falls back to the stored setting", () => {
    expect(resolveWebChatProgressRendererMode("verbose")).toBe("technical");
    expect(resolveWebChatProgressRendererMode("technical")).toBe("technical");
    expect(resolveWebChatProgressRendererMode("off")).toBe("off");
    expect(resolveWebChatProgressRendererMode(undefined, "technical")).toBe("technical");
    expect(resolveWebChatProgressRendererMode("unknown", "friendly")).toBe("friendly");
  });

  it("disables reasoning text for non-technical web chat modes", () => {
    expect(
      progressDisplaySettingsForWebChatMode({ toolProgress: "friendly", reasoningText: true }, "friendly"),
    ).toEqual({
      toolProgress: "friendly",
      reasoningText: false,
    });
    expect(
      progressDisplaySettingsForWebChatMode({ toolProgress: "technical", reasoningText: true }, "technical"),
    ).toEqual({
      toolProgress: "technical",
      reasoningText: true,
    });
  });
});
