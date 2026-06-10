import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeImageFile,
  resolveVisionConfig,
  resolveVisionConfigFromAppConfig,
  validateWorkspaceVisualPath,
} from "./service";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function logger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

describe("resolveVisionConfig", () => {
  it("uses openrouter DB key before OPENROUTER_API_KEY", () => {
    const result = resolveVisionConfig(
      {
        VISION_ENABLED: "true",
        VISION_MODEL: "xiaomi/mimo-v2.5",
        OPENROUTER_API_KEY: "sk-env",
      } as NodeJS.ProcessEnv,
      { llm_provider: "openrouter", anthropic_api_key: "sk-db" },
    );

    expect(result).toEqual({
      apiKey: "sk-db",
      model: "xiaomi/mimo-v2.5",
      source: "db",
      providerMode: "openrouter",
    });
  });

  it("uses openrouter DB key", () => {
    const result = resolveVisionConfig(
      {
        VISION_ENABLED: "true",
        VISION_MODEL: "xiaomi/mimo-v2.5",
      } as NodeJS.ProcessEnv,
      { llm_provider: "openrouter", anthropic_api_key: "sk-db" },
    );

    expect(result).toEqual({
      apiKey: "sk-db",
      model: "xiaomi/mimo-v2.5",
      source: "db",
      providerMode: "openrouter",
    });
  });

  it("returns config only when vision is enabled with model and key", () => {
    const result = resolveVisionConfig({
      VISION_ENABLED: "true",
      VISION_MODEL: "xiaomi/mimo-v2.5",
      OPENROUTER_API_KEY: "sk-or-vision",
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({
      apiKey: "sk-or-vision",
      model: "xiaomi/mimo-v2.5",
      source: "env",
      providerMode: "env",
    });
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

    expect(result).toEqual({
      apiKey: "sk-or-vision",
      model: "xiaomi/mimo-v2.5",
      source: "env",
      providerMode: "env",
    });
  });

  it("resolves app config from DB before OPENROUTER_API_KEY", () => {
    const result = resolveVisionConfigFromAppConfig(
      {
        VISION_ENABLED: true,
        VISION_MODEL: "xiaomi/mimo-v2.5",
        OPENROUTER_API_KEY: "sk-env",
      },
      { llm_provider: "openrouter", anthropic_api_key: "sk-db" },
    );

    expect(result).toEqual({
      apiKey: "sk-db",
      model: "xiaomi/mimo-v2.5",
      source: "db",
      providerMode: "openrouter",
    });
  });
});

describe("analyzeImageFile aux cost", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-vision-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reports vision aux cost via onUsage from OpenRouter usage.cost", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "a cat" } }],
        usage: { prompt_tokens: 80, completion_tokens: 12, cost: 0.002 },
      }),
    });
    const imagePath = join(tmpDir, "img.png");
    await writeFile(imagePath, PNG_HEADER);
    const onUsage = vi.fn();

    const text = await analyzeImageFile(imagePath, "what is this?", {
      config: { apiKey: "sk", model: "xiaomi/mimo-v2.5", source: "db", providerMode: "openrouter" },
      logger: logger() as never,
      onUsage,
    });

    expect(text).toBe("a cat");
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "vision",
        model: "xiaomi/mimo-v2.5",
        costUsd: 0.002,
        inputTokens: 80,
        outputTokens: 12,
        source: "openrouter",
      }),
    );
  });

  it("requests cost reporting from OpenRouter via usage.include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    const imagePath = join(tmpDir, "img.png");
    await writeFile(imagePath, PNG_HEADER);

    await analyzeImageFile(imagePath, "q", {
      config: { apiKey: "sk", model: "m", source: "db", providerMode: "openrouter" },
      logger: logger() as never,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body)).usage).toEqual({ include: true });
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
