import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImageWithOpenRouter } from "./openrouter";

describe("analyzeImageWithOpenRouter", () => {
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

  it("sends an OpenRouter chat completion request with the configured vision model", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "The image shows a dashboard." } }],
        usage: { total_tokens: 42 },
      }),
    });
    const imagePath = join(tmpDir, "dashboard.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await analyzeImageWithOpenRouter(imagePath, "What is shown?", {
      apiKey: "sk-or-vision",
      model: "xiaomi/mimo-v2.5",
    });

    expect(result.text).toBe("The image shows a dashboard.");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-or-vision");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("xiaomi/mimo-v2.5");
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "What is shown?" });
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});
