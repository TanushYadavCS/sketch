import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentMessagesRepository } from "../../db/repositories/agent-messages";
import type { DB } from "../../db/schema";
import { createTestDb, createTestLogger } from "../../test-utils";
import type { RunAgentParams } from "../runner";
import {
  AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
  createDefaultAgentRuntimeCompactionProvider,
  reconstructCompactedHistory,
} from "./compaction";
import type { AgentRuntimeMessage, AgentRuntimeToolEnd, AgentRuntimeToolStart } from "./contracts";
import { runAgentRuntimeCore } from "./core";
import { createAgentRuntimeCustomToolEffects, createDefaultAgentRuntimeCustomToolProvider } from "./custom-tools";
import { createAgentRuntimeWorkspaceToolScopePolicy } from "./path-guard";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import { type AgentRuntimeProvider, createAgentRuntimeProvider } from "./provider";
import { createDbAgentRuntimeSessionStore } from "./session-store";
import { createAgentRuntimeWorkspaceTools } from "./workspace-tools";

interface OpenRouterModelRecord {
  id: string;
  name: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing?: Record<string, string | undefined>;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
}

interface RequestRecord {
  url: string;
  model: string | null;
  hasTools: boolean;
  toolNames: string[];
  messageCount: number;
  status: number | null;
  error: string | null;
}

interface ToolObservation {
  starts: AgentRuntimeToolStart[];
  ends: AgentRuntimeToolEnd[];
}

const MODEL_TARGETS = [
  {
    key: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    terms: ["deepseek", "v4", "pro"],
  },
  {
    key: "xiaomi-mimo-v2.5-pro",
    label: "Xiaomi Mimo V2.5 Pro",
    terms: ["xiaomi", "mimo", "2.5", "pro"],
  },
] as const;

const LIVE_OPENROUTER_ENABLED = process.env.AGENT_RUNTIME_LIVE_OPENROUTER === "1";
const TEST_TIMEOUT_MS = 180_000;
const SYSTEM_PROMPT =
  "You are Sketch's Phase 4c-2 live verification assistant. Use available tools exactly when requested. Keep final answers concise and include exact sentinel strings.";

function findEnvPath(): string | undefined {
  let currentPath = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(currentPath, ".env");
    if (existsSync(candidate)) return candidate;

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return undefined;
    currentPath = parentPath;
  }

  return undefined;
}

const envPath = findEnvPath();
if (envPath) {
  loadDotenv({ path: envPath, override: false, quiet: true });
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, " ");
}

function targetEnabled(targetKey: string): boolean {
  const raw = process.env.AGENT_RUNTIME_OPENROUTER_MODEL;
  if (!raw) return true;
  const enabled = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return enabled.has(targetKey);
}

function cellEnabled(cell: string): boolean {
  const raw = process.env.AGENT_RUNTIME_OPENROUTER_CELL;
  if (!raw) return true;
  const enabled = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return enabled.has(cell);
}

async function fetchOpenRouterModels(): Promise<OpenRouterModelRecord[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error(`OpenRouter model lookup failed with HTTP ${response.status}`);
  const body = (await response.json()) as { data?: OpenRouterModelRecord[] };
  return body.data ?? [];
}

function resolveTargetModel(
  records: readonly OpenRouterModelRecord[],
  target: (typeof MODEL_TARGETS)[number],
): OpenRouterModelRecord {
  const matches = records.filter((record) => {
    const haystack = normalized(`${record.id} ${record.name}`);
    return target.terms.every((term) => haystack.includes(term));
  });
  const selected = matches.sort((left, right) => left.id.length - right.id.length)[0];
  if (!selected) throw new Error(`Could not resolve OpenRouter model for ${target.label}`);
  return selected;
}

