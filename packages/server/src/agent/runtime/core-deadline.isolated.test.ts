import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentRuntimeCore } from "./core";
import { AgentRuntimeProviderError, ModelRequestTimeoutError } from "./errors";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import { createAgentRuntimeProvider } from "./provider";

const TIMEOUT_MS = 100;

function stalledProvider(modelRequestTimeoutMs: number) {
  return createAgentRuntimeProvider(
    {
      provider: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      apiKey: "sk-test",
      baseUrl: "https://openrouter.test/api/v1",
      modelRequestTimeoutMs,
      costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    },
    {
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    },
  );
}

function runStalled(modelRequestTimeoutMs: number, abortSignal?: AbortSignal) {
  return runAgentRuntimeCore({
    provider: stalledProvider(modelRequestTimeoutMs),
    prompt: "hello",
    systemPrompt: "you are a test",
    maxTurns: 1,
    persistSession: false,
    ...(abortSignal ? { abortSignal } : {}),
  });
}

/**
 * The regression these guard is silent death: AbortSignal.timeout rejects with a message
 * containing "aborted", so a deadline that reaches isRuntimeAbortError unmarked is read as a
 * user interruption. The run would then end with stopReason "aborted" — no error raised, no
 * message posted to the user, no is_error row — which is worse than the stall it replaced.
 */
describe("agent runtime core — request deadline reaches the caller as a failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises AgentRuntimeProviderError caused by a timeout rather than reporting an abort", async () => {
    const run = runStalled(TIMEOUT_MS);
    const settled = run.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const outcome = await settled;

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;

    expect(outcome.error).toBeInstanceOf(AgentRuntimeProviderError);

    const causes: unknown[] = [];
    let current: unknown = outcome.error;
    while (current instanceof Error) {
      causes.push(current);
      current = current.cause;
    }
    expect(causes.some((cause) => cause instanceof ModelRequestTimeoutError)).toBe(true);
  });

  it("still reports a genuine caller abort as an abort, not a provider failure", async () => {
    vi.useRealTimers();
    const caller = new AbortController();
    const run = runStalled(60_000, caller.signal);
    const settled = run.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    caller.abort();
    const outcome = await settled;

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.result.stopReason).toBe("aborted");
  });
});
