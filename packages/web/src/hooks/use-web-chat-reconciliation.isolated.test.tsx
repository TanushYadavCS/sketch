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

  it("reconciles immediately on visibility changes during recovery", async () => {
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
