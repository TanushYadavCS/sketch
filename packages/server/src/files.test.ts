import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMultimodalContent,
  downloadSlackFile,
  formatAttachmentsForPrompt,
  isAudioAttachment,
  isImageAttachment,
  mimeToExtension,
  selectImagesWithinBudget,
  splitAttachments,
} from "./files";
import type { Attachment } from "./files";

describe("downloadSlackFile", () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), "sketch-test-"));
  });

  afterEach(async () => {
    await rm(destDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("downloads a file and saves it to destDir", async () => {
    const content = Buffer.from("hello world");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(content, {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": String(content.length) },
      }),
    );

    const result = await downloadSlackFile(
      "https://files.slack.com/files-pri/T001/report.txt",
      "xoxb-test-token",
      destDir,
      20 * 1024 * 1024,
    );

    expect(result.originalName).toBe("report.txt");
    expect(result.mimeType).toBe("text/plain");
    expect(result.sizeBytes).toBe(11);
    const saved = await readFile(result.localPath);
    expect(saved.toString()).toBe("hello world");
  });

  it("sends Authorization header to slack.com hosts", async () => {
    const content = Buffer.from("data");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(content, { status: 200 }));

    await downloadSlackFile("https://files.slack.com/file.txt", "xoxb-token", destDir, 20 * 1024 * 1024);

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-token");
  });

  it("strips auth header when redirected to non-Slack CDN", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/file.txt" },
        }),
      )
      .mockResolvedValueOnce(new Response(Buffer.from("data"), { status: 200 }));

    await downloadSlackFile("https://files.slack.com/file.txt", "xoxb-token", destDir, 20 * 1024 * 1024);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchSpy.mock.calls[1];
    const headers = secondInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects files exceeding the size limit via content-length", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(Buffer.from("x"), {
        status: 200,
        headers: { "content-length": String(100 * 1024 * 1024) },
      }),
    );

    await expect(downloadSlackFile("https://files.slack.com/big.bin", "xoxb-token", destDir, 1024)).rejects.toThrow(
      "File too large",
    );
  });

  it("rejects files exceeding the size limit via actual buffer size", async () => {
    const bigContent = Buffer.alloc(2048, "x");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(bigContent, { status: 200 }));

    await expect(downloadSlackFile("https://files.slack.com/big.bin", "xoxb-token", destDir, 1024)).rejects.toThrow(
      "File too large",
    );
  });

  it("sanitizes special characters in filenames", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(Buffer.from("data"), { status: 200 }));

    const result = await downloadSlackFile(
      "https://files.slack.com/files-pri/T001/my file (1).txt",
      "xoxb-token",
      destDir,
      20 * 1024 * 1024,
    );

    expect(result.localPath).not.toContain(" ");
    expect(result.localPath).not.toContain("(");
    expect(result.localPath).not.toContain(")");
  });

  it("throws on failed HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(
      downloadSlackFile("https://files.slack.com/file.txt", "xoxb-token", destDir, 20 * 1024 * 1024),
    ).rejects.toThrow("Download failed: HTTP 403");
  });
});

