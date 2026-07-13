import type { ChatRecoveryStage } from "@/components/sketch/chat-route-state";
import { useCallback, useEffect, useRef, useState } from "react";

export const WEB_CHAT_RECONCILE_INTERVAL_MS = 1_500;
export const WEB_CHAT_RECONNECT_NOTICE_MS = 2_000;
export const WEB_CHAT_PERSISTENT_ERROR_MS = 15_000;

const WEB_CHAT_RECONCILE_REQUEST_TIMEOUT_MS = 10_000;

type ReconciliationMessage = {
  id: string;
  role: string;
};

type ActiveReconciliationRequest = {
  controller: AbortController;
  generation: number;
  timeoutId: number | null;
};

export interface UseWebChatReconciliationParams<TMessage extends ReconciliationMessage> {
  conversationId: string;
  historyReady: boolean;
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  messages: TMessage[];
  hasPendingProgress: (messages: TMessage[]) => boolean;
  loadMessages: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<{ messages: TMessage[]; updatedAt: string | null }>;
  setMessages: (messages: TMessage[]) => void;
  clearError: () => void;
}

export interface WebChatReconciliationResult {
  stage: ChatRecoveryStage;
  retryNow: () => void;
  suppressError: boolean;
}

function latestUserMessageId(messages: ReconciliationMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index]?.id ?? null;
  }
  return null;
}

function containsMessage(messages: ReconciliationMessage[], messageId: string | null): boolean {
  return !messageId || messages.some((message) => message.id === messageId);
}

function isReconciliationActive<TMessage extends ReconciliationMessage>(
  params: UseWebChatReconciliationParams<TMessage>,
): boolean {
  return (
    params.historyReady &&
    (params.status === "error" || (params.status === "ready" && params.hasPendingProgress(params.messages)))
  );
}

