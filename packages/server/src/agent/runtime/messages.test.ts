import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRuntimeUserContent } from "./messages";

describe("agent runtime message builders", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-runtime-messages-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds AI SDK image parts for multimodal user input", async () => {
    const imagePath = join(root, "diagram.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await mkdir(join(root, "docs"));
    const textPath = join(root, "docs", "notes.txt");
    await writeFile(textPath, "notes");

    const content = await buildAgentRuntimeUserContent("summarize this", [
      { originalName: "diagram.png", mimeType: "image/png", localPath: imagePath, sizeBytes: 4 },
      { originalName: "notes.txt", mimeType: "text/plain", localPath: textPath, sizeBytes: 5 },
    ]);

    expect(content).toEqual([
      {
        type: "text",
        text: expect.stringContaining(`<file name="notes.txt" path="${textPath}" mime="text/plain" size="5" />`),
      },
      { type: "image", image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mediaType: "image/png" },
    ]);
  });

  it("skips images past the aggregate budget and lists them with a note", async () => {
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    await writeFile(first, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(second, Buffer.from([0x89, 0x50, 0x4e, 0x48]));

    const content = await buildAgentRuntimeUserContent(
      "two images",
      [
        { originalName: "first.png", mimeType: "image/png", localPath: first, sizeBytes: 8 },
        { originalName: "second.png", mimeType: "image/png", localPath: second, sizeBytes: 8 },
      ],
      10,
    );

    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string }>;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
    const textPart = parts.find((p) => p.type === "text");
    expect(textPart?.text).toContain('name="second.png"');
    expect(textPart?.text).toContain("too large to view inline");
  });
});
