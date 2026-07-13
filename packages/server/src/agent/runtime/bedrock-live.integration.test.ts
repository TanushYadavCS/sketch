import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentMessagesRepository } from "../../db/repositories/agent-messages";
import type { DB } from "../../db/schema";
import { createTestDb, createTestLogger } from "../../test-utils";
import { runAgent } from "../runner";
import {
  AGENT_RUNTIME_COMPACTION_SUMMARY_MARKER,
  createDefaultAgentRuntimeCompactionProvider,
  reconstructCompactedHistory,
} from "./compaction";
import type { AgentRuntimeMessage } from "./contracts";
import { runAgentRuntimeCore } from "./core";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import { createAgentRuntimeProvider } from "./provider";
import { createDbAgentRuntimeSessionStore } from "./session-store";

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

const LIVE_BEDROCK_ENABLED = process.env.AGENT_RUNTIME_LIVE_BEDROCK === "1";
const BEDROCK_SMOKE_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

function missingBedrockEnv(): string[] {
  return ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((name) => !process.env[name]);
}

function bedrockRegion(): string | null {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null;
}

describe.skipIf(!LIVE_BEDROCK_ENABLED)("agent runtime Bedrock live smoke", () => {
  let db: Kysely<DB>;
  let workspaceDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    workspaceDir = await mkdtemp(join(tmpdir(), "sketch-bedrock-runtime-"));
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await db.destroy();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("runs a resumed workspace tool loop and observes a turn-2 cache hit", async () => {
    const missing = missingBedrockEnv();
    const region = bedrockRegion();
    if (!region) missing.push("AWS_REGION or AWS_DEFAULT_REGION");

    if (missing.length > 0) {
      console.log(`Skipping live Bedrock smoke: missing ${missing.join(", ")}`);
      return;
    }

    const seededFile = join(workspaceDir, "bedrock-live-notes.txt");
    await writeFile(seededFile, "Bedrock live workspace tool sentinel.\n", "utf8");
    const loadAgentRuntimeProviderConfig = vi.fn().mockResolvedValue({
      provider: "bedrock" as const,
      modelId: BEDROCK_SMOKE_MODEL_ID,
      region,
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: process.env.AWS_SESSION_TOKEN,
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    });
    const stableContext = Array.from(
      { length: 900 },
      (_, index) => `Stable cache anchor line ${index}: Sketch runtime Bedrock cache verification.`,
    ).join("\n");
    const baseParams = {
      db,
      workspaceKey: "bedrock-live-user",
      workspaceDir,
      claudeConfigDir: workspaceDir,
      userName: "Bedrock Live",
      logger: createTestLogger(),
      platform: "slack" as const,
      onProgressEvent: vi.fn().mockResolvedValue(undefined),
      agentRuntime: "aisdk" as const,
      loadAgentRuntimeProviderConfig,
      maxTurns: 3,
      agentInstructions: stableContext,
      agentAllowedTools: ["Read"],
    };
    const progressEvents: unknown[] = [];

    const turn1 = await runAgent({
      ...baseParams,
      onProgressEvent: async (event) => {
        progressEvents.push(event);
      },
      userMessage: `Use the Read tool to read ${seededFile}, then reply with exactly: workspace read ok`,
    });
    const turn2 = await runAgent({
      ...baseParams,
      userMessage: "Reply with exactly: cache hit ok",
    });
    const observedReadTool =
      turn1.rawUsage.toolCalls.some((toolCall) => toolCall.toolName === "Read") ||
      progressEvents.some(
        (event) =>
          event &&
          typeof event === "object" &&
          (event as { kind?: unknown; toolName?: unknown }).kind === "tool_use" &&
          (event as { toolName?: unknown }).toolName === "Read",
      );

    console.log(
      JSON.stringify(
        {
          model: BEDROCK_SMOKE_MODEL_ID,
          turn1SessionId: turn1.sessionId,
          turn1Text: turn1.trace.finalText,
          turn1ToolCalls: turn1.rawUsage.toolCalls.map((toolCall) => toolCall.toolName),
          turn1InputTokens: turn1.rawUsage.inputTokens,
          turn1OutputTokens: turn1.rawUsage.outputTokens,
          turn1CacheReadTokens: turn1.rawUsage.cacheReadTokens,
          turn1CacheWriteTokens: turn1.rawUsage.cacheCreationTokens,
          turn2SessionId: turn2.sessionId,
          turn2Text: turn2.trace.finalText,
          turn2InputTokens: turn2.rawUsage.inputTokens,
          turn2OutputTokens: turn2.rawUsage.outputTokens,
          turn2CacheReadTokens: turn2.rawUsage.cacheReadTokens,
          turn2CacheWriteTokens: turn2.rawUsage.cacheCreationTokens,
          turn2Resumed: turn2.rawUsage.isResumedSession,
        },
        null,
        2,
      ),
    );

    expect(turn1.trace.finalText?.trim().length ?? 0).toBeGreaterThan(0);
    expect(observedReadTool).toBe(true);
    expect(turn2.trace.finalText?.trim().length ?? 0).toBeGreaterThan(0);
    expect(turn2.sessionId).toBe(turn1.sessionId);
    expect(turn2.rawUsage.isResumedSession).toBe(true);
    expect(turn2.rawUsage.cacheReadTokens).toBeGreaterThan(0);
  }, 180_000);

  it("runs live pre-run compaction and reconstructs summary plus tail", async () => {
    const missing = missingBedrockEnv();
    const region = bedrockRegion();
    if (!region) missing.push("AWS_REGION or AWS_DEFAULT_REGION");

    if (missing.length > 0) {
      console.log(`Skipping live Bedrock compaction: missing ${missing.join(", ")}`);
      return;
    }

    const provider = createAgentRuntimeProvider({
      provider: "bedrock",
      modelId: BEDROCK_SMOKE_MODEL_ID,
      region,
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      awsSessionToken: process.env.AWS_SESSION_TOKEN,
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    });
    const sessionId = "bedrock-live-compaction-session";
    const sessionStore = createDbAgentRuntimeSessionStore(db);
    const currentUserMessage = { role: "user" as const, content: "Reply with exactly: compacted ok" };
    await sessionStore.appendTransactional(sessionId, [
      { role: "user", content: { role: "user", content: "Older user fact: alpha decision." } },
      { role: "assistant", content: { role: "assistant", content: "Older assistant answer: beta context." } },
      { role: "user", content: { role: "user", content: "Recent tail sentinel: keep this line." } },
    ]);

    const result = await runAgentRuntimeCore({
      provider,
      prompt: currentUserMessage.content,
      systemPrompt: "You are verifying Sketch runtime compaction live against Bedrock.",
      maxTurns: 1,
      persistSession: true,
      sessionId,
      sessionStore,
      cacheBreakpoints: false,
      compaction: createDefaultAgentRuntimeCompactionProvider({
        provider,
        sessionStore,
        systemPrompt: "You are verifying Sketch runtime compaction live against Bedrock.",
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

    console.log(
      JSON.stringify(
        {
          model: BEDROCK_SMOKE_MODEL_ID,
          sessionId: result.sessionId,
          finalText: result.finalText,
          markerRows: markerRows.length,
          markerSummaryLength: markerRows[0]?.content.summary.length ?? 0,
          reconstructedRows: reconstructed.length,
          reconstructedContainsSummary: reconstructedText.includes("[Prior conversation summary]"),
          reconstructedContainsTail: reconstructedText.includes("Recent tail sentinel"),
          inputTokens: result.usage.totalInputTokens,
          outputTokens: result.usage.totalOutputTokens,
        },
        null,
        2,
      ),
    );

    expect(result.finalText.trim().length).toBeGreaterThan(0);
    expect(markerRows).toHaveLength(1);
    expect(markerRows[0]?.content.summary.length ?? 0).toBeGreaterThan(0);
    expect(reconstructedText).toContain("[Prior conversation summary]");
    expect(reconstructedText).toContain("Recent tail sentinel");
  }, 180_000);
});
