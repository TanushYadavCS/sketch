import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type UseWebChatReconciliationParams,
  WEB_CHAT_PERSISTENT_ERROR_MS,
  WEB_CHAT_RECONCILE_INTERVAL_MS,
  WEB_CHAT_RECONNECT_NOTICE_MS,
  type WebChatReconciliationResult,
  useWebChatReconciliation,
} from "./use-web-chat-reconciliation";

type TestMessage = {
  id: string;
  role: string;
};

type TestParams = UseWebChatReconciliationParams<TestMessage>;

const latestUserMessage: TestMessage = { id: "user-latest", role: "user" };
const persistedPendingMessages: TestMessage[] = [latestUserMessage, { id: "assistant-pending", role: "assistant" }];
const persistedFinalMessages: TestMessage[] = [latestUserMessage, { id: "assistant-final", role: "assistant" }];
const REQUEST_TIMEOUT_MS = 10_000;

function hasPendingProgress(messages: TestMessage[]): boolean {
  return messages.at(-1)?.id === "assistant-pending";
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createParams(overrides: Partial<TestParams> = {}): TestParams {
  return {
    conversationId: "chat-alpha",
    historyReady: true,
    status: "ready",
    error: undefined,
    messages: [latestUserMessage],
    hasPendingProgress,
    loadMessages: vi.fn().mockResolvedValue({ messages: [], updatedAt: null }),
    setMessages: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

function renderReconciliation(initialParams: TestParams) {
  const result = { current: null as unknown as WebChatReconciliationResult };

  function Harness({ params }: { params: TestParams }) {
    result.current = useWebChatReconciliation(params);
    return null;
  }

  const view = render(<Harness params={initialParams} />);
  return {
    result,
    rerender: (params: TestParams) => view.rerender(<Harness params={params} />),
    unmount: view.unmount,
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimersByTime(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useWebChatReconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exports the recovery timing contract", () => {
    expect(WEB_CHAT_RECONCILE_INTERVAL_MS).toBe(1500);
    expect(WEB_CHAT_RECONNECT_NOTICE_MS).toBe(2000);
    expect(WEB_CHAT_PERSISTENT_ERROR_MS).toBe(15000);
  });

  it("immediately adopts a valid persisted transcript while recovering", async () => {
    const loadMessages = vi.fn().mockResolvedValue({
      messages: persistedPendingMessages,
      updatedAt: "2026-07-13T07:30:00.000Z",
    });
    const setMessages = vi.fn();
    const clearError = vi.fn();

    renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
        setMessages,
        clearError,
      }),
    );
    await flushAsyncWork();

    expect(loadMessages).toHaveBeenCalledWith("chat-alpha");
    expect(setMessages).toHaveBeenCalledWith(persistedPendingMessages);
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(setMessages.mock.invocationCallOrder[0]).toBeLessThan(clearError.mock.invocationCallOrder[0] ?? 0);
  });

  it("waits one reconciliation interval before polling persisted progress", async () => {
    const loadMessages = vi.fn().mockResolvedValue({
      messages: persistedPendingMessages,
      updatedAt: "2026-07-13T07:30:00.000Z",
    });
    const setMessages = vi.fn();

    renderReconciliation(
      createParams({
        messages: persistedPendingMessages,
        loadMessages,
        setMessages,
      }),
    );

    await advanceTimersByTime(WEB_CHAT_RECONCILE_INTERVAL_MS - 1);
    expect(loadMessages).not.toHaveBeenCalled();

    await advanceTimersByTime(1);
    expect(loadMessages).toHaveBeenCalledWith("chat-alpha");
    expect(setMessages).toHaveBeenCalledWith(persistedPendingMessages);
  });

  it("progresses from silent recovery to reconnecting and persistent stages", async () => {
    const transcriptWithoutLatestUser = [{ id: "user-older", role: "user" }];
    const loadMessages = vi.fn().mockResolvedValue({ messages: transcriptWithoutLatestUser, updatedAt: null });
    const { result } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
      }),
    );
    await flushAsyncWork();

    expect(result.current.stage).toBe("silent");

    await advanceTimersByTime(WEB_CHAT_RECONNECT_NOTICE_MS);
    expect(result.current.stage).toBe("reconnecting");

    await advanceTimersByTime(WEB_CHAT_PERSISTENT_ERROR_MS - WEB_CHAT_RECONNECT_NOTICE_MS);
    expect(result.current.stage).toBe("persistent");
  });

  it("does not adopt a transcript that omits the latest local user message", async () => {
    const transcriptWithoutLatestUser = [
      { id: "user-older", role: "user" },
      { id: "assistant-older", role: "assistant" },
    ];
    const loadMessages = vi.fn().mockResolvedValue({ messages: transcriptWithoutLatestUser, updatedAt: null });
    const setMessages = vi.fn();
    const clearError = vi.fn();

    renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        messages: [{ id: "user-older", role: "user" }, latestUserMessage],
        loadMessages,
        setMessages,
        clearError,
      }),
    );
    await flushAsyncWork();

    expect(setMessages).not.toHaveBeenCalledWith(transcriptWithoutLatestUser);
    expect(clearError).not.toHaveBeenCalled();
  });

  it("reconciles on visibility changes only after the document becomes visible", async () => {
    const visibilityState = vi.spyOn(document, "visibilityState", "get");
    const loadMessages = vi.fn().mockResolvedValue({ messages: [], updatedAt: null });

    renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
      }),
    );
    await flushAsyncWork();
    loadMessages.mockClear();

    visibilityState.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushAsyncWork();

    expect(loadMessages).not.toHaveBeenCalled();

    visibilityState.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flushAsyncWork();

    expect(loadMessages).toHaveBeenCalledWith("chat-alpha");
  });

  it("reconciles immediately on online events while persisted progress is active", async () => {
    const loadMessages = vi.fn().mockResolvedValue({
      messages: persistedPendingMessages,
      updatedAt: "2026-07-13T07:30:00.000Z",
    });

    renderReconciliation(
      createParams({
        messages: persistedPendingMessages,
        loadMessages,
      }),
    );

    window.dispatchEvent(new Event("online"));
    await flushAsyncWork();

    expect(loadMessages).toHaveBeenCalledWith("chat-alpha");
  });

  it("prevents overlapping reconciliation requests", async () => {
    const pendingLoad = deferred<{ messages: TestMessage[]; updatedAt: string | null }>();
    const loadMessages = vi.fn().mockReturnValue(pendingLoad.promise);
    const { result } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
      }),
    );
    await flushAsyncWork();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    result.current.retryNow();
    await advanceTimersByTime(WEB_CHAT_RECONCILE_INTERVAL_MS * 2);

    expect(loadMessages).toHaveBeenCalledTimes(1);

    pendingLoad.resolve({ messages: persistedPendingMessages, updatedAt: null });
    await flushAsyncWork();
  });

  it("rejects an in-flight response after the conversation becomes terminal", async () => {
    const pendingLoad = deferred<{ messages: TestMessage[]; updatedAt: string | null }>();
    const loadMessages = vi.fn().mockReturnValue(pendingLoad.promise);
    const setMessages = vi.fn();
    const clearError = vi.fn();
    const { result, rerender } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
        setMessages,
        clearError,
      }),
    );
    await flushAsyncWork();

    rerender(
      createParams({
        status: "ready",
        messages: persistedFinalMessages,
        loadMessages,
        setMessages,
        clearError,
      }),
    );
    pendingLoad.resolve({ messages: persistedPendingMessages, updatedAt: null });
    await flushAsyncWork();
    await advanceTimersByTime(WEB_CHAT_RECONCILE_INTERVAL_MS * 2);

    expect(setMessages).not.toHaveBeenCalledWith(persistedPendingMessages);
    expect(clearError).not.toHaveBeenCalled();
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(result.current.stage).toBe("idle");
  });

  it("resets recovery and reconciles a new conversation after the old request settles", async () => {
    const oldLoad = deferred<{ messages: TestMessage[]; updatedAt: string | null }>();
    const betaUserMessage = { id: "user-beta", role: "user" };
    const betaMessages = [betaUserMessage, { id: "assistant-beta", role: "assistant" }];
    const loadMessages = vi
      .fn()
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce({ messages: betaMessages, updatedAt: null });
    const setMessages = vi.fn();
    const clearError = vi.fn();
    const { result, rerender } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("alpha stream dropped"),
        loadMessages,
        setMessages,
        clearError,
      }),
    );
    await flushAsyncWork();
    await advanceTimersByTime(WEB_CHAT_RECONNECT_NOTICE_MS);
    expect(result.current.stage).toBe("reconnecting");

    rerender(
      createParams({
        conversationId: "chat-beta",
        status: "error",
        error: new Error("beta stream dropped"),
        messages: [betaUserMessage],
        loadMessages,
        setMessages,
        clearError,
      }),
    );
    expect(result.current.stage).toBe("silent");

    oldLoad.resolve({ messages: persistedPendingMessages, updatedAt: null });
    await flushAsyncWork();

    expect(loadMessages).toHaveBeenNthCalledWith(1, "chat-alpha");
    expect(loadMessages).toHaveBeenNthCalledWith(2, "chat-beta");
    expect(setMessages).not.toHaveBeenCalledWith(persistedPendingMessages);
    expect(setMessages).toHaveBeenCalledWith(betaMessages);
  });

  it("runs a queued manual retry immediately after the in-flight request settles", async () => {
    const pendingLoad = deferred<{ messages: TestMessage[]; updatedAt: string | null }>();
    const loadMessages = vi
      .fn()
      .mockReturnValueOnce(pendingLoad.promise)
      .mockResolvedValueOnce({ messages: persistedFinalMessages, updatedAt: null });
    const setMessages = vi.fn();
    const { result } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
        setMessages,
      }),
    );
    await flushAsyncWork();

    result.current.retryNow();
    pendingLoad.resolve({ messages: [], updatedAt: null });
    await flushAsyncWork();

    expect(loadMessages).toHaveBeenCalledTimes(2);
    expect(setMessages).toHaveBeenCalledWith(persistedFinalMessages);
  });

  it("releases a timed-out request and rejects its late result", async () => {
    const timedOutLoad = deferred<{ messages: TestMessage[]; updatedAt: string | null }>();
    const lateMessages = [latestUserMessage, { id: "assistant-late", role: "assistant" }];
    const loadMessages = vi
      .fn()
      .mockReturnValueOnce(timedOutLoad.promise)
      .mockResolvedValueOnce({ messages: persistedFinalMessages, updatedAt: null });
    const setMessages = vi.fn();
    const { result } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages,
        setMessages,
      }),
    );
    await flushAsyncWork();

    result.current.retryNow();
    await advanceTimersByTime(REQUEST_TIMEOUT_MS);

    expect(loadMessages).toHaveBeenCalledTimes(2);
    expect(setMessages).toHaveBeenCalledWith(persistedFinalMessages);

    timedOutLoad.resolve({ messages: lateMessages, updatedAt: null });
    await flushAsyncWork();

    expect(setMessages).not.toHaveBeenCalledWith(lateMessages);
  });

  it("suppresses the transport error while recovery owns its presentation", async () => {
    const { result, rerender } = renderReconciliation(
      createParams({
        status: "error",
        error: new Error("stream dropped"),
        loadMessages: vi.fn().mockResolvedValue({ messages: [], updatedAt: null }),
      }),
    );
    await flushAsyncWork();

    expect(result.current.suppressError).toBe(true);

    rerender(createParams());
    expect(result.current.suppressError).toBe(false);
  });

  it("cleans up polling timers and event listeners on unmount", async () => {
    const loadMessages = vi.fn().mockResolvedValue({
      messages: persistedPendingMessages,
      updatedAt: "2026-07-13T07:30:00.000Z",
    });
    const { unmount } = renderReconciliation(
      createParams({
        messages: persistedPendingMessages,
        loadMessages,
      }),
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await advanceTimersByTime(WEB_CHAT_PERSISTENT_ERROR_MS);

    expect(loadMessages).not.toHaveBeenCalled();
  });
});
