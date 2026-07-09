import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config as loadDotenv } from "dotenv";

const MODEL_ID = "us.anthropic.claude-sonnet-4-6";
const REPO_ENV_PATH = "/Users/rnijhara/Projects/sketch/.env";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(SCRIPT_DIR, "..");
const FIXTURES_DIR = resolve(SERVER_DIR, "src", "agent", "__fixtures__");

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface RecorderRun {
  name: string;
  fixtureFile: string;
  messages: unknown[];
  workspaceDir: string;
  handAuthored: false;
  thrownError?: {
    name: string;
    message: string;
  };
}

interface SanitizerState {
  sessionIds: Map<string, string>;
  uuids: Map<string, string>;
  toolUseIds: Map<string, string>;
  workspaceDir: string;
}

function configureBedrockEnv() {
  loadDotenv({ path: REPO_ENV_PATH, override: true, quiet: true });
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.ANTHROPIC_MODEL = MODEL_ID;
  process.env.ANTHROPIC_SMALL_FAST_MODEL = MODEL_ID;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL_ID;
  Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
  Reflect.deleteProperty(process.env, "ANTHROPIC_BASE_URL");
  Reflect.deleteProperty(process.env, "ANTHROPIC_AUTH_TOKEN");
}

function sanitizeDiagnostic(value: string): string {
  let out = value;
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    const secret = process.env[key];
    if (typeof secret === "string" && secret.length > 0) {
      out = out.split(secret).join(`<${key}>`);
    }
  }
  return out.split(homedir()).join("<HOME>").split(REPO_ENV_PATH).join("<REPO_ENV_PATH>");
}

function sdkStderr(data: string) {
  const line = sanitizeDiagnostic(data.trim());
  if (!line) return;
  console.error(JSON.stringify({ sdkStderr: line }));
}

function nextPlaceholder(map: Map<string, string>, value: string, prefix: string): string {
  const existing = map.get(value);
  if (existing) return existing;
  const next = `<${prefix}_${map.size + 1}>`;
  map.set(value, next);
  return next;
}

function collectSessionIds(value: unknown, sessionIds: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionIds(item, sessionIds);
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "session_id" && typeof nested === "string" && nested) {
      sessionIds.add(nested);
    }
    collectSessionIds(nested, sessionIds);
  }
}

function sanitizeString(value: string, state: SanitizerState): string {
  let out = value;
  out = out.split(`/private${state.workspaceDir}`).join("<WORKSPACE_DIR>");
  out = out.split(state.workspaceDir).join("<WORKSPACE_DIR>");
  out = out.split(REPO_ENV_PATH).join("<REPO_ENV_PATH>");
  out = out.split(resolve(SERVER_DIR, "..", "..")).join("<REPO_ROOT>");
  out = out.split(homedir()).join("<HOME>");
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");
  out = out.replace(/toolu_[A-Za-z0-9_-]+/g, (match) => nextPlaceholder(state.toolUseIds, match, "TOOL_USE_ID"));
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (match) => {
    if (state.sessionIds.has(match)) return state.sessionIds.get(match) ?? "<SESSION_ID_1>";
    return nextPlaceholder(state.uuids, match, "UUID");
  });
  return out;
}

function sanitizeValue(value: unknown, state: SanitizerState): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return sanitizeString(value, state);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, state));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(nested, state);
    }
    return out;
  }
  return String(value);
}

function sanitizeMessages(messages: unknown[], workspaceDir: string): JsonValue[] {
  const rawSessionIds = new Set<string>();
  for (const message of messages) collectSessionIds(message, rawSessionIds);

  const state: SanitizerState = {
    sessionIds: new Map(Array.from(rawSessionIds).map((id, index) => [id, `<SESSION_ID_${index + 1}>`])),
    uuids: new Map(),
    toolUseIds: new Map(),
    workspaceDir,
  };

  return messages.map((message) => sanitizeValue(message, state));
}

function assertNoSecretLeak(serialized: string) {
  const secretKeys = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ];
  const leakedKeys = secretKeys.filter((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.length >= 8 && serialized.includes(value);
  });

  if (leakedKeys.length > 0) {
    throw new Error(
      `Refusing to write fixture because sanitized output still contains secret values for: ${leakedKeys.join(", ")}`,
    );
  }
}

