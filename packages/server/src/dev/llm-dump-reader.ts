import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type LlmDumpStage = "extractEntities" | "dedupAdjudicate" | "generateSummary" | "extractEntityFacts" | "unknown";

export interface LlmDumpHeader {
  seq: number;
  label: string;
  stage: LlmDumpStage;
  at: string | null;
  model: string;
  promptChars: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  finishReason: string | null;
  unreadable?: { reason: string };
}

export interface LlmDumpBody extends LlmDumpHeader {
  prompt: string | null;
  systemPrompt: string | null;
  text: string | null;
  parsed?: unknown;
}

interface DumpPayload {
  label?: unknown;
  prompt?: unknown;
  systemPrompt?: unknown;
  text?: unknown;
  finishReason?: unknown;
  promptTokens?: unknown;
  candidatesTokens?: unknown;
  completionTokens?: unknown;
  costUsd?: unknown;
}

interface ParsedFilename {
  at: string | null;
  safeLabel: string;
  model: string;
}

export async function listLlmDumpHeaders(dumpDir: string): Promise<LlmDumpHeader[]> {
  const files = await listDumpFiles(dumpDir);
  return Promise.all(files.map((file, index) => readDumpHeader(dumpDir, file, index + 1)));
}

export async function readLlmDumpBody(dumpDir: string, seq: number): Promise<LlmDumpBody | null> {
  const files = await listDumpFiles(dumpDir);
  const file = files[seq - 1];
  if (!file) return null;
  return readDumpBody(dumpDir, file, seq);
}

/**
 * A missing directory is the normal state for a run whose first call has not
 * returned yet, or whose only call threw before the writer ran.
 */
async function listDumpFiles(dumpDir: string): Promise<string[]> {
  try {
    return (await readdir(dumpDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readDumpHeader(dumpDir: string, filename: string, seq: number): Promise<LlmDumpHeader> {
  const meta = parseDumpFilename(filename);
  const fallback = fallbackHeader(seq, meta);
  try {
    const payload = parsePayload(await readFile(join(dumpDir, filename), "utf8"));
    return headerFromPayload(seq, meta, payload);
  } catch (err) {
    return { ...fallback, unreadable: { reason: err instanceof Error ? err.message : String(err) } };
  }
}

async function readDumpBody(dumpDir: string, filename: string, seq: number): Promise<LlmDumpBody> {
  const meta = parseDumpFilename(filename);
  const fallback = fallbackHeader(seq, meta);
  try {
    const payload = parsePayload(await readFile(join(dumpDir, filename), "utf8"));
    const header = headerFromPayload(seq, meta, payload);
    const text = stringOrNull(payload.text);
    const parsed = text ? parseJsonText(text) : undefined;
    return {
      ...header,
      prompt: stringOrNull(payload.prompt),
      systemPrompt: stringOrNull(payload.systemPrompt),
      text,
      ...(parsed === undefined ? {} : { parsed }),
    };
  } catch (err) {
    return {
      ...fallback,
      prompt: null,
      systemPrompt: null,
      text: null,
      unreadable: { reason: err instanceof Error ? err.message : String(err) },
    };
  }
}

function fallbackHeader(seq: number, meta: ParsedFilename): LlmDumpHeader {
  return {
    seq,
    label: meta.safeLabel,
    stage: stageFromLabel(meta.safeLabel),
    at: meta.at,
    model: meta.model,
    promptChars: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    finishReason: null,
  };
}

function headerFromPayload(seq: number, meta: ParsedFilename, payload: DumpPayload): LlmDumpHeader {
  const label = stringOrNull(payload.label) ?? meta.safeLabel;
  return {
    seq,
    label,
    stage: stageFromLabel(label),
    at: meta.at,
    model: meta.model,
    promptChars: typeof payload.prompt === "string" ? Buffer.byteLength(payload.prompt, "utf8") : null,
    promptTokens: numberOrNull(payload.promptTokens),
    completionTokens: numberOrNull(payload.completionTokens ?? payload.candidatesTokens),
    costUsd: numberOrNull(payload.costUsd),
    finishReason: stringOrNull(payload.finishReason),
  };
}

function parsePayload(raw: string): DumpPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Dump JSON was not an object");
  return parsed as DumpPayload;
}

function parseDumpFilename(filename: string): ParsedFilename {
  const stem = filename.endsWith(".json") ? filename.slice(0, -5) : filename;
  const separator = stem.indexOf("__");
  if (separator < 0) return { at: null, safeLabel: stem, model: "unknown" };
  const stamp = stem.slice(0, separator);
  const rest = stem.slice(separator + 2);
  const openRouter = rest.startsWith("openrouter_");
  return {
    at: parseDumpTimestamp(stamp),
    safeLabel: openRouter ? rest.slice("openrouter_".length) : rest,
    model: openRouter ? "openrouter" : "gemini-2.5-flash",
  };
}

function parseDumpTimestamp(stamp: string): string | null {
  if (!stamp) return null;
  if (!Number.isNaN(Date.parse(stamp))) return new Date(stamp).toISOString();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/.exec(stamp);
  if (!match) return null;
  const restored = `${match[1]}:${match[2]}:${match[3]}.${match[4]}`;
  return Number.isNaN(Date.parse(restored)) ? null : new Date(restored).toISOString();
}

function stageFromLabel(label: string): LlmDumpStage {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.startsWith("extractEntities_") || label.startsWith("extractEntities:")) return "extractEntities";
  if (safe.startsWith("dedupAdjudicate_") || label.startsWith("dedupAdjudicate:")) return "dedupAdjudicate";
  if (safe.startsWith("generateSummary_") || label.startsWith("generateSummary:")) return "generateSummary";
  if (safe.startsWith("extractEntityFacts_") || label.startsWith("extractEntityFacts:")) return "extractEntityFacts";
  return "unknown";
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch {
    return undefined;
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
