import { type ModelMessage, type ToolSet, generateText } from "ai";
import type {
  AgentRuntimeCompactionProvider,
  AgentRuntimeCompactionSummaryMarker,
  AgentRuntimeCompactionSummaryPayload,
  AgentRuntimeCompactionTrigger,
  AgentRuntimeCompactionTriggerConfig,
  AgentRuntimeKeepRecentTailBoundary,
  AgentRuntimeMessage,
  AgentRuntimePersistedCompactionRow,
  AgentRuntimeSessionStore,
  AgentRuntimeToolCallResultPairBoundary,
} from "./contracts";
import type { AgentRuntimeProvider } from "./provider";

export const AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER = "sketch.agent_runtime.compaction_summary";
export const EMPTY_COMPACTION_SUMMARY_PLACEHOLDER = "[Prior conversation summarized; no salient details retained]";

/**
 * Deliberate cap (decided 2026-07-06): every model is treated as a 200k-context model regardless of its
 * real window. Larger windows (e.g. 1M-class OpenRouter models) just compact earlier than strictly needed,
 * which is safe. Revisit only if a supported model has a window SMALLER than 200k, where compaction would
 * otherwise trigger too late and the provider would reject the request first.
 */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_THRESHOLD_FRACTION = 0.8;
const DEFAULT_KEEP_RECENT_TAIL_FRACTION = 0.3;
const ZOD_TOOL_INPUT_SCHEMA_FALLBACK_TOKENS = 300;

type AgentRuntimeCompactionSummaryEnvelope = AgentRuntimeCompactionSummaryMarker & {
  summary: AgentRuntimeCompactionSummaryPayload["summary"];
  replacedPrefixStartSeq: number;
  replacedPrefixEndSeq: number;
  keepRecentTailStartSeq: number;
};

export interface AgentRuntimeCompactionTriggerInput {
  modelId: string;
  systemPrompt: string;
  history: readonly AgentRuntimeMessage[];
  currentUserMessage: ModelMessage;
  tools?: ToolSet;
  thresholdFraction?: number;
  contextWindowTokens?: number;
  estimateTokens?: (value: unknown) => number;
}

export interface AgentRuntimeKeepRecentTailBoundaryInput {
  messages: readonly AgentRuntimeMessage[];
  targetTokens: number;
  fallbackStartSeq?: number;
  estimateTokens?: (value: unknown) => number;
}

