import JSZip from "jszip";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractTextFromBinary } from "./extractors";
import { runBinaryParse } from "./extractors-pool";

/**
 * These tests exercise the real worker-thread parse path (a live subprocess), so they
 * carry the `.integration` suffix per the repo's test-tier rules.
 */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const logger = {
  warn: () => {},
  debug: () => {},
} as unknown as Logger;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function makeXlsx(rows: (string | number)[][], sheetName = "Results"): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return toArrayBuffer(Buffer.from(buf));
}

async function makePptx(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>Quarterly Roadmap</a:t><a:t>Ship it</a:t></p:sld>");
  zip.file("ppt/notesSlides/notesSlide1.xml", "<p:notes><a:t>Speaker note here</a:t></p:notes>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return toArrayBuffer(buf);
}

describe("extractTextFromBinary (worker path)", () => {
  it("extracts XLSX sheets as CSV in a worker thread", async () => {
    const buffer = makeXlsx([
      ["Name", "Score"],
      ["Ada", 42],
      ["Grace", 99],
    ]);

    const text = await extractTextFromBinary(buffer, XLSX_MIME, logger);

    expect(text).toBe("## Results\nName,Score\nAda,42\nGrace,99");
  });

  it("extracts PPTX slide text and notes in a worker thread", async () => {
    const text = await extractTextFromBinary(await makePptx(), PPTX_MIME, logger);

    expect(text).toBe("## Slide 1\nQuarterly Roadmap Ship it\nNotes: Speaker note here");
  });

  it("returns null for unsupported MIME types without spawning a worker", async () => {
    const text = await extractTextFromBinary(toArrayBuffer(Buffer.from("hello")), "text/plain", logger);

    expect(text).toBeNull();
  });

  it("returns null (never throws) when the worker parse fails", async () => {
    const garbage = toArrayBuffer(Buffer.from("this is definitely not a zip archive"));

    const text = await extractTextFromBinary(garbage, PPTX_MIME, logger);

    expect(text).toBeNull();
  });

  it("caps the returned text inside the worker so large strings never cross back", async () => {
    const buffer = makeXlsx([
      ["Name", "Score"],
      ["Ada", 42],
      ["Grace", 99],
    ]);

    const capped = await runBinaryParse("xlsx", buffer, 12);

    expect(capped).toHaveLength(12);
    expect(capped).toBe("## Results\nN");
  });

  it("handles a burst of concurrent parses under the 2-worker cap", async () => {
    const buffers = Array.from({ length: 4 }, () =>
      makeXlsx([
        ["Name", "Score"],
        ["Ada", 42],
      ]),
    );

    const results = await Promise.all(buffers.map((b) => extractTextFromBinary(b, XLSX_MIME, logger)));

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result).toContain("Ada,42");
    }
  });
});
