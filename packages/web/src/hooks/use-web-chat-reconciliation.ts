import type { ChatRecoveryStage } from "@/components/sketch/chat-route-state";
import { useCallback, useEffect, useRef, useState } from "react";

export const WEB_CHAT_RECONCILE_INTERVAL_MS = 1_500;
export const WEB_CHAT_RECONNECT_NOTICE_MS = 2_000;
export const WEB_CHAT_PERSISTENT_ERROR_MS = 15_000;

type ReconciliationMessage = {
  id: string;
  role: string;
};

export interface UseWebChatReconciliationParams<TMessage extends ReconciliationMessage> {
  conversationId: string;
  historyReady: boolean;
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  messages: TMessage[];
  hasPendingProgress: (messages: TMessage[]) => boolean;
  loadMessages: (conversationId: string) => Promise<{ messages: TMessage[]; updatedAt: string | null }>;
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

export function useWebChatReconciliation<TMessage extends ReconciliationMessage>(
  params: UseWebChatReconciliationParams<TMessage>,
): WebChatReconciliationResult {
  const [stage, setStage] = useState<ChatRecoveryStage>("idle");
  const paramsRef = useRef(params);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const persistentTimerRef = useRef<number | null>(null);
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
    if (!requestParams.historyReady || inFlightRef.current) return;

    const requestConversationId = requestParams.conversationId;
    let adopted = false;
    let adoptedPendingProgress = false;
    const request = Promise.resolve()
      .then(() => requestParams.loadMessages(requestConversationId))
      .then(({ messages }) => {
        const currentParams = paramsRef.current;
        if (!mountedRef.current || currentParams.conversationId !== requestConversationId) return;

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
        if (inFlightRef.current === request) inFlightRef.current = null;
        if (!mountedRef.current) return;

        const currentParams = paramsRef.current;
        if (!currentParams.historyReady) return;
        if (currentParams.conversationId !== requestConversationId) {
          if (currentParams.status === "error") {
            schedulePoll(0);
          } else if (currentParams.hasPendingProgress(currentParams.messages)) {
            schedulePoll(WEB_CHAT_RECONCILE_INTERVAL_MS);
          }
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

    inFlightRef.current = request;
  }, [clearRecoveryTimers, schedulePoll]);
  reconcileRef.current = reconcile;

  const retryNow = useCallback(() => {
    const currentParams = paramsRef.current;
    const active =
      currentParams.historyReady &&
      (currentParams.status === "error" || currentParams.hasPendingProgress(currentParams.messages));
    if (!active) return;
    clearPollTimer();
    reconcile();
  }, [clearPollTimer, reconcile]);

  const pendingProgress = params.historyReady && params.hasPendingProgress(params.messages);

  useEffect(() => {
    clearRecoveryTimers();
    if (!params.historyReady || params.status !== "error") {
      setStage("idle");
      return;
    }

    setStage("silent");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      setStage("reconnecting");
    }, WEB_CHAT_RECONNECT_NOTICE_MS);
    persistentTimerRef.current = window.setTimeout(() => {
      persistentTimerRef.current = null;
      setStage("persistent");
    }, WEB_CHAT_PERSISTENT_ERROR_MS);

    return clearRecoveryTimers;
  }, [clearRecoveryTimers, params.historyReady, params.status]);

  useEffect(() => {
    clearPollTimer();
    if (!params.historyReady) return;
    if (params.status === "error") {
      reconcile();
    } else if (pendingProgress) {
      schedulePoll(WEB_CHAT_RECONCILE_INTERVAL_MS);
    }
    return clearPollTimer;
  }, [clearPollTimer, params.historyReady, params.status, pendingProgress, reconcile, schedulePoll]);

  useEffect(() => {
    document.addEventListener("visibilitychange", retryNow);
    window.addEventListener("online", retryNow);
    return () => {
      document.removeEventListener("visibilitychange", retryNow);
      window.removeEventListener("online", retryNow);
    };
  }, [retryNow]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollTimer();
      clearRecoveryTimers();
    };
  }, [clearPollTimer, clearRecoveryTimers]);

  return {
    stage,
    retryNow,
    suppressError: params.status === "error",
  };
}
