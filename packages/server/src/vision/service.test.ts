import { describe, expect, it } from "vitest";
import { resolveVisionConfig, validateWorkspaceImagePath } from "./service";

describe("resolveVisionConfig", () => {
  it("returns config only when vision is enabled with model and key", () => {
    const result = resolveVisionConfig({
      VISION_ENABLED: "true",
      VISION_PROVIDER: "xiaomi/mimo-v2.5",
      VISION_API_KEY: "sk-or-vision",
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({ apiKey: "sk-or-vision", model: "xiaomi/mimo-v2.5", source: "env" });
  });

  it("returns null when vision is disabled", () => {
    expect(
      resolveVisionConfig({
        VISION_ENABLED: "false",
        VISION_PROVIDER: "xiaomi/mimo-v2.5",
        VISION_API_KEY: "sk-or-vision",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null when model or key is missing", () => {
    expect(
      resolveVisionConfig({ VISION_ENABLED: "true", VISION_API_KEY: "sk-or-vision" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      resolveVisionConfig({ VISION_ENABLED: "true", VISION_PROVIDER: "xiaomi/mimo-v2.5" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("validateWorkspaceImagePath", () => {
  it("rejects paths outside the workspace", () => {
    expect(validateWorkspaceImagePath("/tmp/other/image.png", "/tmp/workspace")).toContain("must be within");
  });

  it("rejects sibling paths with the same prefix", () => {
    expect(validateWorkspaceImagePath("/tmp/workspace-evil/image.png", "/tmp/workspace")).toContain("must be within");
  });

  it("rejects unsupported extensions", () => {
    expect(validateWorkspaceImagePath("/tmp/workspace/file.txt", "/tmp/workspace")).toContain("supported image");
  });

  it("accepts supported image extensions inside the workspace", () => {
    expect(validateWorkspaceImagePath("/tmp/workspace/screenshot.png", "/tmp/workspace")).toBeNull();
  });
});