export interface DefaultAgentRuntimeCompactionProviderParams {
  provider: AgentRuntimeProvider;
  sessionStore: AgentRuntimeSessionStore;
  systemPrompt: string;
  currentUserMessage: ModelMessage;
  tools?: ToolSet;
  thresholdFraction?: number;
  contextWindowTokens?: number;
  keepRecentTailFraction?: number;
  abortSignal?: AbortSignal;
  estimateTokens?: (value: unknown) => number;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Until provider token counters are available on the pre-run path, compaction uses a conservative char/4 estimate.
 */
export function estimateAgentRuntimeTokens(value: unknown): number {
  const chars = stringifyForEstimate(value).length;
  return chars === 0 ? 0 : Math.ceil(chars / 4);
}

function estimateMessageTokens(message: AgentRuntimeMessage, estimateTokens: (value: unknown) => number): number {
  return estimateTokens({ role: message.role, content: message.content });
}

function isLikelyZodSchema(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const maybeSchema = value as { parse?: unknown; safeParse?: unknown };
  return (
    (typeof maybeSchema.parse === "function" || typeof maybeSchema.safeParse === "function") &&
    ("_def" in value || "def" in value || "~standard" in value)
  );
}

/**
 * AI SDK tools can carry zod schemas, whose object serialization is implementation detail rather than provider-visible schema.
 */
function estimateToolInputSchemaTokens(schema: unknown, estimateTokens: (value: unknown) => number): number {
  if (schema === undefined) return 0;
  if (isLikelyZodSchema(schema)) {
    return estimateTokens(" ".repeat(ZOD_TOOL_INPUT_SCHEMA_FALLBACK_TOKENS * 4));
  }
  return estimateTokens(schema);
}

function estimateToolTokens(
  name: string,
  toolDefinition: ToolSet[string],
  estimateTokens: (value: unknown) => number,
): number {
  const description =
    isRecord(toolDefinition) && typeof toolDefinition.description === "string" ? toolDefinition.description : "";
  const inputSchema =
    isRecord(toolDefinition) && "inputSchema" in toolDefinition ? toolDefinition.inputSchema : undefined;

  return (
    estimateTokens(name) + estimateTokens(description) + estimateToolInputSchemaTokens(inputSchema, estimateTokens)
  );
}

function estimateToolSetTokens(tools: ToolSet | undefined, estimateTokens: (value: unknown) => number): number {
  if (!tools) return 0;

  return Object.entries(tools).reduce(
    (total, [name, toolDefinition]) => total + estimateToolTokens(name, toolDefinition, estimateTokens),
    0,
  );
}

function createTriggerConfig(input: AgentRuntimeCompactionTriggerInput): AgentRuntimeCompactionTriggerConfig {
  return {
    thresholdFraction: input.thresholdFraction ?? DEFAULT_THRESHOLD_FRACTION,
    contextWindowTokens: input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

export function createAgentRuntimeCompactionTrigger(
  input: AgentRuntimeCompactionTriggerInput,
): AgentRuntimeCompactionTrigger {
  const estimateTokens = input.estimateTokens ?? estimateAgentRuntimeTokens;
  const config = createTriggerConfig(input);
  const thresholdTokens = Math.floor(config.contextWindowTokens * config.thresholdFraction);
  const estimatedInputTokens =
    estimateTokens(input.systemPrompt) +
    input.history.reduce((total, message) => total + estimateMessageTokens(message, estimateTokens), 0) +
    estimateTokens(input.currentUserMessage) +
    estimateToolSetTokens(input.tools, estimateTokens);

  return {
    behavior: estimatedInputTokens > thresholdTokens ? "compact" : "skip",
    estimatedInputTokens,
    thresholdTokens,
    config,
  };
}

function isCompactionSummaryEnvelope(value: unknown): value is AgentRuntimeCompactionSummaryEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.marker === AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER &&
    value.version === 1 &&
    (value.trigger === "auto" || value.trigger === "manual") &&
    typeof value.summary === "string" &&
    typeof value.replacedPrefixStartSeq === "number" &&
    typeof value.replacedPrefixEndSeq === "number" &&
    typeof value.keepRecentTailStartSeq === "number"
  );
}

function isCompactionSummaryRow(message: AgentRuntimeMessage): boolean {
  return isCompactionSummaryEnvelope(message.content);
}

function latestCompactionSummary(rows: readonly AgentRuntimeMessage[]): {
  row: AgentRuntimeMessage;
  envelope: AgentRuntimeCompactionSummaryEnvelope;
} | null {
  let latest: {
    row: AgentRuntimeMessage;
    envelope: AgentRuntimeCompactionSummaryEnvelope;
  } | null = null;

  for (const row of rows) {
    if (!isCompactionSummaryEnvelope(row.content)) continue;
    if (!latest || row.seq > latest.row.seq) {
      latest = { row, envelope: row.content };
    }
  }

  return latest;
}

function summaryBlock(summary: string): string {
  const text = summary.trim().length > 0 ? summary : EMPTY_COMPACTION_SUMMARY_PLACEHOLDER;
  return `[Prior conversation summary]\n${text}`;
}

/**
 * Empty summary markers still become an explicit synthetic user message so the prompt has no silent history gap.
 */
export function reconstructCompactedHistory(rows: readonly AgentRuntimeMessage[]): AgentRuntimeMessage[] {
  const latest = latestCompactionSummary(rows);
  if (!latest) return rows as AgentRuntimeMessage[];

  const syntheticSummary: AgentRuntimeMessage = {
    seq: latest.row.seq,
    role: "user",
    content: { role: "user", content: summaryBlock(latest.envelope.summary) } satisfies ModelMessage,
  };
  const tail = rows.filter((row) => !isCompactionSummaryRow(row) && row.seq > latest.envelope.replacedPrefixEndSeq);

  return [syntheticSummary, ...tail];
}

function messageParts(message: AgentRuntimeMessage): readonly unknown[] {
  if (!isRecord(message.content)) return [];
  const content = message.content.content;
  return Array.isArray(content) ? content : [];
}

function collectToolCallResultPairs(
  messages: readonly AgentRuntimeMessage[],
): AgentRuntimeToolCallResultPairBoundary[] {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();

  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    for (const part of messageParts(message)) {
      if (!isRecord(part)) continue;
      const toolUseId = typeof part.toolCallId === "string" ? part.toolCallId : null;
      if (!toolUseId) continue;

      if (part.type === "tool-call" && !calls.has(toolUseId)) {
        calls.set(toolUseId, message.seq);
      } else if (part.type === "tool-result") {
        results.set(toolUseId, Math.max(results.get(toolUseId) ?? message.seq, message.seq));
      }
    }
  }

