/**
 * Off-loop worker pool for binary document parsing.
 *
 * XLSX parsing is fully synchronous and PDF/DOCX/PPTX parsing is CPU-heavy; running
 * any of them inline stalls the single shared event loop (HTTP, Slack, agent runs,
 * sync all share it). Each parse therefore runs in a short-lived worker thread.
 *
 * Bundling constraint: the server runs via tsx in dev and as a tsdown ESM bundle in
 * prod. A `new Worker(new URL("./file.ts"))` would resolve in only one of those. We
 * instead embed the worker as a plain-JS source string executed with `eval: true`,
 * and hand the worker absolute, pre-resolved paths to the already-installed parser
 * packages (xlsx/pdf-parse/mammoth/jszip). Those packages stay external to the bundle,
 * so `createRequire(import.meta.url).resolve(...)` finds them from both the dev source
 * location and the built `dist/` location.
 */
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export type BinaryParseKind = "pdf" | "docx" | "xlsx" | "pptx";

/** Hard cap on concurrent parse workers so a burst of syncs can't spawn unbounded threads. */
const MAX_WORKERS = 2;

/** Per-parse wall-clock budget; on expiry the worker is terminated so a pathological file can't wedge a slot or leak memory. */
const PARSE_TIMEOUT_MS = 60_000;

interface WorkerResult {
  ok: boolean;
  text?: string | null;
  error?: string;
}

const nodeRequire = createRequire(import.meta.url);

let cachedDepPaths: Record<BinaryParseKind, string> | null = null;

/**
 * Resolve parser package entry points lazily so a resolution failure surfaces at
 * parse time (and is caught by the caller) rather than crashing module import.
 */
function getDepPaths(): Record<BinaryParseKind, string> {
  if (!cachedDepPaths) {
    cachedDepPaths = {
      pdf: nodeRequire.resolve("pdf-parse"),
      docx: nodeRequire.resolve("mammoth"),
      xlsx: nodeRequire.resolve("xlsx"),
      pptx: nodeRequire.resolve("jszip"),
    };
  }
  return cachedDepPaths;
}

let active = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_WORKERS) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  active--;
}

/**
 * Parse a binary document buffer in a worker thread and return the extracted text
 * (capped at `capBytes` inside the worker so a huge string never crosses back).
 * Returns null when the format yields no usable text; throws on parse failure or timeout.
 */
export async function runBinaryParse(
  kind: BinaryParseKind,
  buffer: ArrayBuffer,
  capBytes: number,
): Promise<string | null> {
  await acquireSlot();
  try {
    return await runInWorker(kind, buffer, capBytes);
  } finally {
    releaseSlot();
  }
}

function runInWorker(kind: BinaryParseKind, buffer: ArrayBuffer, capBytes: number): Promise<string | null> {
  const paths = getDepPaths();
  return new Promise<string | null>((resolve, reject) => {
    const worker = new Worker(PARSE_WORKER_SOURCE, {
      eval: true,
      workerData: { kind, capBytes, paths, buffer },
      transferList: [buffer],
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Binary parse timed out after ${PARSE_TIMEOUT_MS}ms`)));
    }, PARSE_TIMEOUT_MS);
    timer.unref();

    worker.once("message", (msg: WorkerResult) => {
      finish(() => {
        if (msg?.ok) resolve(msg.text ?? null);
        else reject(new Error(msg?.error ?? "Binary parse failed"));
      });
    });
    worker.once("error", (err) => {
      finish(() => reject(err));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Binary parse worker exited early with code ${code}`));
    });
  });
}

/**
 * Worker body, kept as plain CommonJS-compatible JS (no template literals, no TS) so it
 * survives `eval: true` unchanged. `String.raw` preserves the backslashes in the regexes
 * and "\n" separators. Faithfully ports the per-format extraction logic that previously
 * ran on the main thread, then caps the result before posting it back.
 */
const PARSE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

const MIN_TEXT_CHARS = 10;

function pick(mod, name) {
  if (mod && mod[name] !== undefined) return mod[name];
  if (mod && mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function extractPdf(buffer, path) {
  const mod = require(path);
  const PDFParse = pick(mod, "PDFParse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = result && result.text ? result.text.trim() : "";
    if (!text || text.length < MIN_TEXT_CHARS) return null;
    return text;
  } finally {
    try { await parser.destroy(); } catch (_e) {}
  }
}

async function extractDocx(buffer, path) {
  const mod = require(path);
  const fn = pick(mod, "extractRawText");
  const result = await fn({ buffer: buffer });
  const text = result && result.value ? result.value.trim() : "";
  if (!text || text.length < MIN_TEXT_CHARS) return null;
  return text;
}

function extractXlsx(buffer, path) {
  const mod = require(path);
  const read = pick(mod, "read");
  const utils = pick(mod, "utils");
  const workbook = read(buffer, { type: "buffer" });
  const sections = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv && csv.trim()) {
      sections.push("## " + sheetName + "\n" + csv.trim());
    }
  }
  if (sections.length === 0) return null;
  return sections.join("\n\n");
}

function extractXmlText(xml) {
  const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g);
  if (!matches) return "";
  const texts = matches.map(function (m) { return m.replace(/<[^>]+>/g, "").trim(); }).filter(Boolean);
  return texts.join(" ");
}

function slideNumber(name, prefix) {
  const match = name.match(new RegExp(prefix + "(\\d+)"));
  return parseInt((match && match[1]) || "0", 10);
}

async function extractPptx(buffer, path) {
  const mod = require(path);
  const JSZip = mod.default || mod;
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter(function (name) { return /^ppt\/slides\/slide\d+\.xml$/i.test(name); })
    .sort(function (a, b) { return slideNumber(a, "slide") - slideNumber(b, "slide"); });
  const noteFiles = Object.keys(zip.files)
    .filter(function (name) { return /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name); })
    .sort(function (a, b) { return slideNumber(a, "notesSlide") - slideNumber(b, "notesSlide"); });
  const slideTexts = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.files[slideFiles[i]].async("string");
    const slideText = extractXmlText(slideXml);
    let noteText = "";
    if (noteFiles[i]) {
      const noteXml = await zip.files[noteFiles[i]].async("string");
      noteText = extractXmlText(noteXml);
    }
    const parts = ["## Slide " + (i + 1)];
    if (slideText) parts.push(slideText);
    if (noteText) parts.push("Notes: " + noteText);
    if (slideText || noteText) slideTexts.push(parts.join("\n"));
  }
  if (slideTexts.length === 0) return null;
  return slideTexts.join("\n\n");
}

async function main() {
  const kind = workerData.kind;
  const capBytes = workerData.capBytes;
  const paths = workerData.paths;
  const buffer = Buffer.from(workerData.buffer);
  let text = null;
  if (kind === "pdf") text = await extractPdf(buffer, paths.pdf);
  else if (kind === "docx") text = await extractDocx(buffer, paths.docx);
  else if (kind === "xlsx") text = extractXlsx(buffer, paths.xlsx);
  else if (kind === "pptx") text = await extractPptx(buffer, paths.pptx);
  if (typeof text === "string" && text.length > capBytes) text = text.slice(0, capBytes);
  return text;
}

main().then(
  function (text) { parentPort.postMessage({ ok: true, text: text }); },
  function (err) { parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) }); }
);
`;