export function useWebChatReconciliation<TMessage extends ReconciliationMessage>(
  params: UseWebChatReconciliationParams<TMessage>,
): WebChatReconciliationResult {
  const [stage, setStage] = useState<ChatRecoveryStage>("idle");
  const paramsRef = useRef(params);
  const mountedRef = useRef(true);
  const activeRequestRef = useRef<ActiveReconciliationRequest | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const persistentTimerRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(0);
  const previousConversationIdRef = useRef(params.conversationId);
  const queuedRetryRef = useRef(false);
  const reconcileRef = useRef<() => void>(() => undefined);
  paramsRef.current = params;

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current === null) return;
    window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const clearRecoveryTimers = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (persistentTimerRef.current !== null) {
      window.clearTimeout(persistentTimerRef.current);
      persistentTimerRef.current = null;
    }
  }, []);

  const clearRequestTimeout = useCallback((request: ActiveReconciliationRequest) => {
    if (request.timeoutId === null) return;
    window.clearTimeout(request.timeoutId);
    request.timeoutId = null;
  }, []);

  const abortActiveRequest = useCallback(
    (queueRetry: boolean) => {
      const request = activeRequestRef.current;
      if (!request) return false;
      if (queueRetry) queuedRetryRef.current = true;
      if (!request.controller.signal.aborted) {
        requestGenerationRef.current += 1;
        clearRequestTimeout(request);
        request.controller.abort();
      }
      return true;
    },
    [clearRequestTimeout],
  );

  const invalidateConversationRequest = useCallback(() => {
    const currentParams = paramsRef.current;
    const queueImmediateRetry = currentParams.historyReady && currentParams.status === "error";
    if (!abortActiveRequest(queueImmediateRetry)) {
      requestGenerationRef.current += 1;
    }
  }, [abortActiveRequest]);

  const schedulePoll = useCallback(
    (delayMs: number) => {
      clearPollTimer();
      pollTimerRef.current = window.setTimeout(() => {
        pollTimerRef.current = null;
        reconcileRef.current();
      }, delayMs);
    },
    [clearPollTimer],
  );

  const reconcile = useCallback(() => {
    const requestParams = paramsRef.current;
    if (!isReconciliationActive(requestParams)) return;
    if (activeRequestRef.current) {
      queuedRetryRef.current = true;
      return;
    }

    const requestConversationId = requestParams.conversationId;
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const request: ActiveReconciliationRequest = {
      controller: new AbortController(),
      generation: requestGeneration,
      timeoutId: null,
    };
    activeRequestRef.current = request;
    let adopted = false;
    let adoptedPendingProgress = false;
    request.timeoutId = window.setTimeout(() => {
      request.timeoutId = null;
      if (activeRequestRef.current === request) abortActiveRequest(false);
    }, WEB_CHAT_RECONCILE_REQUEST_TIMEOUT_MS);
    void Promise.resolve()
      .then(() => requestParams.loadMessages(requestConversationId, request.controller.signal))
      .then(({ messages }) => {
        const currentParams = paramsRef.current;
        if (
          !mountedRef.current ||
          request.controller.signal.aborted ||
          requestGenerationRef.current !== request.generation ||
          currentParams.conversationId !== requestConversationId ||
          !isReconciliationActive(currentParams)
        ) {
          return;
        }

        const latestUserId = latestUserMessageId(currentParams.messages);
        if (!containsMessage(messages, latestUserId)) return;

        currentParams.setMessages(messages);
        currentParams.clearError();
        adopted = true;
        adoptedPendingProgress = currentParams.hasPendingProgress(messages);
        clearRecoveryTimers();
        setStage("idle");
      })
      .catch(() => undefined)
      .finally(() => {
        clearRequestTimeout(request);
        if (activeRequestRef.current !== request) return;
        activeRequestRef.current = null;
        if (!mountedRef.current) return;

        const currentParams = paramsRef.current;
        if (!isReconciliationActive(currentParams)) {
          queuedRetryRef.current = false;
          clearPollTimer();
          return;
        }

        if (queuedRetryRef.current) {
          queuedRetryRef.current = false;
          reconcileRef.current();
          return;
        }

        if (currentParams.conversationId !== requestConversationId) {
          if (currentParams.status === "error") reconcileRef.current();
          return;
        }

        if (adopted) {
          if (adoptedPendingProgress) schedulePoll(WEB_CHAT_RECONCILE_INTERVAL_MS);
          return;
        }

        if (currentParams.status === "error" || currentParams.hasPendingProgress(currentParams.messages)) {
          schedulePoll(WEB_CHAT_RECONCILE_INTERVAL_MS);
        }
      });
  }, [abortActiveRequest, clearPollTimer, clearRecoveryTimers, clearRequestTimeout, schedulePoll]);
  reconcileRef.current = reconcile;

  const retryNow = useCallback(() => {
    const currentParams = paramsRef.current;
    if (!isReconciliationActive(currentParams)) return;
    clearPollTimer();
    if (abortActiveRequest(true)) return;
    reconcile();
  }, [abortActiveRequest, clearPollTimer, reconcile]);

  const active = isReconciliationActive(params);
  const conversationId = params.conversationId;

  useEffect(() => {
    if (previousConversationIdRef.current === conversationId) return;
    previousConversationIdRef.current = conversationId;
    invalidateConversationRequest();
  }, [conversationId, invalidateConversationRequest]);

  useEffect(() => {
    clearRecoveryTimers();
    if (!params.historyReady || params.status !== "error") {
      setStage("idle");
      return;
    }

    setStage("silent");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (paramsRef.current.conversationId === conversationId) setStage("reconnecting");
    }, WEB_CHAT_RECONNECT_NOTICE_MS);
    persistentTimerRef.current = window.setTimeout(() => {
      persistentTimerRef.current = null;
      if (paramsRef.current.conversationId === conversationId) setStage("persistent");
    }, WEB_CHAT_PERSISTENT_ERROR_MS);

    return clearRecoveryTimers;
  }, [clearRecoveryTimers, conversationId, params.historyReady, params.status]);

  useEffect(() => {
    clearPollTimer();
    if (!active || paramsRef.current.conversationId !== conversationId) return;
    if (params.status === "error") {
      reconcile();
    } else {
      schedulePoll(WEB_CHAT_RECONCILE_INTERVAL_MS);
    }
    return clearPollTimer;
  }, [active, clearPollTimer, conversationId, params.status, reconcile, schedulePoll]);

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    retryNow();
  }, [retryNow]);

  useEffect(() => {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", retryNow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", retryNow);
    };
  }, [handleVisibilityChange, retryNow]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queuedRetryRef.current = false;
      clearPollTimer();
      clearRecoveryTimers();
      abortActiveRequest(false);
    };
  }, [abortActiveRequest, clearPollTimer, clearRecoveryTimers]);

  return {
    stage,
    retryNow,
    suppressError: params.status === "error",
  };
}