function modelCapabilities(record: OpenRouterModelRecord) {
  const supported = new Set(record.supported_parameters ?? []);
  return {
    id: record.id,
    name: record.name,
    contextLength: record.context_length ?? record.top_provider?.context_length ?? null,
    maxCompletionTokens: record.top_provider?.max_completion_tokens ?? null,
    inputModalities: record.architecture?.input_modalities ?? [],
    outputModalities: record.architecture?.output_modalities ?? [],
    tools: supported.has("tools"),
    toolChoice: supported.has("tool_choice"),
    imageInput: record.architecture?.input_modalities?.includes("image") ?? false,
    promptCaching: record.pricing?.input_cache_read !== undefined,
    pricing: record.pricing ?? {},
  };
}

function requestBodyFrom(input: RequestInfo | URL, init?: RequestInit): string | null {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  if (input instanceof Request) return null;
  return null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestRecordFrom(input: RequestInfo | URL, init?: RequestInit): RequestRecord {
  const bodyText = requestBodyFrom(input, init);
  let parsed: Record<string, unknown> = {};
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];

  return {
    url: requestUrl(input),
    model: typeof parsed.model === "string" ? parsed.model : null,
    hasTools: tools.length > 0,
    toolNames: tools.flatMap((entry) =>
      entry && typeof entry === "object" && "function" in entry
        ? [String((entry as { function?: { name?: unknown } }).function?.name ?? "")]
        : [],
    ),
    messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    status: null,
    error: null,
  };
}

function createRecordingFetch(records: RequestRecord[], onRequest?: () => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const record = requestRecordFrom(input, init);
    records.push(record);
    onRequest?.();
    try {
      const response = await fetch(input, init);
      record.status = response.status;
      return response;
    } catch (error) {
      record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    }
  }) as typeof fetch;
}

function createProvider(modelId: string, records: RequestRecord[], onRequest?: () => void): AgentRuntimeProvider {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for live OpenRouter verification");

  return createAgentRuntimeProvider(
    {
      provider: "openrouter",
      modelId,
      apiKey,
      baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "X-Title": "Sketch Agent Runtime Live Verification",
      },
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    },
    { fetch: createRecordingFetch(records, onRequest) },
  );
}

function observeTools(): ToolObservation {
  return { starts: [], ends: [] };
}

function evidence(model: OpenRouterModelRecord, cell: string, payload: Record<string, unknown>): void {
  console.log(
    `OPENROUTER_LIVE_RESULT ${JSON.stringify({
      model: model.id,
      cell,
      ...payload,
    })}`,
  );
}

async function workspaceTools(
  workspaceDir: string,
  toolNames: Parameters<typeof createAgentRuntimeWorkspaceTools>[0]["toolNames"],
) {
  const scope = await createAgentRuntimeWorkspaceToolScopePolicy({ workspaceRoot: workspaceDir });
  return createAgentRuntimeWorkspaceTools({ scope, toolNames });
}

function assertUsageShape(result: Awaited<ReturnType<typeof runAgentRuntimeCore>>) {
  expect(result.usage.totalInputTokens).toBeGreaterThan(0);
  expect(result.usage.totalOutputTokens).toBeGreaterThan(0);
  expect(result.usage.totalCacheReadTokens).toBeGreaterThanOrEqual(0);
  expect(result.usage.totalCacheWriteTokens).toBeGreaterThanOrEqual(0);
}

const resolvedModels = new Map<string, OpenRouterModelRecord>();

