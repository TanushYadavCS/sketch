import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../files";
import { formatAttachmentsForPrompt } from "../files";
import { resolveTranscriptionConfig, transcribeEagerAttachments, validateWorkspaceAudioPath } from "./service";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

describe("resolveTranscriptionConfig", () => {
  it("uses openrouter DB key first", () => {
    const result = resolveTranscriptionConfig({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }, {
      OPENROUTER_API_KEY: "sk-env",
    } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ apiKey: "sk-db", source: "db", providerMode: "openrouter" });
  });

  it("uses openrouter DB key", () => {
    const result = resolveTranscriptionConfig(
      { llm_provider: "openrouter", anthropic_api_key: "sk-db" },
      {} as NodeJS.ProcessEnv,
    );

    expect(result).toMatchObject({ apiKey: "sk-db", source: "db", providerMode: "openrouter" });
  });

  it("falls back to OPENROUTER_API_KEY", () => {
    const result = resolveTranscriptionConfig({ llm_provider: "anthropic", anthropic_api_key: "sk-ant" }, {
      OPENROUTER_API_KEY: "sk-env",
    } as NodeJS.ProcessEnv);

    expect(result).toMatchObject({ apiKey: "sk-env", source: "env", providerMode: "env" });
  });

  it("returns null when no OpenRouter key is configured", () => {
    expect(resolveTranscriptionConfig(null, {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("transcribeEagerAttachments", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-transcription-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips transcription when no key is configured", async () => {
    const audioPath = join(tmpDir, "voice.ogg");
    await writeFile(audioPath, "audio");
    const attachment: Attachment = {
      originalName: "voice.ogg",
      mimeType: "audio/ogg",
      localPath: audioPath,
      sizeBytes: 5,
    };

    const result = await transcribeEagerAttachments([attachment], {
      loadSettings: async () => null,
      logger: logger() as never,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual([attachment]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds inline transcript metadata for short transcripts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello from audio", usage: { seconds: 1, cost: 0.001 } }),
    });
    const audioPath = join(tmpDir, "voice.ogg");
    await writeFile(audioPath, "audio");

    const result = await transcribeEagerAttachments(
      [{ originalName: "voice.ogg", mimeType: "audio/ogg", localPath: audioPath, sizeBytes: 5 }],
      {
        loadSettings: async () => ({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }),
        logger: logger() as never,
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].transcription).toEqual({ status: "completed", text: "hello from audio" });
    expect(formatAttachmentsForPrompt(result)).toContain("<audio_transcription>");
    expect(formatAttachmentsForPrompt(result)).toContain("hello from audio");
  });

  it("reports aux cost via onUsage from OpenRouter's own usage.cost", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello", usage: { seconds: 12, cost: 0.004 } }),
    });
    const audioPath = join(tmpDir, "voice.ogg");
    await writeFile(audioPath, "audio");
    const onUsage = vi.fn();

    await transcribeEagerAttachments(
      [{ originalName: "voice.ogg", mimeType: "audio/ogg", localPath: audioPath, sizeBytes: 5 }],
      {
        loadSettings: async () => ({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }),
        logger: logger() as never,
        onUsage,
      },
    );

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ op: "transcription", costUsd: 0.004, seconds: 12, source: "openrouter" }),
    );
  });

  it("flags aux cost source as unknown when OpenRouter omits cost", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hi", usage: { seconds: 3 } }),
    });
    const audioPath = join(tmpDir, "voice.ogg");
    await writeFile(audioPath, "audio");
    const onUsage = vi.fn();

    await transcribeEagerAttachments(
      [{ originalName: "voice.ogg", mimeType: "audio/ogg", localPath: audioPath, sizeBytes: 5 }],
      {
        loadSettings: async () => ({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }),
        logger: logger() as never,
        onUsage,
      },
    );

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ op: "transcription", costUsd: 0, source: "unknown" }),
    );
  });

  it("uses attachment MIME type when transcribing generic file names", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello from audio" }),
    });
    const audioPath = join(tmpDir, "voice.bin");
    await writeFile(audioPath, "audio");

    await transcribeEagerAttachments(
      [{ originalName: "voice.bin", mimeType: "audio/mp4", localPath: audioPath, sizeBytes: 5 }],
      {
        loadSettings: async () => ({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }),
        logger: logger() as never,
      },
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.input_audio.format).toBe("m4a");
  });

  it("does not transcribe video attachments just because the extension is mp4", async () => {
    const videoPath = join(tmpDir, "clip.mp4");
    await writeFile(videoPath, "video");
    const attachment: Attachment = {
      originalName: "clip.mp4",
      mimeType: "video/mp4",
      localPath: videoPath,
      sizeBytes: 5,
    };

    const result = await transcribeEagerAttachments([attachment], {
      loadSettings: async () => ({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }),
      logger: logger() as never,
    });

    expect(result).toEqual([attachment]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes long transcripts as transcript attachments", async () => {
    const longText = "x".repeat(8001);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: longText }),
    });
    const audioPath = join(tmpDir, "voice.ogg");
    await writeFile(audioPath, "audio");

    const result = await transcribeEagerAttachments(
      [{ originalName: "voice.ogg", mimeType: "audio/ogg", localPath: audioPath, sizeBytes: 5 }],
      {
        loadSettings: async () => ({ llm_provider: "openrouter", anthropic_api_key: "sk-db" }),
        logger: logger() as never,
      },
    );

    expect(result).toHaveLength(2);
    expect(result[0].transcription?.transcriptPath).toBe(join(tmpDir, "voice.ogg.transcript.txt"));
    expect(result[1]).toMatchObject({
      originalName: "voice.ogg.transcript.txt",
      mimeType: "text/plain",
      localPath: join(tmpDir, "voice.ogg.transcript.txt"),
    });
    expect(await readFile(join(tmpDir, "voice.ogg.transcript.txt"), "utf8")).toBe(longText);
    const prompt = formatAttachmentsForPrompt(result);
    expect(prompt).toContain('name="voice.ogg.transcript.txt"');
    expect(prompt).not.toContain(longText);
  });
});

describe("validateWorkspaceAudioPath", () => {
  it("rejects paths outside the workspace", () => {
    expect(validateWorkspaceAudioPath("/tmp/other/voice.ogg", "/tmp/workspace")).toContain("must be within");
  });

  it("rejects sibling paths with the same prefix", () => {
    expect(validateWorkspaceAudioPath("/tmp/workspace-evil/voice.ogg", "/tmp/workspace")).toContain("must be within");
  });

  it("rejects unsupported extensions", () => {
    expect(validateWorkspaceAudioPath("/tmp/workspace/file.txt", "/tmp/workspace")).toContain("supported audio");
  });

  it("accepts supported audio extensions inside the workspace", () => {
    expect(validateWorkspaceAudioPath("/tmp/workspace/voice.ogg", "/tmp/workspace")).toBeNull();
  });

  it("accepts generic bin attachments for audio format detection", () => {
    expect(validateWorkspaceAudioPath("/tmp/workspace/voice.bin", "/tmp/workspace")).toBeNull();
  });
});
