import { isOwnedOrPersonalAppConnection } from "@/components/connections/connection-status";
import { api } from "@/lib/api";
import type { IntegrationApp } from "@sketch/shared";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatThreadIntegrationConnection, ChatThreadIntegrationConnectionStatus } from "./chat-thread";

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
  onOpenChange,
  onStatusChange,
  onConnected,
}: {
  open: boolean;
  providerId: string | null;
  connection: ChatThreadIntegrationConnection | null;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (requestId: string, status: ChatThreadIntegrationConnectionStatus) => void;
  onConnected: () => void;
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
    let popup: Window | null = null;

    const updateStatus = (status: ChatThreadIntegrationConnectionStatus) => {
      latestStatusRef.current = status;
      if (!cancelled) onStatusChange(connection.requestId, status);
    };

    const closeConnection = () => {
      if (!cancelled) {
        onOpenChange(false);
      }
    };

    const verifyConnected = async (app: IntegrationApp): Promise<boolean> => {
      const connections = await api.mcpServers.listConnections(providerId);
      return connections.some((item) => item.appId === app.id && isOwnedOrPersonalAppConnection(item));
    };

    const complete = (app: IntegrationApp) => {
      if (cancelled || requestRef.current !== requestId || connectedRef.current) return;
      connectedRef.current = true;
      activeAppRef.current = app;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      updateStatus("connected");
      onConnected();
      toast.success(`${app.name} connected`);
      closeConnection();
    };

    const fail = (message: string) => {
      if (cancelled || requestRef.current !== requestId || connectedRef.current) return;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      updateStatus("error");
      toast.error(message);
      closeConnection();
    };

    const startPolling = (app: IntegrationApp) => {
      const check = async () => {
        try {
          if (await verifyConnected(app)) {
            complete(app);
            return;
          }
          if (popup?.closed) {
            fail("Connection was not completed. Please try again.");
          }
        } catch {
          if (!cancelled) updateStatus("connecting");
        }
      };

      intervalId = window.setInterval(() => void check(), 1500);
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
        const callbackUrl = `${window.location.origin}/integrations/callback`;
        const result = await api.mcpServers.createConnectionIntent(providerId, app.id, callbackUrl, app);
        if (cancelled || requestRef.current !== requestId) return;
        activeAppRef.current = result.app;
        popup = window.open(result.redirectUrl, "_blank", "width=600,height=700");
        if (!popup || popup.closed) {
          fail("Sketch could not open the connection window. Allow popups and try again.");
          return;
        }
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
        .then((connected) => {
          if (connected) complete(current);
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
  }, [open, providerId, connection, onConnected, onOpenChange, onStatusChange]);

  return null;
}