describe("formatAttachmentsForPrompt", () => {
  it("returns empty string for no attachments", () => {
    expect(formatAttachmentsForPrompt([])).toBe("");
  });

  it("formats a single attachment as XML block", () => {
    const attachments: Attachment[] = [
      {
        originalName: "report.pdf",
        localPath: "/data/workspaces/u1/attachments/123_report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    ];

    const result = formatAttachmentsForPrompt(attachments);
    expect(result).toContain("<attachments>");
    expect(result).toContain('name="report.pdf"');
    expect(result).toContain('path="/data/workspaces/u1/attachments/123_report.pdf"');
    expect(result).toContain('mime="application/pdf"');
    expect(result).toContain('size="1024"');
    expect(result).toContain("</attachments>");
  });

  it("formats multiple attachments", () => {
    const attachments: Attachment[] = [
      { originalName: "a.txt", localPath: "/w/a.txt", mimeType: "text/plain", sizeBytes: 10 },
      { originalName: "b.png", localPath: "/w/b.png", mimeType: "image/png", sizeBytes: 2048 },
    ];

    const result = formatAttachmentsForPrompt(attachments);
    expect(result).toContain('name="a.txt"');
    expect(result).toContain('name="b.png"');
  });

  it("adds a visual analysis hint to image attachments when vision analysis is enabled", () => {
    const result = formatAttachmentsForPrompt(
      [
        { originalName: "a.txt", localPath: "/w/a.txt", mimeType: "text/plain", sizeBytes: 10 },
        { originalName: "b.png", localPath: "/w/b.png", mimeType: "image/png", sizeBytes: 2048 },
      ],
      { visionAnalysisEnabled: true },
    );

    expect(result).toContain(
      '<file name="b.png" path="/w/b.png" mime="image/png" size="2048" hint="Use mcp__sketch__VisualAnalysis with this path to understand the image." />',
    );
    expect(result).toContain('<file name="a.txt" path="/w/a.txt" mime="text/plain" size="10" />');
  });

  it("does not add visual analysis hints when vision analysis is disabled", () => {
    const result = formatAttachmentsForPrompt(
      [{ originalName: "b.png", localPath: "/w/b.png", mimeType: "image/png", sizeBytes: 2048 }],
      { visionAnalysisEnabled: false },
    );

    expect(result).not.toContain("mcp__sketch__VisualAnalysis");
    expect(result).toContain('<file name="b.png" path="/w/b.png" mime="image/png" size="2048" />');
  });

  it("annotates oversized inline images with a Read-it note", () => {
    const result = formatAttachmentsForPrompt(
      [{ originalName: "big.png", localPath: "/w/big.png", mimeType: "image/png", sizeBytes: 999 }],
      { oversizedInlineImagePaths: new Set(["/w/big.png"]) },
    );

    expect(result).toContain('name="big.png"');
    expect(result).toContain("too large to view inline");
    expect(result).toContain("use the Read tool");
  });

  it("formats inline audio transcription blocks", () => {
    const result = formatAttachmentsForPrompt([
      {
        originalName: "voice.ogg",
        localPath: "/w/voice.ogg",
        mimeType: "audio/ogg",
        sizeBytes: 10,
        transcription: { status: "completed", text: "hello world" },
      },
    ]);

    expect(result).toContain("<audio_transcription>");
    expect(result).toContain("Transcript:");
    expect(result).toContain("hello world");
  });

  it("formats long audio transcription instructions without preview text", () => {
    const result = formatAttachmentsForPrompt([
      {
        originalName: "voice.ogg",
        localPath: "/w/voice.ogg",
        mimeType: "audio/ogg",
        sizeBytes: 10,
        transcription: { status: "completed", transcriptPath: "/w/voice.ogg.transcript.txt" },
      },
    ]);

    expect(result).toContain("too long to inline");
    expect(result).not.toContain("Transcript:");
  });
});

describe("isImageAttachment", () => {
  it("returns true for jpeg, png, gif, webp", () => {
    for (const mime of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(isImageAttachment({ originalName: "f", localPath: "/f", mimeType: mime, sizeBytes: 1 })).toBe(true);
    }
  });

  it("returns false for non-image types", () => {
    for (const mime of ["application/pdf", "text/csv", "text/plain", "application/octet-stream"]) {
      expect(isImageAttachment({ originalName: "f", localPath: "/f", mimeType: mime, sizeBytes: 1 })).toBe(false);
    }
  });
});

describe("isAudioAttachment", () => {
  it("returns true for explicit audio MIME types", () => {
    expect(
      isAudioAttachment({ originalName: "voice.bin", localPath: "/w/voice.bin", mimeType: "audio/ogg", sizeBytes: 1 }),
    ).toBe(true);
    expect(
      isAudioAttachment({
        originalName: "voice.bin",
        localPath: "/w/voice.bin",
        mimeType: "audio/ogg; codecs=opus",
        sizeBytes: 1,
      }),
    ).toBe(true);
  });

  it("uses extension fallback only for generic MIME types", () => {
    expect(
      isAudioAttachment({
        originalName: "voice.mp3",
        localPath: "/w/voice.mp3",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      }),
    ).toBe(true);
    expect(
      isAudioAttachment({ originalName: "voice.mp3", localPath: "/w/voice.mp3", mimeType: "", sizeBytes: 1 }),
    ).toBe(true);
  });

  it("does not treat explicit non-audio MIME types as audio by extension", () => {
    expect(
      isAudioAttachment({ originalName: "clip.mp4", localPath: "/w/clip.mp4", mimeType: "video/mp4", sizeBytes: 1 }),
    ).toBe(false);
  });
});

describe("splitAttachments", () => {
  it("separates images from non-images", () => {
    const attachments: Attachment[] = [
      { originalName: "photo.png", localPath: "/w/photo.png", mimeType: "image/png", sizeBytes: 100 },
      { originalName: "doc.pdf", localPath: "/w/doc.pdf", mimeType: "application/pdf", sizeBytes: 200 },
      { originalName: "pic.jpg", localPath: "/w/pic.jpg", mimeType: "image/jpeg", sizeBytes: 300 },
    ];
    const { images, nonImages } = splitAttachments(attachments);
    expect(images).toHaveLength(2);
    expect(nonImages).toHaveLength(1);
    expect(images[0].originalName).toBe("photo.png");
    expect(images[1].originalName).toBe("pic.jpg");
    expect(nonImages[0].originalName).toBe("doc.pdf");
  });

  it("handles empty array", () => {
    const { images, nonImages } = splitAttachments([]);
    expect(images).toHaveLength(0);
    expect(nonImages).toHaveLength(0);
  });

  it("handles all-images", () => {
    const attachments: Attachment[] = [
      { originalName: "a.png", localPath: "/a", mimeType: "image/png", sizeBytes: 1 },
      { originalName: "b.gif", localPath: "/b", mimeType: "image/gif", sizeBytes: 2 },
    ];
    const { images, nonImages } = splitAttachments(attachments);
    expect(images).toHaveLength(2);
    expect(nonImages).toHaveLength(0);
  });

  it("handles all-non-images", () => {
    const attachments: Attachment[] = [
      { originalName: "a.txt", localPath: "/a", mimeType: "text/plain", sizeBytes: 1 },
      { originalName: "b.csv", localPath: "/b", mimeType: "text/csv", sizeBytes: 2 },
    ];
    const { images, nonImages } = splitAttachments(attachments);
    expect(images).toHaveLength(0);
    expect(nonImages).toHaveLength(2);
  });
});

describe("buildMultimodalContent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sketch-multimodal-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns single text block when no attachments", async () => {
    const blocks = await buildMultimodalContent("hello", []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as { type: "text"; text: string }).text).toBe("hello");
  });

  it("returns text block + image block for one image", async () => {
    const imgPath = join(tmpDir, "test.png");
    await writeFile(imgPath, Buffer.from("fake-png-data"));

    const blocks = await buildMultimodalContent("describe this", [
      { originalName: "test.png", localPath: imgPath, mimeType: "image/png", sizeBytes: 13 },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as { type: "text"; text: string }).text).toBe("describe this");
    expect(blocks[1].type).toBe("image");
    const imgBlock = blocks[1] as { type: "image"; source: { type: "base64"; media_type: string; data: string } };
    expect(imgBlock.source.media_type).toBe("image/png");
    expect(imgBlock.source.data).toBe(Buffer.from("fake-png-data").toString("base64"));
  });

  it("returns multiple image blocks for multiple images", async () => {
    const img1 = join(tmpDir, "a.jpg");
    const img2 = join(tmpDir, "b.webp");
    await writeFile(img1, Buffer.from("jpg-data"));
    await writeFile(img2, Buffer.from("webp-data"));

    const blocks = await buildMultimodalContent("images", [
      { originalName: "a.jpg", localPath: img1, mimeType: "image/jpeg", sizeBytes: 8 },
      { originalName: "b.webp", localPath: img2, mimeType: "image/webp", sizeBytes: 9 },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("image");
    expect(blocks[2].type).toBe("image");
  });

  it("handles mixed images and non-images correctly", async () => {
    const imgPath = join(tmpDir, "photo.png");
    await writeFile(imgPath, Buffer.from("img"));

    const blocks = await buildMultimodalContent("mixed files", [
      { originalName: "photo.png", localPath: imgPath, mimeType: "image/png", sizeBytes: 3 },
      { originalName: "data.csv", localPath: "/w/data.csv", mimeType: "text/csv", sizeBytes: 100 },
    ]);

    expect(blocks).toHaveLength(2);
    const textBlock = blocks[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("mixed files");
    expect(textBlock.text).toContain("<attachments>");
    expect(textBlock.text).toContain('name="data.csv"');
    expect(textBlock.text).not.toContain("photo.png");
    expect(blocks[1].type).toBe("image");
  });

  it("embeds every image when the total is within the aggregate budget", async () => {
    const img1 = join(tmpDir, "a.png");
    const img2 = join(tmpDir, "b.png");
    await writeFile(img1, Buffer.from("aaaa"));
    await writeFile(img2, Buffer.from("bbbb"));

    const blocks = await buildMultimodalContent(
      "two images",
      [
        { originalName: "a.png", localPath: img1, mimeType: "image/png", sizeBytes: 4 },
        { originalName: "b.png", localPath: img2, mimeType: "image/png", sizeBytes: 4 },
      ],
      100,
    );

    expect(blocks).toHaveLength(3);
    expect(blocks[1].type).toBe("image");
    expect(blocks[2].type).toBe("image");
    const textBlock = blocks[0] as { type: "text"; text: string };
    expect(textBlock.text).not.toContain("too large to view inline");
  });

  it("skips images past the aggregate budget and notes them in the text block", async () => {
    const img1 = join(tmpDir, "first.png");
    const img2 = join(tmpDir, "second.png");
    await writeFile(img1, Buffer.from("first-data"));
    await writeFile(img2, Buffer.from("second-data"));

    const blocks = await buildMultimodalContent(
      "budget test",
      [
        { originalName: "first.png", localPath: img1, mimeType: "image/png", sizeBytes: 8 },
        { originalName: "second.png", localPath: img2, mimeType: "image/png", sizeBytes: 8 },
      ],
      10,
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("image");
    const imgBlock = blocks[1] as { type: "image"; source: { data: string } };
    expect(imgBlock.source.data).toBe(Buffer.from("first-data").toString("base64"));

    const textBlock = blocks[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain('name="second.png"');
    expect(textBlock.text).toContain("too large to view inline");
    expect(textBlock.text).not.toContain('name="first.png"');
  });

  it("embeds a single image within the default budget as before", async () => {
    const imgPath = join(tmpDir, "solo.png");
    await writeFile(imgPath, Buffer.from("solo-image-data"));

    const blocks = await buildMultimodalContent("one image", [
      { originalName: "solo.png", localPath: imgPath, mimeType: "image/png", sizeBytes: 15 },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("image");
    const textBlock = blocks[0] as { type: "text"; text: string };
    expect(textBlock.text).toBe("one image");
  });

  it("skips a lone image that alone exceeds the budget and lists it with the note", async () => {
    const imgPath = join(tmpDir, "huge.png");
    await writeFile(imgPath, Buffer.from("huge-data"));

    const blocks = await buildMultimodalContent(
      "too big",
      [{ originalName: "huge.png", localPath: imgPath, mimeType: "image/png", sizeBytes: 100 }],
      10,
    );

    expect(blocks).toHaveLength(1);
    const textBlock = blocks[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain('name="huge.png"');
    expect(textBlock.text).toContain("too large to view inline");
  });
});

describe("selectImagesWithinBudget", () => {
  const img = (name: string, sizeBytes: number): Attachment => ({
    originalName: name,
    localPath: `/w/${name}`,
    mimeType: "image/png",
    sizeBytes,
  });

  it("embeds all images when they fit the budget", () => {
    const { embed, skipped } = selectImagesWithinBudget([img("a", 10), img("b", 10)], 30);
    expect(embed.map((a) => a.originalName)).toEqual(["a", "b"]);
    expect(skipped).toHaveLength(0);
  });

  it("preserves input order and skips only the excess", () => {
    const { embed, skipped } = selectImagesWithinBudget([img("a", 10), img("b", 10), img("c", 10)], 20);
    expect(embed.map((a) => a.originalName)).toEqual(["a", "b"]);
    expect(skipped.map((a) => a.originalName)).toEqual(["c"]);
  });

  it("skips a leading image too large to fit but keeps a later one that fits", () => {
    const { embed, skipped } = selectImagesWithinBudget([img("big", 50), img("small", 5)], 10);
    expect(embed.map((a) => a.originalName)).toEqual(["small"]);
    expect(skipped.map((a) => a.originalName)).toEqual(["big"]);
  });
});

describe("mimeToExtension", () => {
  it("returns correct extensions for common image types", () => {
    expect(mimeToExtension("image/jpeg")).toBe("jpg");
    expect(mimeToExtension("image/png")).toBe("png");
    expect(mimeToExtension("image/webp")).toBe("webp");
    expect(mimeToExtension("image/gif")).toBe("gif");
  });

  it("returns correct extensions for audio/video types", () => {
    expect(mimeToExtension("video/mp4")).toBe("mp4");
    expect(mimeToExtension("audio/ogg; codecs=opus")).toBe("ogg");
    expect(mimeToExtension("audio/mp4")).toBe("m4a");
    expect(mimeToExtension("audio/mpeg")).toBe("mp3");
  });

  it("returns correct extension for PDF", () => {
    expect(mimeToExtension("application/pdf")).toBe("pdf");
  });

  it("returns 'bin' for unknown types", () => {
    expect(mimeToExtension("application/x-custom")).toBe("bin");
    expect(mimeToExtension("text/csv")).toBe("bin");
  });

  it("returns 'bin' for null/undefined", () => {
    expect(mimeToExtension(null)).toBe("bin");
    expect(mimeToExtension(undefined)).toBe("bin");
  });
});
