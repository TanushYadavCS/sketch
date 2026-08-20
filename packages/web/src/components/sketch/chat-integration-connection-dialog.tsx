import {
  isNativeCanvasAppConnection,
  isOwnedOrPersonalAppConnection,
} from "@/components/connections/connection-status";
import { api } from "@/lib/api";
import type { IntegrationApp, IntegrationConnection } from "@sketch/shared";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatThreadIntegrationConnection, ChatThreadIntegrationConnectionStatus } from "./chat-thread";

const OAUTH_POPUP_CLOSED_GRACE_MS = 30_000;
const OAUTH_POLL_MS = 1500;

function fallbackApp(connection: ChatThreadIntegrationConnection): IntegrationApp {
  return {
    id: connection.appId,
    name: connection.appName,
    description: connection.reason ?? "",
    icon: connection.icon,
  };
}

export function ChatIntegrationConnectionFrame({
  open,
  providerId,
  connection,
  popupWindow,
  onOpenChange,
  onStatusChange,
  onConnected,
}: {
  open: boolean;
  providerId: string | null;
  connection: ChatThreadIntegrationConnection | null;
  popupWindow: Window | null;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (requestId: string, status: ChatThreadIntegrationConnectionStatus) => void;
  onConnected: (app?: IntegrationApp, connection?: IntegrationConnection) => void;
}) {
  const requestRef = useRef(0);
  const connectedRef = useRef(false);
  const activeAppRef = useRef<IntegrationApp | null>(null);
  const latestStatusRef = useRef<ChatThreadIntegrationConnectionStatus>("idle");

  useEffect(() => {
    if (!open || !connection) {
      activeAppRef.current = null;
      latestStatusRef.current = "idle";
      return;
    }

    if (connection.executionMode !== undefined && connection.executionMode !== "canvas") {
      onOpenChange(false);
      return;
    }

    if (!providerId) {
      latestStatusRef.current = "unavailable";
      onStatusChange(connection.requestId, "unavailable");
      toast.error("No integration provider is configured");
      onOpenChange(false);
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    connectedRef.current = false;
    let cancelled = false;
    let intervalId: number | null = null;
    let timeoutId: number | null = null;
    const popup = popupWindow;
    let popupClosedAt: number | null = null;

    const updateStatus = (status: ChatThreadIntegrationConnectionStatus) => {
      latestStatusRef.current = status;
      if (!cancelled) onStatusChange(connection.requestId, status);
    };

    const closeConnection = () => {
      if (!cancelled) {
        onOpenChange(false);
      }
    };

    const verifyConnected = async (app: IntegrationApp): Promise<IntegrationConnection | null> => {
      const connections = await api.mcpServers.listConnections(providerId);
      const matchingConnections = connections.filter(
        (item) => item.appId === app.id && isOwnedOrPersonalAppConnection(item),
      );
      return matchingConnections.find(isNativeCanvasAppConnection) ?? matchingConnections[0] ?? null;
    };

    const complete = (app: IntegrationApp, verifiedConnection: IntegrationConnection) => {
      if (cancelled || requestRef.current !== requestId || connectedRef.current) return;
      connectedRef.current = true;
      activeAppRef.current = app;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      updateStatus("connected");
      onConnected(app, verifiedConnection);
      toast.success(`${app.name} connected`);
      closeConnection();
    };

    const fail = (message: string) => {
      if (cancelled || requestRef.current !== requestId || connectedRef.current) return;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (popup && !popup.closed) popup.close();
      updateStatus("error");
      toast.error(message);
      closeConnection();
    };

    const startPolling = (app: IntegrationApp) => {
      const check = async () => {
        try {
          const verifiedConnection = await verifyConnected(app);
          if (verifiedConnection) {
            complete({ ...app, connectionId: verifiedConnection.id }, verifiedConnection);
            return;
          }
          if (popup?.closed) {
            popupClosedAt ??= Date.now();
            if (Date.now() - popupClosedAt >= OAUTH_POPUP_CLOSED_GRACE_MS) {
              fail("Connection was not completed. Please try again.");
            }
          } else {
            popupClosedAt = null;
          }
        } catch {
          if (!cancelled) updateStatus("connecting");
        }
      };

      intervalId = window.setInterval(() => void check(), OAUTH_POLL_MS);
      timeoutId = window.setTimeout(
        () => fail("Sketch could not verify the connection. Try again from the connection card."),
        5 * 60 * 1000,
      );
      void check();
    };

    const start = async () => {
      updateStatus("connecting");

      try {
        const app = fallbackApp(connection);
        if (cancelled || requestRef.current !== requestId) return;
        const callbackUrl = `${window.location.origin}/integrations/callback?app=${encodeURIComponent(app.id)}`;
        const result = await api.mcpServers.createConnectionIntent(providerId, app.id, callbackUrl, app);
        if (cancelled || requestRef.current !== requestId) return;
        activeAppRef.current = result.app;
        if (!popup || popup.closed) {
          fail("Sketch could not open the connection window. Allow popups and try again.");
          return;
        }
        popup.location.href = result.redirectUrl;
        startPolling(result.app);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start the connection.";
        fail(message);
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; message?: unknown } | null;
      if (data?.type === "sketch-integration-connect-error") {
        fail(typeof data.message === "string" ? data.message : "Connection was not completed. Please try again.");
        return;
      }
      if (data?.type !== "sketch-integration-connected") return;
      const current = activeAppRef.current ?? fallbackApp(connection);
      void verifyConnected(current)
        .then((verifiedConnection) => {
          if (verifiedConnection) complete({ ...current, connectionId: verifiedConnection.id }, verifiedConnection);
        })
        .catch(() => undefined);
    };

    window.addEventListener("message", onMessage);
    void start();

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
      if (intervalId !== null) window.clearInterval(intervalId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (!connectedRef.current && latestStatusRef.current === "connecting") {
        onStatusChange(connection.requestId, "idle");
      }
    };
  }, [open, providerId, connection, popupWindow, onConnected, onOpenChange, onStatusChange]);

  return null;
}