  return Array.from(calls.entries())
    .flatMap(([toolUseId, toolCallSeq]) => {
      const toolResultSeq = results.get(toolUseId);
      if (toolResultSeq === undefined) return [];
      return [{ toolUseId, toolCallSeq, toolResultSeq, mustKeepTogether: true as const }];
    })
    .sort((a, b) => a.toolCallSeq - b.toolCallSeq || a.toolResultSeq - b.toolResultSeq);
}

function initialTailStartSeq(
  messages: readonly AgentRuntimeMessage[],
  targetTokens: number,
  fallbackStartSeq: number,
  estimateTokens: (value: unknown) => number,
): number {
  if (messages.length === 0) return fallbackStartSeq;

  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  let accumulatedTokens = 0;
  let startSeq = sorted.at(-1)?.seq ?? fallbackStartSeq;

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const message = sorted[index];
    startSeq = message.seq;
    accumulatedTokens += estimateMessageTokens(message, estimateTokens);
    if (accumulatedTokens >= targetTokens) break;
  }

  return startSeq;
}

export function computeAgentRuntimeKeepRecentTailBoundary(
  input: AgentRuntimeKeepRecentTailBoundaryInput,
): AgentRuntimeKeepRecentTailBoundary {
  const estimateTokens = input.estimateTokens ?? estimateAgentRuntimeTokens;
  const sortedMessages = input.messages
    .filter((message) => !isCompactionSummaryRow(message))
    .sort((a, b) => a.seq - b.seq);
  const fallbackStartSeq =
    input.fallbackStartSeq ?? (sortedMessages.length > 0 ? (sortedMessages.at(-1)?.seq ?? 0) + 1 : 1);
  const pairs = collectToolCallResultPairs(sortedMessages);
  const checkedPairs = new Map<string, AgentRuntimeToolCallResultPairBoundary>();
  let startSeq = initialTailStartSeq(sortedMessages, input.targetTokens, fallbackStartSeq, estimateTokens);
  let moved = true;

  while (moved) {
    moved = false;
    for (const pair of pairs) {
      if (pair.toolCallSeq < startSeq && startSeq <= pair.toolResultSeq) {
        startSeq = pair.toolCallSeq;
        checkedPairs.set(pair.toolUseId, pair);
        moved = true;
      }
    }
  }

  return {
    startSeq,
    checkedPairs: Array.from(checkedPairs.values()).sort((a, b) => a.toolCallSeq - b.toolCallSeq),
    splitsToolCallResultPair: false,
  };
}

function toSummaryTranscript(messages: readonly AgentRuntimeMessage[]): string {
  return messages
    .map((message) => {
      if (isRecord(message.content) && typeof message.content.role === "string") {
        return `${message.content.role}: ${stringifyForEstimate(message.content.content)}`;
      }
      return `${message.role}: ${stringifyForEstimate(message.content)}`;
    })
    .join("\n\n");
}

async function summarizeDroppedPrefix(params: {
  provider: AgentRuntimeProvider;
  messages: readonly AgentRuntimeMessage[];
  abortSignal?: AbortSignal;
}): Promise<string> {
  const result = await generateText({
    model: params.provider.model,
    instructions: "Summarize the following conversation preserving decisions, facts, and open threads. Be terse.",
    prompt: toSummaryTranscript(params.messages),
    abortSignal: params.abortSignal,
  });

  return result.text.trim();
}

function summaryPayload(summary: string): AgentRuntimeCompactionSummaryPayload {
  if (summary === "") {
    return { behavior: "empty_summary_pi_quirk", summary: "", testCoverage: "required" };
  }

  return { behavior: "summary", summary };
}

