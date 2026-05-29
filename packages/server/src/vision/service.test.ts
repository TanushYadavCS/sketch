import { describe, expect, it } from "vitest";
import { resolveVisionConfig, resolveVisionConfigFromAppConfig, validateWorkspaceVisualPath } from "./service";

describe("resolveVisionConfig", () => {
  it("returns config only when vision is enabled with model and key", () => {
    const result = resolveVisionConfig({
      VISION_ENABLED: "true",
      VISION_MODEL: "xiaomi/mimo-v2.5",
      OPENROUTER_API_KEY: "sk-or-vision",
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({ apiKey: "sk-or-vision", model: "xiaomi/mimo-v2.5", source: "env" });
  });

  it("returns null when vision is disabled", () => {
    expect(
      resolveVisionConfig({
        VISION_ENABLED: "false",
        VISION_MODEL: "xiaomi/mimo-v2.5",
        OPENROUTER_API_KEY: "sk-or-vision",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null when model or key is missing", () => {
    expect(
      resolveVisionConfig({ VISION_ENABLED: "true", OPENROUTER_API_KEY: "sk-or-vision" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      resolveVisionConfig({ VISION_ENABLED: "true", VISION_MODEL: "xiaomi/mimo-v2.5" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("does not use legacy vision-specific API key settings", () => {
    expect(
      resolveVisionConfig({
        VISION_ENABLED: "true",
        VISION_PROVIDER: "xiaomi/mimo-v2.5",
        VISION_API_KEY: "sk-or-vision",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("resolves app config from VISION_MODEL and OPENROUTER_API_KEY", () => {
    const result = resolveVisionConfigFromAppConfig({
      VISION_ENABLED: true,
      VISION_MODEL: "xiaomi/mimo-v2.5",
      OPENROUTER_API_KEY: "sk-or-vision",
    });

    expect(result).toEqual({ apiKey: "sk-or-vision", model: "xiaomi/mimo-v2.5", source: "env" });
  });
});

describe("validateWorkspaceVisualPath", () => {
  it("rejects paths outside the workspace", () => {
    expect(validateWorkspaceVisualPath("/tmp/other/image.png", "/tmp/workspace")).toContain("must be within");
  });

  it("rejects sibling paths with the same prefix", () => {
    expect(validateWorkspaceVisualPath("/tmp/workspace-evil/image.png", "/tmp/workspace")).toContain("must be within");
  });

  it("accepts generic paths inside the workspace so file bytes can determine support", () => {
    expect(validateWorkspaceVisualPath("/tmp/workspace/image.bin", "/tmp/workspace")).toBeNull();
    expect(validateWorkspaceVisualPath("/tmp/workspace/12345_file", "/tmp/workspace")).toBeNull();
  });

  it("accepts supported image extensions inside the workspace", () => {
    expect(validateWorkspaceVisualPath("/tmp/workspace/screenshot.png", "/tmp/workspace")).toBeNull();
  });
});
