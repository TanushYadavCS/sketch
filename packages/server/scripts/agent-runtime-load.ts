import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { config as loadDotenv } from "dotenv";
import type {
  AgentRuntimeMessage,
  AgentRuntimeMessageAppend,
  AgentRuntimeSessionStore,
} from "../src/agent/runtime/contracts";
import { runAgentRuntimeCore } from "../src/agent/runtime/core";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../src/agent/runtime/pricing";
import {
  createAgentRuntimeProvider,
  resolveAgentRuntimeProviderConfigFromSettings,
} from "../src/agent/runtime/provider";

const DEFAULT_LEVELS = [10, 25, 50, 100] as const;
const BEDROCK_LOAD_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
const OPENROUTER_LOAD_MODEL_ID = "deepseek/deepseek-v4-pro";
const LOAD_PROMPT = "Reply with exactly: ok";
const SYSTEM_PROMPT = "You are Sketch's runtime load verification assistant. Reply only to the user's prompt.";
const MEMORY_SAMPLE_INTERVAL_MS = 100;
const RETRY_JITTER_MS = 1_500;
type LoadProvider = "bedrock" | "openrouter";

interface RunObservation {
  latencyMs: number;
  error?: unknown;
}

interface LevelResult {
  concurrency: number;
  attempt: number;
  jitterMs: number;
  wallMs: number;
  errors: number;
  throttles: number;
  throughputPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  rssBeforeMb: number;
  rssPeakMb: number;
  rssAfterMb: number;
  marginalRssMbPerRun: number;
}

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

function loadRepoEnv(): void {
  const envPath = findEnvPath();
  if (envPath) loadDotenv({ path: envPath, override: false, quiet: true });
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function parseProvider(): LoadProvider {
  const raw = argValue("provider") ?? process.env.AGENT_RUNTIME_LOAD_PROVIDER ?? "bedrock";
  if (raw === "bedrock" || raw === "openrouter") return raw;
  throw new Error(`Unsupported load provider: ${raw}`);
}

function parseModel(provider: LoadProvider): string {
  return (
    argValue("model") ??
    process.env.AGENT_RUNTIME_LOAD_MODEL_ID ??
    (provider === "openrouter" ? OPENROUTER_LOAD_MODEL_ID : BEDROCK_LOAD_MODEL_ID)
  );
}

function parseLevels(): number[] {
  const levelsArg = process.argv.slice(2).find((arg) => arg.startsWith("--levels=") || /^\d+(?:,\d+)*$/.test(arg));
  const raw = levelsArg?.replace(/^--levels=/, "") ?? process.env.AGENT_RUNTIME_LOAD_LEVELS;
  if (!raw) return [...DEFAULT_LEVELS];

  const parsed = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (parsed.length === 0) throw new Error(`Invalid concurrency levels: ${raw}`);
  return parsed;
}

function rssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)] ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function createMemorySessionStore(): AgentRuntimeSessionStore {
  let rows: AgentRuntimeMessage[] = [];

  return {
    async load() {
      return rows;
    },
    async appendTransactional(_sessionId: string, messages: readonly AgentRuntimeMessageAppend[]) {
      const nextSeq = Math.max(0, ...rows.map((row) => row.seq)) + 1;
      rows = [
        ...rows,
        ...messages.map((message, index) => ({
          seq: nextSeq + index,
          role: message.role,
          content: message.content,
        })),
      ];
    },
    async archive() {},
  };
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return [error.name, error.message, errorText(error.cause)].filter(Boolean).join(" ");
  if (typeof error !== "object") return String(error);

  const record = error as Record<string, unknown>;
  return [
    record.name,
    record.message,
    record.code,
    record.status,
    record.statusCode,
    record.$metadata && typeof record.$metadata === "object"
      ? (record.$metadata as Record<string, unknown>).httpStatusCode
      : undefined,
    "cause" in record ? errorText(record.cause) : undefined,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String)
    .join(" ");
}

function isThrottle(error: unknown): boolean {
  return /429|throttl|rate.?limit|too many requests|quota|throughput exceeded|TooManyRequestsException/i.test(
    errorText(error),
  );
}

async function runOne(params: { provider: ReturnType<typeof createAgentRuntimeProvider>; jitterMs: number }) {
  if (params.jitterMs > 0) await sleep(Math.random() * params.jitterMs);
  const startedAt = performance.now();
  try {
    const result = await runAgentRuntimeCore({
      provider: params.provider,
      prompt: LOAD_PROMPT,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      persistSession: true,
      sessionStore: createMemorySessionStore(),
      cacheBreakpoints: false,
    });
    if ((result.finalText ?? "").trim().length === 0) {
      throw new Error("runtime returned an empty final text");
    }
    return { latencyMs: performance.now() - startedAt } satisfies RunObservation;
  } catch (error) {
    return { latencyMs: performance.now() - startedAt, error } satisfies RunObservation;
  }
}