describe.skipIf(!LIVE_OPENROUTER_ENABLED)("agent runtime OpenRouter live non-Claude matrix", () => {
  let db: Kysely<DB>;
  let workspaceDir: string;

  beforeAll(async () => {
    const records = await fetchOpenRouterModels();
    for (const target of MODEL_TARGETS) {
      if (!targetEnabled(target.key)) continue;
      const record = resolveTargetModel(records, target);
      resolvedModels.set(target.key, record);
      console.log(`OPENROUTER_LIVE_MODEL ${JSON.stringify(modelCapabilities(record))}`);
    }
  }, 30_000);

  beforeEach(async () => {
    db = await createTestDb();
    workspaceDir = await mkdtemp(join(tmpdir(), "sketch-openrouter-runtime-"));
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await db.destroy();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  afterAll(() => {
    resolvedModels.clear();
  });

  for (const target of MODEL_TARGETS.filter((entry) => targetEnabled(entry.key))) {
    describe(target.label, () => {
      const cell = (name: string, fn: (model: OpenRouterModelRecord) => Promise<void>) =>
        it.skipIf(!cellEnabled(name))(
          name,
          async () => {
            const model = resolvedModels.get(target.key);
            if (!model) throw new Error(`Resolved model missing for ${target.label}`);
            await fn(model);
          },
          TEST_TIMEOUT_MS,
        );

      cell("01 single-turn text", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);

        const result = await runAgentRuntimeCore({
          provider,
          prompt: "Reply exactly with PHASE4C2_TEXT_OK.",
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          persistSession: false,
          cacheBreakpoints: true,
        });

        evidence(model, "01 single-turn text", {
          status: "pass",
          finalText: result.finalText,
          stopReason: result.stopReason,
          usage: result.usage,
          cost: result.cost.totalUsd,
          requests,
        });
        expect(result.finalText.trim().length).toBeGreaterThan(0);
        expect(result.stopReason).toBe("end_turn");
        assertUsageShape(result);
      });

      cell("02 workspace read and write-read", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const seededMarker = `PHASE4C2_READ_MARKER_${target.key}`;
        const writeMarker = `PHASE4C2_WRITE_MARKER_${target.key}`;
        const seededFile = join(workspaceDir, "read-target.txt");
        const writtenFile = join(workspaceDir, "write-target.txt");
        await writeFile(seededFile, `${seededMarker}\n`, "utf8");
        const readEvents = observeTools();
        const writeEvents = observeTools();

        const readResult = await runAgentRuntimeCore({
          provider,
          prompt: `Call Read with file_path "${seededFile}". Then reply with exactly: READ_OK ${seededMarker}`,
          systemPrompt: SYSTEM_PROMPT,
          tools: await workspaceTools(workspaceDir, ["Read"]),
          maxTurns: 4,
          persistSession: false,
          cacheBreakpoints: false,
          events: {
            onToolStart: (event) => {
              readEvents.starts.push(event);
            },
            onToolEnd: (event) => {
              readEvents.ends.push(event);
            },
          },
        });
        const writeResult = await runAgentRuntimeCore({
          provider,
          prompt: `First call Write with file_path "${writtenFile}" and content "${writeMarker}". Then call Read with file_path "${writtenFile}". Then reply with exactly: WRITE_READ_OK ${writeMarker}`,
          systemPrompt: SYSTEM_PROMPT,
          tools: await workspaceTools(workspaceDir, ["Write", "Read"]),
          maxTurns: 6,
          persistSession: false,
          cacheBreakpoints: false,
          events: {
            onToolStart: (event) => {
              writeEvents.starts.push(event);
            },
            onToolEnd: (event) => {
              writeEvents.ends.push(event);
            },
          },
        });

        evidence(model, "02 workspace read and write-read", {
          status: "pass",
          readFinalText: readResult.finalText,
          writeFinalText: writeResult.finalText,
          readStopReason: readResult.stopReason,
          writeStopReason: writeResult.stopReason,
          toolStarts: [...readEvents.starts, ...writeEvents.starts].map((event) => event.name),
          toolErrors: [...readEvents.ends, ...writeEvents.ends].flatMap((event) => (event.error ? [event.error] : [])),
          usage: {
            read: readResult.usage,
            write: writeResult.usage,
          },
          writtenContent: await readFile(writtenFile, "utf8"),
          requests,
        });
        expect(readEvents.starts.map((event) => event.name)).toContain("Read");
        expect(readResult.finalText).toContain(seededMarker);
        expect(writeEvents.starts.map((event) => event.name)).toEqual(expect.arrayContaining(["Write", "Read"]));
        expect(writeResult.finalText).toContain(writeMarker);
        expect(await readFile(writtenFile, "utf8")).toContain(writeMarker);
        assertUsageShape(readResult);
        assertUsageShape(writeResult);
      });

      cell("03 multi-step glob read chaining", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const marker = `PHASE4C2_CHAIN_MARKER_${target.key}`;
        const targetDir = join(workspaceDir, "nested");
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, "phase4c2-chain-target.txt"), marker, "utf8");
        const events = observeTools();

        const result = await runAgentRuntimeCore({
          provider,
          prompt: `Call Glob with pattern "**/*chain-target.txt" and path "${workspaceDir}". Then call Read on the matching file. Then reply with exactly: CHAIN_OK ${marker}`,
          systemPrompt: SYSTEM_PROMPT,
          tools: await workspaceTools(workspaceDir, ["Glob", "Read"]),
          maxTurns: 6,
          persistSession: false,
          cacheBreakpoints: false,
          events: {
            onToolStart: (event) => {
              events.starts.push(event);
            },
            onToolEnd: (event) => {
              events.ends.push(event);
            },
          },
        });
        const toolOrder = events.starts.map((event) => event.name);

        evidence(model, "03 multi-step glob read chaining", {
          status: "pass",
          finalText: result.finalText,
          stopReason: result.stopReason,
          toolOrder,
          usage: result.usage,
          requests,
        });
        expect(toolOrder.indexOf("Glob")).toBeGreaterThanOrEqual(0);
        expect(toolOrder.indexOf("Read")).toBeGreaterThan(toolOrder.indexOf("Glob"));
        expect(result.finalText).toContain(marker);
        assertUsageShape(result);
      });

      cell("04 custom MCP envelope tool", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const expectedToolText = "Timezone update is not available in this context.";
        const effects = createAgentRuntimeCustomToolEffects();
        const customProvider = createDefaultAgentRuntimeCustomToolProvider({
          effects,
          transcriptionEnabled: false,
          visionAnalysisEnabled: false,
          visionConfig: null,
        });
        const params = {
          db,
          workspaceKey: `openrouter-live-${target.key}`,
          userMessage: "custom tool smoke",
          workspaceDir,
          userName: "OpenRouter Live",
          logger: createTestLogger(),
          platform: "slack",
          onProgressEvent: async () => {},
          agentRuntime: "aisdk",
          agentAllowedTools: ["mcp__sketch__SetUserTimezone"],
        } satisfies RunAgentParams;
        const tools = await customProvider.createTools(params);
        const events = observeTools();

        const result = await runAgentRuntimeCore({
          provider,
          prompt: `Call mcp__sketch__SetUserTimezone with timezone "Asia/Kolkata". Then reply with the exact tool output text.`,
          systemPrompt: SYSTEM_PROMPT,
          tools,
          maxTurns: 4,
          persistSession: false,
          cacheBreakpoints: false,
          events: {
            onToolStart: (event) => {
              events.starts.push(event);
            },
            onToolEnd: (event) => {
              events.ends.push(event);
            },
          },
        });

        evidence(model, "04 custom MCP envelope tool", {
          status: "pass",
          finalText: result.finalText,
          stopReason: result.stopReason,
          toolStarts: events.starts.map((event) => event.name),
          toolResults: events.ends.map((event) => event.result),
          usage: result.usage,
          requests,
        });
        expect(events.starts.map((event) => event.name)).toContain("mcp__sketch__SetUserTimezone");
        expect(result.finalText).toContain(expectedToolText);
        assertUsageShape(result);
      });

      cell("05 session resume with DB store", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const sessionId = `openrouter-live-session-${target.key}`;
        const sessionStore = createDbAgentRuntimeSessionStore(db);
        const fact = `phase4c2-session-fact-${target.key}`;

        const turn1 = await runAgentRuntimeCore({
          provider,
          prompt: `Remember this exact fact for the next turn: ${fact}. Reply exactly: SESSION_FACT_STORED.`,
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          cacheBreakpoints: false,
        });
        const turn2 = await runAgentRuntimeCore({
          provider,
          prompt: "What exact fact did I ask you to remember? Reply with only the fact.",
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          cacheBreakpoints: false,
        });
        const rows = await createAgentMessagesRepository(db).loadBySession(sessionId);

        evidence(model, "05 session resume with DB store", {
          status: "pass",
          turn1FinalText: turn1.finalText,
          turn2FinalText: turn2.finalText,
          rowCount: rows.length,
          usage: {
            turn1: turn1.usage,
            turn2: turn2.usage,
          },
          requests,
        });
        expect(turn1.finalText.trim().length).toBeGreaterThan(0);
        expect(turn2.finalText).toContain(fact);
        expect(rows.length).toBeGreaterThanOrEqual(4);
        assertUsageShape(turn1);
        assertUsageShape(turn2);
      });

      cell("06 compaction end-to-end", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const sessionId = `openrouter-live-compaction-${target.key}`;
        const sessionStore = createDbAgentRuntimeSessionStore(db);
        const tailMarker = `PHASE4C2_TAIL_MARKER_${target.key}`;
        const currentUserMessage = {
          role: "user" as const,
          content: `What recent tail marker is present? Include ${tailMarker}.`,
        };
        await sessionStore.appendTransactional(sessionId, [
          { role: "user", content: { role: "user", content: "Older user fact: alpha decision." } },
          { role: "assistant", content: { role: "assistant", content: "Older assistant answer: beta context." } },
          { role: "user", content: { role: "user", content: `Recent tail sentinel: ${tailMarker}` } },
        ]);

        const result = await runAgentRuntimeCore({
          provider,
          prompt: currentUserMessage.content,
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          cacheBreakpoints: false,
          compaction: createDefaultAgentRuntimeCompactionProvider({
            provider,
            sessionStore,
            systemPrompt: SYSTEM_PROMPT,
            currentUserMessage,
            contextWindowTokens: 10,
            thresholdFraction: 0.1,
            keepRecentTailFraction: 0.1,
            estimateTokens: () => 1,
          }),
        });
        const rows = await createAgentMessagesRepository(db).loadBySession(sessionId);
        const markerRows = rows.filter(
          (row): row is typeof row & { content: { marker: string; summary: string } } =>
            row.content !== null &&
            typeof row.content === "object" &&
            (row.content as { marker?: unknown }).marker === AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
        );
        const reconstructed = reconstructCompactedHistory(rows as AgentRuntimeMessage[]);
        const reconstructedText = JSON.stringify(reconstructed.map((row) => row.content));

        evidence(model, "06 compaction end-to-end", {
          status: "pass",
          finalText: result.finalText,
          markerRows: markerRows.length,
          markerSummaryLength: markerRows[0]?.content.summary.length ?? 0,
          reconstructedRows: reconstructed.length,
          reconstructedContainsSummary: reconstructedText.includes("[Prior conversation summary]"),
          reconstructedContainsTail: reconstructedText.includes(tailMarker),
          usage: result.usage,
          requests,
        });
        expect(markerRows).toHaveLength(1);
        expect(markerRows[0]?.content.summary.length ?? 0).toBeGreaterThan(0);
        expect(reconstructedText).toContain("[Prior conversation summary]");
        expect(reconstructedText).toContain(tailMarker);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests.every((request) => request.model === null || request.model === model.id)).toBe(true);
        expect(result.finalText).toContain(tailMarker);
        assertUsageShape(result);
      });

      cell("07 abort and clean resume", async (model) => {
        const requests: RequestRecord[] = [];
        const controller = new AbortController();
        let abortScheduled = false;
        const provider = createProvider(model.id, requests, () => {
          if (abortScheduled) return;
          abortScheduled = true;
          setTimeout(() => controller.abort(), 10);
        });
        const sessionId = `openrouter-live-abort-${target.key}`;
        const sessionStore = createDbAgentRuntimeSessionStore(db);

        const aborted = await runAgentRuntimeCore({
          provider,
          prompt: "Write a very long answer with at least 5000 words about runtime portability.",
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          abortSignal: controller.signal,
          cacheBreakpoints: false,
        });
        const resumeProvider = createProvider(model.id, requests);
        const resumed = await runAgentRuntimeCore({
          provider: resumeProvider,
          prompt: "Reply exactly: ABORT_RESUME_OK.",
          systemPrompt: SYSTEM_PROMPT,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          cacheBreakpoints: false,
        });
        const rows = await createAgentMessagesRepository(db).loadBySession(sessionId);

        evidence(model, "07 abort and clean resume", {
          status: "pass",
          abortedStopReason: aborted.stopReason,
          resumedFinalText: resumed.finalText,
          rowCount: rows.length,
          usage: {
            aborted: aborted.usage,
            resumed: resumed.usage,
          },
          requests,
        });
        expect(aborted.stopReason).toBe("aborted");
        expect(resumed.finalText).toContain("ABORT_RESUME_OK");
        expect(rows.length).toBeGreaterThanOrEqual(2);
        assertUsageShape(resumed);
      });

      cell("08 tool-error handling", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const events = observeTools();
        const missingFile = join(workspaceDir, "missing-phase4c2.txt");

        const result = await runAgentRuntimeCore({
          provider,
          prompt: `Call Read with file_path "${missingFile}". After the tool reports the error, reply with TOOL_ERROR_OBSERVED and a short reason.`,
          systemPrompt: SYSTEM_PROMPT,
          tools: await workspaceTools(workspaceDir, ["Read"]),
          maxTurns: 4,
          persistSession: false,
          cacheBreakpoints: false,
          events: {
            onToolStart: (event) => {
              events.starts.push(event);
            },
            onToolEnd: (event) => {
              events.ends.push(event);
            },
          },
        });

        evidence(model, "08 tool-error handling", {
          status: "pass",
          finalText: result.finalText,
          stopReason: result.stopReason,
          toolStarts: events.starts.map((event) => event.name),
          toolErrors: events.ends.flatMap((event) => (event.error ? [event.error] : [])),
          usage: result.usage,
          requests,
        });
        expect(events.starts.map((event) => event.name)).toContain("Read");
        expect(events.ends.some((event) => event.error)).toBe(true);
        expect(result.finalText.trim().length).toBeGreaterThan(0);
        expect(result.stopReason).toBe("end_turn");
        assertUsageShape(result);
      });

      cell("09 caching usage shape", async (model) => {
        const requests: RequestRecord[] = [];
        const provider = createProvider(model.id, requests);
        const sessionId = `openrouter-live-cache-${target.key}`;
        const sessionStore = createDbAgentRuntimeSessionStore(db);
        const fatSystemPrompt = [
          SYSTEM_PROMPT,
          ...Array.from(
            { length: 800 },
            (_, index) => `Stable OpenRouter cache anchor ${index}: Sketch runtime portability verification.`,
          ),
        ].join("\n");

        const turn1 = await runAgentRuntimeCore({
          provider,
          prompt: "Reply exactly: CACHE_WARMED.",
          systemPrompt: fatSystemPrompt,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          cacheBreakpoints: true,
        });
        const turn2 = await runAgentRuntimeCore({
          provider,
          prompt: "Reply exactly: CACHE_PROBE.",
          systemPrompt: fatSystemPrompt,
          maxTurns: 1,
          persistSession: true,
          sessionId,
          sessionStore,
          cacheBreakpoints: true,
        });

        evidence(model, "09 caching usage shape", {
          status: "pass",
          turn1FinalText: turn1.finalText,
          turn2FinalText: turn2.finalText,
          turn1CacheReadTokens: turn1.usage.totalCacheReadTokens,
          turn1CacheWriteTokens: turn1.usage.totalCacheWriteTokens,
          turn2CacheReadTokens: turn2.usage.totalCacheReadTokens,
          turn2CacheWriteTokens: turn2.usage.totalCacheWriteTokens,
          usage: {
            turn1: turn1.usage,
            turn2: turn2.usage,
          },
          requests,
        });
        expect(turn1.finalText.trim().length).toBeGreaterThan(0);
        expect(turn2.finalText.trim().length).toBeGreaterThan(0);
        assertUsageShape(turn1);
        assertUsageShape(turn2);
      });
    });
  }
});