function createPersistedCompactionRow(params: {
  sessionId: string;
  seq: number;
  summary: string;
  replacedPrefixStartSeq: number;
  replacedPrefixEndSeq: number;
  keepRecentTail: AgentRuntimeKeepRecentTailBoundary;
  createdAt: Date;
}): AgentRuntimePersistedCompactionRow {
  return {
    id: `seq-${params.seq}`,
    session_id: params.sessionId,
    seq: params.seq,
    role: "user",
    content: {
      marker: { marker: AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER, version: 1, trigger: "auto" },
      summary: summaryPayload(params.summary),
    },
    replacedPrefixStartSeq: params.replacedPrefixStartSeq,
    replacedPrefixEndSeq: params.replacedPrefixEndSeq,
    keepRecentTail: params.keepRecentTail,
    created_at: params.createdAt.toISOString(),
  };
}

function toPersistedEnvelope(row: AgentRuntimePersistedCompactionRow): AgentRuntimeCompactionSummaryEnvelope {
  return {
    marker: row.content.marker.marker,
    version: row.content.marker.version,
    trigger: row.content.marker.trigger,
    summary: row.content.summary.summary,
    replacedPrefixStartSeq: row.replacedPrefixStartSeq,
    replacedPrefixEndSeq: row.replacedPrefixEndSeq,
    keepRecentTailStartSeq: row.keepRecentTail.startSeq,
  };
}

function effectivePersistedTailRows(
  messages: readonly AgentRuntimeMessage[],
  latest: ReturnType<typeof latestCompactionSummary>,
): AgentRuntimeMessage[] {
  const replacedPrefixEndSeq = latest?.envelope.replacedPrefixEndSeq ?? 0;
  return messages
    .filter((message) => !isCompactionSummaryRow(message) && message.seq > replacedPrefixEndSeq)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The v1 provider only compacts before ToolLoopAgent starts; mid-tool-loop compaction is intentionally out of scope.
 */
export function createDefaultAgentRuntimeCompactionProvider(
  params: DefaultAgentRuntimeCompactionProviderParams,
): AgentRuntimeCompactionProvider {
  return {
    async compact({ sessionId, messages }) {
      const reconstructed = reconstructCompactedHistory(messages);
      if (messages.length === 0) return reconstructed;

      const trigger = createAgentRuntimeCompactionTrigger({
        modelId: params.provider.modelId,
        systemPrompt: params.systemPrompt,
        history: reconstructed,
        currentUserMessage: params.currentUserMessage,
        tools: params.tools,
        thresholdFraction: params.thresholdFraction,
        contextWindowTokens: params.contextWindowTokens,
        estimateTokens: params.estimateTokens,
      });
      if (trigger.behavior === "skip") return reconstructed;

      const latest = latestCompactionSummary(messages);
      const persistedTailRows = effectivePersistedTailRows(messages, latest);
      const contextWindowTokens = params.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
      const targetTokens = Math.floor(
        contextWindowTokens * (params.keepRecentTailFraction ?? DEFAULT_KEEP_RECENT_TAIL_FRACTION),
      );
      const keepRecentTail = computeAgentRuntimeKeepRecentTailBoundary({
        messages: persistedTailRows,
        targetTokens,
        fallbackStartSeq: (latest?.envelope.replacedPrefixEndSeq ?? 0) + 1,
        estimateTokens: params.estimateTokens,
      });
      const tailSeqs = new Set(
        persistedTailRows.filter((message) => message.seq >= keepRecentTail.startSeq).map((message) => message.seq),
      );
      const droppedPrefix = reconstructed.filter((message) => !tailSeqs.has(message.seq));
      if (droppedPrefix.length === 0) return reconstructed;

      const summary = await summarizeDroppedPrefix({
        provider: params.provider,
        messages: droppedPrefix,
        abortSignal: params.abortSignal,
      });
      const replacedPrefixStartSeq =
        latest?.envelope.replacedPrefixStartSeq ?? Math.min(...droppedPrefix.map((message) => message.seq));
      const replacedPrefixEndSeq = Math.max(latest?.envelope.replacedPrefixEndSeq ?? 0, keepRecentTail.startSeq - 1);
      const markerSeq = Math.max(0, ...messages.map((message) => message.seq)) + 1;
      const persistedSummaryRow = createPersistedCompactionRow({
        sessionId,
        seq: markerSeq,
        summary,
        replacedPrefixStartSeq,
        replacedPrefixEndSeq,
        keepRecentTail,
        createdAt: params.now?.() ?? new Date(),
      });

      await params.sessionStore.appendTransactional(sessionId, [
        {
          role: "user",
          content: toPersistedEnvelope(persistedSummaryRow),
        },
      ]);

      return reconstructCompactedHistory(await params.sessionStore.load(sessionId));
    },
  };
}
