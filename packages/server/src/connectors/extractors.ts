/**
 * Binary file content extractors.
 *
 * Extracts plain text from common binary document formats:
 * - PDF   → pdf-parse v2 (PDFParse class, Mozilla pdf.js wrapper)
 * - DOCX  → mammoth (converts to plain text)
 * - XLSX  → xlsx/SheetJS (each sheet → CSV text)
 * - PPTX  → JSZip + regex XML parse (extracts slide text + notes)
 *
 * The parsing itself is CPU-heavy (and, for XLSX, fully synchronous), so it runs in a
 * worker thread (see ./extractors-pool) to keep the single shared event loop responsive.
 * This module stays the public, buffer-in / string-out API used by google-drive.ts.
 */
import type { Logger } from "pino";
import { type BinaryParseKind, runBinaryParse } from "./extractors-pool";

/**
 * Upper bound on returned text length, applied inside the worker so a pathological
 * document never marshals a multi-megabyte string back across the thread boundary.
 * google-drive.ts applies the same 512KB cap again as defense in depth.
 */
const MAX_EXTRACTED_CHARS = 512 * 1024;

/** MIME type → parser kind. Single source of truth for what the extractors handle. */
const MIME_TO_KIND: Record<string, BinaryParseKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "pptx",
};

/** MIME types handled by binary extractors. */
export const BINARY_EXTRACTABLE_MIMES = new Set(Object.keys(MIME_TO_KIND));

/**
 * Extract text from a binary file buffer based on its MIME type.
 * Returns null if the format is unsupported or extraction fails.
 */
export async function extractTextFromBinary(
  buffer: ArrayBuffer,
  mimeType: string,
  logger: Logger,
): Promise<string | null> {
  const kind = MIME_TO_KIND[mimeType];
  if (!kind) return null;

  try {
    return await runBinaryParse(kind, buffer, MAX_EXTRACTED_CHARS);
  } catch (err) {
    logger.warn({ err, mimeType }, "Binary content extraction failed");
    return null;
  }
}