async function runLevel(params: {
  concurrency: number;
  attempt: number;
  jitterMs: number;
  provider: ReturnType<typeof createAgentRuntimeProvider>;
}): Promise<LevelResult> {
  const rssBeforeMb = rssMb();
  let rssPeakMb = rssBeforeMb;
  const sampler = setInterval(() => {
    rssPeakMb = Math.max(rssPeakMb, rssMb());
  }, MEMORY_SAMPLE_INTERVAL_MS);

  const startedAt = performance.now();
  let observations: RunObservation[];
  try {
    observations = await Promise.all(
      Array.from({ length: params.concurrency }, () =>
        runOne({ provider: params.provider, jitterMs: params.jitterMs }),
      ),
    );
  } finally {
    clearInterval(sampler);
  }

  rssPeakMb = Math.max(rssPeakMb, rssMb());
  const wallMs = performance.now() - startedAt;
  const rssAfterMb = rssMb();
  const successfulLatencies = observations
    .filter((observation) => !observation.error)
    .map((observation) => observation.latencyMs);
  const errors = observations.filter((observation) => observation.error).length;
  const throttles = observations.filter((observation) => observation.error && isThrottle(observation.error)).length;

  return {
    concurrency: params.concurrency,
    attempt: params.attempt,
    jitterMs: params.jitterMs,
    wallMs,
    errors,
    throttles,
    throughputPerSecond: successfulLatencies.length / (wallMs / 1000),
    p50Ms: percentile(successfulLatencies, 50),
    p95Ms: percentile(successfulLatencies, 95),
    rssBeforeMb,
    rssPeakMb,
    rssAfterMb,
    marginalRssMbPerRun: (rssPeakMb - rssBeforeMb) / params.concurrency,
  };
}

function fixed(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function formatRows(rows: readonly LevelResult[]): string {
  const headers = [
    "N",
    "attempt",
    "jitterMs",
    "errors",
    "throttles",
    "errorRate",
    "wallMs",
    "throughput/s",
    "p50Ms",
    "p95Ms",
    "rssBeforeMiB",
    "rssPeakMiB",
    "rssAfterMiB",
    "marginalMiB/run",
  ];
  const body = rows.map((row) => [
    String(row.concurrency),
    String(row.attempt),
    String(row.jitterMs),
    String(row.errors),
    String(row.throttles),
    `${fixed((row.errors / row.concurrency) * 100, 2)}%`,
    fixed(row.wallMs, 0),
    fixed(row.throughputPerSecond, 2),
    fixed(row.p50Ms, 0),
    fixed(row.p95Ms, 0),
    fixed(row.rssBeforeMb, 1),
    fixed(row.rssPeakMb, 1),
    fixed(row.rssAfterMb, 1),
    fixed(row.marginalRssMbPerRun, 3),
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...body.map((row) => row[index]?.length ?? 0)));
  const formatLine = (columns: readonly string[]) =>
    columns.map((column, index) => column.padStart(widths[index] ?? column.length)).join("  ");

  return [formatLine(headers), formatLine(widths.map((width) => "-".repeat(width))), ...body.map(formatLine)].join(
    "\n",
  );
}

function createOpenRouterProviderConfig(modelId: string) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || null;
  if (!apiKey) throw new Error("OpenRouter load test requires OPENROUTER_API_KEY");

  return {
    provider: "openrouter" as const,
    modelId,
    apiKey,
    baseUrl: "https://openrouter.ai/api/v1",
    headers: {
      "X-Title": "Sketch Agent Runtime Load",
    },
    costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
  };
}

async function main(): Promise<void> {
  loadRepoEnv();

  const providerName = parseProvider();
  const modelId = parseModel(providerName);
  const config =
    providerName === "openrouter"
      ? createOpenRouterProviderConfig(modelId)
      : resolveAgentRuntimeProviderConfigFromSettings(null, process.env, DEFAULT_AGENT_RUNTIME_COST_TABLE);
  if (!config || config.provider !== providerName) {
    throw new Error("Bedrock load test requires CLAUDE_CODE_USE_BEDROCK=1 plus AWS credentials and region");
  }

  const providerConfig = { ...config, modelId };
  const provider = createAgentRuntimeProvider(providerConfig);
  const levels = parseLevels();
  const rows: LevelResult[] = [];
  const finalRows: LevelResult[] = [];
  const region = "region" in providerConfig ? (providerConfig.region ?? "n/a") : "n/a";

  console.log(
    `Agent runtime ${providerName} load: model=${providerConfig.modelId} region=${region} levels=${levels.join(",")}`,
  );

  for (const concurrency of levels) {
    const first = await runLevel({ concurrency, attempt: 1, jitterMs: 0, provider });
    rows.push(first);

    if (first.throttles > 0) {
      const retry = await runLevel({ concurrency, attempt: 2, jitterMs: RETRY_JITTER_MS, provider });
      rows.push(retry);
      finalRows.push(retry);
    } else {
      finalRows.push(first);
    }
  }

  console.log(formatRows(rows));
  console.log("SDK baseline: skipped in this harness; the safe SDK limiter baseline remains concurrency 4.");

  if (finalRows.some((row) => row.errors > 0)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