async function captureToolRun(): Promise<RecorderRun> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "sketch-sdk-tool-run-"));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 300_000);
  const prompt = [
    'Use Write with file_path exactly "sdk-fixture.txt" and content exactly: fixture-ok.',
    'Use Read with file_path exactly "sdk-fixture.txt" to read it back.',
    "Reply in four words or fewer.",
  ].join(" ");
  const messages: unknown[] = [];

  try {
    const run = query({
      prompt,
      options: {
        cwd: workspaceDir,
        model: MODEL_ID,
        maxTurns: 6,
        includePartialMessages: true,
        thinking: { type: "disabled" },
        tools: ["Write", "Read"],
        permissionMode: "default",
        settingSources: [],
        env: process.env as Record<string, string>,
        abortController,
        stderr: sdkStderr,
        canUseTool: async (_toolName, input) => ({ behavior: "allow" as const, updatedInput: input }),
      },
    });

    for await (const message of run) {
      messages.push(message);
    }

    return {
      name: "tool-stream",
      fixtureFile: "claude-agent-sdk-tool-stream.json",
      messages,
      workspaceDir,
      handAuthored: false,
    };
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function captureAbortedRun(): Promise<RecorderRun> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "sketch-sdk-abort-run-"));
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 300_000);
  const messages: unknown[] = [];
  let sawTextDelta = false;
  let thrownError: RecorderRun["thrownError"];

  try {
    const run = query({
      prompt: "Write a detailed 400 word explanation of why deterministic stream fixtures are useful.",
      options: {
        cwd: workspaceDir,
        model: MODEL_ID,
        maxTurns: 2,
        includePartialMessages: true,
        thinking: { type: "disabled" },
        tools: [],
        permissionMode: "default",
        settingSources: [],
        env: process.env as Record<string, string>,
        abortController,
        stderr: sdkStderr,
        canUseTool: async (_toolName, input) => ({ behavior: "allow" as const, updatedInput: input }),
      },
    });

    try {
      for await (const message of run) {
        messages.push(message);
        if (typeof message === "object" && message && message.type === "stream_event" && !sawTextDelta) {
          sawTextDelta = true;
          abortController.abort();
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) throw err;
      thrownError = {
        name: err instanceof Error ? err.name : "Error",
        message: sanitizeDiagnostic(err instanceof Error ? err.message : String(err)),
      };
    }

    if (!sawTextDelta) {
      throw new Error("Abort run did not reach a stream_event before aborting");
    }

    return {
      name: "aborted-stream",
      fixtureFile: "claude-agent-sdk-aborted-stream.json",
      messages,
      workspaceDir,
      handAuthored: false,
      thrownError,
    };
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function writeFixture(run: RecorderRun) {
  const sanitizedMessages = sanitizeMessages(run.messages, run.workspaceDir);
  const fixture = {
    source: "real_claude_agent_sdk_bedrock",
    recorderRunId: "<RECORDER_RUN_ID>",
    handAuthored: run.handAuthored,
    modelId: MODEL_ID,
    thrownError: run.thrownError ?? null,
    messages: sanitizedMessages,
  };
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  assertNoSecretLeak(serialized);
  await mkdir(FIXTURES_DIR, { recursive: true });
  const fixturePath = join(FIXTURES_DIR, run.fixtureFile);
  await writeFile(fixturePath, serialized, "utf-8");
  console.log(
    JSON.stringify({
      fixture: fixturePath,
      name: run.name,
      messageTypes: run.messages.map((message) =>
        typeof message === "object" && message && "type" in message
          ? (message as { type: unknown }).type
          : typeof message,
      ),
    }),
  );
}

async function main() {
  configureBedrockEnv();
  console.log(JSON.stringify({ event: "recorder-start", modelId: MODEL_ID }));
  const toolRun = await captureToolRun();
  console.log(JSON.stringify({ event: "tool-run-captured", messages: toolRun.messages.length }));
  const abortedRun = await captureAbortedRun();
  console.log(JSON.stringify({ event: "aborted-run-captured", messages: abortedRun.messages.length }));
  const runs = [toolRun, abortedRun];
  for (const run of runs) {
    await writeFixture(run);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
