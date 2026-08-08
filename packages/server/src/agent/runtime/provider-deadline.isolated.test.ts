import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRequestTimeoutError } from "./errors";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "./pricing";
import { createAgentRuntimeProvider, resolveAgentRuntimeProviderConfigFromSettings, withDeadline } from "./provider";

const providerConfig = {
  provider: "anthropic" as const,
  modelId: "claude-sonnet-4-6",
  apiKey: "sk-ant-test",
  costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
  modelRequestTimeoutMs: 100,
};

describe("agent runtime provider request deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a never-resolving transport at the deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const provider = createAgentRuntimeProvider(providerConfig, { fetch: fetchImpl });

    const request = generateText({ model: provider.model, prompt: "hello" });
    const rejected = expect(request).rejects.toBeInstanceOf(ModelRequestTimeoutError);

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("rejects a response whose SSE body trickles forever at the deadline", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
          }),
          { status: 200 },
        ),
      );
    const request = withDeadline(100, fetchImpl)("https://example.test");
    const response = await request;

    const body = response.text();
    const rejected = expect(body).rejects.toBeInstanceOf(ModelRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("composes caller cancellation with the request deadline", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const request = withDeadline(100, fetchImpl)("https://example.test", { signal: caller.signal });
    const callerRejected = expect(request).rejects.toMatchObject({ name: "AbortError" });

    caller.abort(new DOMException("user stopped", "AbortError"));

    await callerRejected;
    expect(caller.signal.aborted).toBe(true);

    const deadlineRequest = withDeadline(100, fetchImpl)("https://example.test");
    const deadlineRejected = expect(deadlineRequest).rejects.toBeInstanceOf(ModelRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await deadlineRejected;
  });

  it("threads the configured timeout through provider resolution", () => {
    const config = resolveAgentRuntimeProviderConfigFromSettings(null, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      AGENT_MODEL_REQUEST_TIMEOUT_MS: "1234",
    });

    expect(config?.modelRequestTimeoutMs).toBe(1234);
  });

  it("uses the factory deadline when the resolved config supplies it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const provider = createAgentRuntimeProvider(providerConfig, { fetch: fetchImpl });
    const request = generateText({ model: provider.model, prompt: "hello" });
    const rejected = expect(request).rejects.toBeInstanceOf(ModelRequestTimeoutError);

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
  });

  it("reports a caller abort as an abort even when the deadline also fired", async () => {
    const callerAbort = new AbortController();
    const deadlineFetch = withDeadline(100, (_input, init) => {
      callerAbort.abort();
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(init?.signal?.reason), 500);
      });
    });

    const request = deadlineFetch("https://example.invalid/v1/chat", { signal: callerAbort.signal });
    const settled = request.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(500);

    expect(await settled).not.toBeInstanceOf(ModelRequestTimeoutError);
  });
});
