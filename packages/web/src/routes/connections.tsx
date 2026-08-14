/**
 * Integrations page -- manage MCP servers and per-user app integrations.
 *
 * Two tabs:
 *  1. Applications -- per-user OAuth integrations via a provider (MCP server with non-null type).
 *  2. MCPs -- workspace-level custom MCP servers (CRUD).
 *
 * Component implementations live in @/components/connections/*.
 */
import { ConnectionsBanner } from "@/components/connections-banner";
import { AddIntegrationDialog } from "@/components/connections/add-integration-dialog";
import { AddMcpDialog } from "@/components/connections/add-mcp-dialog";
import { AddProviderDialog, ProviderSelectorDialog } from "@/components/connections/add-provider-dialog";
import {
  isNativeCanvasAppConnection,
  isOwnedOrPersonalAppConnection,
} from "@/components/connections/connection-status";
import { ConnectorNudgeDialog, type ConnectorNudgeSuggestion } from "@/components/connections/connector-nudge-dialog";
import { EditMcpDialog } from "@/components/connections/edit-mcp-dialog";
import { EditProviderDialog } from "@/components/connections/edit-provider-dialog";
import {
  AddEnvironmentVariableDialog,
  DeleteEnvironmentVariableDialog,
  EditEnvironmentVariableDialog,
  EnvironmentVariablesSection,
  ShareEnvironmentVariableDialog,
} from "@/components/connections/environment-variables-section";
import { GithubIntegrationDialog } from "@/components/connections/github-integration-dialog";
import { IntegrationsSection } from "@/components/connections/integrations-section";
import { LinearIntegrationDialog } from "@/components/connections/linear-integration-dialog";
import { McpServersSection } from "@/components/connections/mcp-servers-section";
import { RemoveMcpDialog } from "@/components/connections/remove-mcp-dialog";
import { LoadingSkeleton } from "@/components/connections/shared";
import { QuietAddButton } from "@/components/quiet-add-button";
import { api } from "@/lib/api";
import { CheckCircleIcon, MagnifyingGlassIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import {
  type AgentEnvironmentVariableRecord,
  type CliIntegrationConnection,
  type IntegrationConnection,
  type McpServerRecord,
  managedCliIntegrationAppId,
} from "@sketch/shared";
import { Button } from "@sketch/ui/components/button";
import { TabButton } from "@sketch/ui/components/tab-button";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";
import { useDashboardAuth } from "./dashboard";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const connectionsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/integrations",
  component: ConnectionsPage,
});

export const connectionsCallbackRoute = createRoute({
  getParentRoute: () => connectionsRoute,
  path: "/callback",
  component: ConnectionsCallback,
});

function ConnectionsCallback() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const appId = integrationAppConnectFromSearch(params.get("app"));
    const error = params.get("error") ?? params.get("connect_error") ?? params.get("error_code");
    const errorMessage = error ? "Connection was not completed. Please try again." : null;
    const connectedPath = appId ? `/integrations?verify_connected=${encodeURIComponent(appId)}` : "/integrations";
    const errorPath = `/integrations?connect_error=1${appId ? `&app=${encodeURIComponent(appId)}` : ""}`;
    const embedded = window.parent && window.parent !== window;
    const popup = Boolean(window.opener);

    if (errorMessage) {
      window.parent?.postMessage(
        { type: "sketch-integration-connect-error", appId, message: errorMessage },
        window.location.origin,
      );
      window.opener?.postMessage(
        { type: "sketch-integration-connect-error", appId, message: errorMessage },
        window.location.origin,
      );
      if (embedded || popup) {
        window.close();
        return;
      }
      window.location.replace(errorPath);
      return;
    }

    window.parent?.postMessage({ type: "sketch-integration-connected", appId }, window.location.origin);
    window.opener?.postMessage({ type: "sketch-integration-connected", appId }, window.location.origin);
    if (embedded || popup) {
      window.close();
      return;
    }

    window.location.replace(connectedPath);
  }, []);

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <p className="text-sm text-muted-foreground">Connection complete. You can close this window.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

type IntegrationsTab = "applications" | "mcps" | "environment";
const INTEGRATION_APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const VERIFY_CONNECTION_GRACE_MS = 30_000;
const VERIFY_CONNECTION_POLL_MS = 1500;
const APP_NAME_OVERRIDES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gmail: "Gmail",
};

type DirectConnectState =
  | { kind: "idle" }
  | { kind: "starting"; appId: string }
  | { kind: "verifying"; appId: string }
  | { kind: "redirecting"; appId: string; appName: string }
  | { kind: "provider_missing"; appId: string }
  | { kind: "already_connected"; appId: string; appName: string }
  | { kind: "connected"; appId: string; appName?: string }
  | { kind: "error"; appId: string; message: string };

export function integrationAppSearchFromSearch(value: string | null): string | null {
  const app = value?.trim();
  return app && INTEGRATION_APP_ID_RE.test(app) ? app : null;
}

export function integrationAppConnectFromSearch(value: string | null): string | null {
  return integrationAppSearchFromSearch(value);
}

export function appNameFromId(appId: string): string {
  const override = APP_NAME_OVERRIDES[appId.trim().toLowerCase()];
  if (override) return override;
  return appId
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
}

function verificationAppFromSearch(params: URLSearchParams): string | null {
  const app = integrationAppConnectFromSearch(params.get("verify_connected"));
  if (app) return app;
  const legacyApp = params.get("connected");
  if (!legacyApp || legacyApp === "1") return null;
  return integrationAppConnectFromSearch(legacyApp);
}

function connectErrorFromSearch(params: URLSearchParams): { appId: string; message: string } | null {
  if (!params.has("connect_error")) return null;
  return {
    appId: integrationAppConnectFromSearch(params.get("app")) ?? "integration",
    message: "Connection was not completed. Please try again.",
  };
}

function removeSearchParams(paramsToRemove: string[]): void {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const param of paramsToRemove) {
    if (!params.has(param)) continue;
    params.delete(param);
    changed = true;
  }
  if (!changed) return;
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

export function getPersonallyConnectedAppIds(connections: IntegrationConnection[]): Set<string> {
  return new Set(
    connections
      .filter((connection) => isOwnedOrPersonalAppConnection(connection))
      .map((connection) => connection.appId),
  );
}

function connectionMatchesApp(connection: IntegrationConnection, appId: string): boolean {
  return connection.appId.trim().toLowerCase() === appId.trim().toLowerCase();
}

function findOwnedConnectionForApp(connections: IntegrationConnection[] | undefined, appId: string) {
  const matchingConnections = (connections ?? []).filter(
    (connection) => connectionMatchesApp(connection, appId) && isOwnedOrPersonalAppConnection(connection),
  );
  return matchingConnections.find(isNativeCanvasAppConnection) ?? matchingConnections[0] ?? null;
}

function DirectConnectPanel({
  state,
  onSearch,
  onSetupProvider,
  onDismiss,
}: {
  state: DirectConnectState;
  onSearch: (appId: string) => void;
  onSetupProvider: () => void;
  onDismiss: () => void;
}) {
  if (state.kind === "idle") return null;

  const label =
    state.kind === "redirecting" || state.kind === "already_connected" || (state.kind === "connected" && state.appName)
      ? state.appName
      : appNameFromId(state.appId);
  const isWorking = state.kind === "starting" || state.kind === "verifying" || state.kind === "redirecting";
  const isSuccess = state.kind === "connected" || state.kind === "already_connected";
  const title =
    state.kind === "starting"
      ? `Preparing ${label}`
      : state.kind === "verifying"
        ? `Checking ${label}`
        : state.kind === "redirecting"
          ? `Opening ${label}`
          : state.kind === "provider_missing"
            ? "Set up integrations first"
            : state.kind === "already_connected" || state.kind === "connected"
              ? `${label} is connected`
              : `Could not connect ${label}`;
  const description =
    state.kind === "starting"
      ? "Checking the exact app and preparing authorization."
      : state.kind === "verifying"
        ? "Confirming the connection."
        : state.kind === "redirecting"
          ? "Taking you to the authorization screen."
          : state.kind === "provider_missing"
            ? "Connect an integration provider before adding apps."
            : state.kind === "already_connected" || state.kind === "connected"
              ? "You can return to the conversation and try again."
              : state.message;

  return (
    <section className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
          {isWorking ? (
            <SpinnerGapIcon size={18} className="animate-spin text-muted-foreground" aria-hidden />
          ) : isSuccess ? (
            <CheckCircleIcon size={18} className="text-green-600" weight="fill" aria-hidden />
          ) : (
            <WarningIcon size={18} className="text-amber-600" weight="fill" aria-hidden />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      {!isWorking && (
        <div className="flex shrink-0 items-center gap-2">
          {state.kind === "provider_missing" ? (
            <Button size="sm" onClick={onSetupProvider}>
              Set up provider
            </Button>
          ) : state.kind === "error" ? (
            <Button size="sm" variant="outline" onClick={() => onSearch(state.appId)}>
              <MagnifyingGlassIcon size={14} aria-hidden />
              Search
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onDismiss}>
            Done
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ConnectionsPage() {
  const auth = useDashboardAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<IntegrationsTab>(() => {
    if (typeof window === "undefined") return "applications";
    const params = new URLSearchParams(window.location.search);
    if (integrationAppConnectFromSearch(params.get("connect"))) return "applications";
    if (integrationAppSearchFromSearch(params.get("app"))) return "applications";
    const tab = params.get("tab");
    if (tab === "mcps" || tab === "environment") return tab;
    return "applications";
  });
  const [requestedAppSearch, setRequestedAppSearch] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (params.has("connect_error")) return null;
    return integrationAppSearchFromSearch(params.get("app"));
  });
  const [requestedAppConnect, setRequestedAppConnect] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return integrationAppConnectFromSearch(new URLSearchParams(window.location.search).get("connect"));
  });
  const [verifyConnectedAppId, setVerifyConnectedAppId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return verificationAppFromSearch(new URLSearchParams(window.location.search));
  });
  const [connectError, setConnectError] = useState<{ appId: string; message: string } | null>(() => {
    if (typeof window === "undefined") return null;
    return connectErrorFromSearch(new URLSearchParams(window.location.search));
  });
  const [directConnectState, setDirectConnectState] = useState<DirectConnectState>({ kind: "idle" });
  const directConnectRequestRef = useRef<string | null>(null);
  const verifyConnectedStartedAtRef = useRef<number | null>(null);

  const serversQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.mcpServers.list(),
  });

  const setupStatusQuery = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.setup.status(),
  });

  const servers = serversQuery.data ?? [];
  const provider = servers.find((s) => s.type != null) ?? null;

  const connectionsQuery = useQuery({
    queryKey: ["connections", provider?.id],
    queryFn: () => api.mcpServers.listConnections(provider?.id ?? ""),
    enabled: !!provider,
  });

  const cliCatalogQuery = useQuery({
    queryKey: ["cli-integration-apps"],
    queryFn: () => api.cliIntegrations.list(),
    enabled: activeTab === "applications",
  });

  const cliConnectionsQuery = useQuery({
    queryKey: ["cli-integration-connections"],
    queryFn: () => api.cliIntegrations.connections(),
    enabled: activeTab === "applications",
  });

  const connections = connectionsQuery.data ?? [];
  const cliConnections = cliConnectionsQuery.data?.connections ?? [];
  const cliCatalog = useMemo(
    () =>
      (cliCatalogQuery.data?.apps ?? []).filter(
        (app): app is import("@sketch/shared").CliIntegrationCatalogApp =>
          app.executionMode === "cli" || app.executionMode === "api",
      ),
    [cliCatalogQuery.data?.apps],
  );
  const githubConnection: CliIntegrationConnection | null =
    cliConnections.find((connection) => connection.appId === "github") ?? null;
  const linearConnection: CliIntegrationConnection | null =
    cliConnections.find((connection) => connection.appId === "linear") ?? null;

  const envVarsQuery = useQuery({
    queryKey: ["agent-environment-variables"],
    queryFn: () => api.agentEnvironmentVariables.list(),
    enabled: activeTab === "environment" || activeTab === "applications",
  });
  const envVars = envVarsQuery.data ?? [];

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users.list(),
    enabled: activeTab === "environment" || activeTab === "applications",
  });

  const slackChannelsQuery = useQuery({
    queryKey: ["slack-channels"],
    queryFn: () => api.channels.listSlack(),
    enabled: activeTab === "environment" || activeTab === "applications",
    retry: false,
  });

  const whatsappGroupsQuery = useQuery({
    queryKey: ["whatsapp-groups"],
    queryFn: () => api.channels.listWhatsAppGroups(),
    enabled: activeTab === "environment" || activeTab === "applications",
  });

  const [showAddMcpDialog, setShowAddMcpDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerRecord | null>(null);
  const [editingProvider, setEditingProvider] = useState<McpServerRecord | null>(null);
  const [removingServer, setRemovingServer] = useState<McpServerRecord | null>(null);
  const [showAddEnvDialog, setShowAddEnvDialog] = useState(false);
  const [editingEnvVar, setEditingEnvVar] = useState<AgentEnvironmentVariableRecord | null>(null);
  const [deletingEnvVar, setDeletingEnvVar] = useState<AgentEnvironmentVariableRecord | null>(null);
  const [sharingEnvVar, setSharingEnvVar] = useState<AgentEnvironmentVariableRecord | null>(null);
  const [showAddIntegrationDialog, setShowAddIntegrationDialog] = useState(false);
  const [showGithubSetup, setShowGithubSetup] = useState(false);
  const [showLinearSetup, setShowLinearSetup] = useState(false);
  const [showProviderSelector, setShowProviderSelector] = useState(false);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [connectorNudge, setConnectorNudge] = useState<ConnectorNudgeSuggestion | null>(null);

  const invalidateConnections = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["connections"] });
  }, [queryClient]);

  const maybeShowConnectorNudge = useCallback(async (connection: IntegrationConnection) => {
    if (!isNativeCanvasAppConnection(connection)) return;
    try {
      const result = await api.integrations.canvasSuggestion(connection.appId, connection.id, connection.source);
      if (result.suggestion) {
        setConnectorNudge({
          ...result.suggestion,
          appName: connection.appName,
          icon: connection.icon ?? connection.app?.imgSrc,
        });
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    if (connectError) {
      setActiveTab("applications");
      setDirectConnectState({ kind: "error", appId: connectError.appId, message: connectError.message });
      removeSearchParams(["connect_error", "app"]);
      setConnectError(null);
      setRequestedAppSearch(null);
      return;
    }

    if (verifyConnectedAppId) {
      setActiveTab("applications");
      const verifyStartedAt = verifyConnectedStartedAtRef.current ?? Date.now();
      verifyConnectedStartedAtRef.current = verifyStartedAt;

      if (serversQuery.isLoading || (provider && connectionsQuery.isLoading)) {
        setDirectConnectState({ kind: "verifying", appId: verifyConnectedAppId });
        return;
      }

      if (!provider) {
        removeSearchParams(["verify_connected", "connected"]);
        setVerifyConnectedAppId(null);
        verifyConnectedStartedAtRef.current = null;
        setDirectConnectState({
          kind: "error",
          appId: verifyConnectedAppId,
          message: "Sketch could not verify the connection. Set up an integration provider and try again.",
        });
        return;
      }

      const completeVerification = (connection: IntegrationConnection) => {
        removeSearchParams(["verify_connected", "connected"]);
        setVerifyConnectedAppId(null);
        verifyConnectedStartedAtRef.current = null;
        setDirectConnectState({ kind: "connected", appId: verifyConnectedAppId, appName: connection.appName });
        toast.success(`${connection.appName} connected`);
        invalidateConnections();
        void maybeShowConnectorNudge(connection);
      };

      const failVerification = (message: string) => {
        removeSearchParams(["verify_connected", "connected"]);
        setVerifyConnectedAppId(null);
        verifyConnectedStartedAtRef.current = null;
        setDirectConnectState({
          kind: "error",
          appId: verifyConnectedAppId,
          message,
        });
      };

      const connection = findOwnedConnectionForApp(connectionsQuery.data, verifyConnectedAppId);
      if (connection) {
        completeVerification(connection);
        return;
      }

      if (Date.now() - verifyStartedAt < VERIFY_CONNECTION_GRACE_MS) {
        setDirectConnectState({ kind: "verifying", appId: verifyConnectedAppId });
        let cancelled = false;
        let timeoutId: number | undefined;
        const poll = () => {
          timeoutId = window.setTimeout(async () => {
            const result = await connectionsQuery.refetch();
            if (cancelled) return;
            const refreshedConnection = findOwnedConnectionForApp(result.data, verifyConnectedAppId);
            if (refreshedConnection) {
              completeVerification(refreshedConnection);
              return;
            }
            if (Date.now() - verifyStartedAt >= VERIFY_CONNECTION_GRACE_MS) {
              failVerification("Sketch could not verify the connection. Please try connecting again.");
              return;
            }
            setDirectConnectState({ kind: "verifying", appId: verifyConnectedAppId });
            poll();
          }, VERIFY_CONNECTION_POLL_MS);
        };
        poll();
        return () => {
          cancelled = true;
          if (timeoutId) window.clearTimeout(timeoutId);
        };
      }

      failVerification("Sketch could not verify the connection. Please try connecting again.");
      return;
    }

    if (!requestedAppSearch) return;
    setActiveTab("applications");
    const managedSearchApp = managedCliIntegrationAppId(requestedAppSearch);
    if (managedSearchApp) {
      if (cliCatalogQuery.isLoading) return;
      setShowAddIntegrationDialog(false);
      if (managedSearchApp === "linear") setShowLinearSetup(true);
      else setShowGithubSetup(true);
      setRequestedAppSearch(null);
      removeSearchParams(["app"]);
      return;
    }
    if (!provider) return;
    setShowAddIntegrationDialog(true);
    removeSearchParams(["app"]);
  }, [
    provider,
    connectError,
    verifyConnectedAppId,
    requestedAppSearch,
    serversQuery.isLoading,
    connectionsQuery.isLoading,
    connectionsQuery.data,
    connectionsQuery.refetch,
    cliCatalogQuery.isLoading,
    invalidateConnections,
    maybeShowConnectorNudge,
  ]);

  useEffect(() => {
    if (!requestedAppConnect) return;
    setActiveTab("applications");

    const managedConnectApp = managedCliIntegrationAppId(requestedAppConnect);
    if (managedConnectApp) {
      if (cliCatalogQuery.isLoading || cliConnectionsQuery.isLoading) {
        setDirectConnectState({ kind: "starting", appId: managedConnectApp });
        return;
      }
      const managedAppId = managedConnectApp;
      removeSearchParams(["connect"]);
      setRequestedAppConnect(null);
      const connection = managedAppId === "linear" ? linearConnection : githubConnection;
      if (connection?.status === "active") {
        setDirectConnectState({ kind: "already_connected", appId: managedAppId, appName: connection.appName });
      } else {
        setDirectConnectState({ kind: "idle" });
        if (managedAppId === "linear") setShowLinearSetup(true);
        else setShowGithubSetup(true);
      }
      return;
    }

    if (serversQuery.isLoading) {
      setDirectConnectState({ kind: "starting", appId: requestedAppConnect });
      return;
    }

    if (!provider) {
      removeSearchParams(["connect"]);
      setRequestedAppConnect(null);
      setDirectConnectState({ kind: "provider_missing", appId: requestedAppConnect });
      return;
    }

    if (connectionsQuery.isLoading) {
      setDirectConnectState({ kind: "starting", appId: requestedAppConnect });
      return;
    }

    const requestKey = `${provider.id}:${requestedAppConnect}`;
    if (directConnectRequestRef.current === requestKey) return;
    directConnectRequestRef.current = requestKey;
    removeSearchParams(["connect"]);

    const existingConnection = findOwnedConnectionForApp(connectionsQuery.data, requestedAppConnect);
    if (existingConnection) {
      setRequestedAppConnect(null);
      setDirectConnectState({
        kind: "already_connected",
        appId: requestedAppConnect,
        appName: existingConnection.appName,
      });
      return;
    }

    let cancelled = false;
    const appId = requestedAppConnect;
    const providerId = provider.id;
    setDirectConnectState({ kind: "starting", appId });

    async function startConnection() {
      try {
        const callbackUrl = `${window.location.origin}/integrations/callback?app=${encodeURIComponent(appId)}`;
        const result = await api.mcpServers.createConnectionIntent(providerId, appId, callbackUrl);
        if (cancelled) return;
        setDirectConnectState({ kind: "redirecting", appId: result.app.id, appName: result.app.name });
        window.location.assign(result.redirectUrl);
      } catch (err) {
        if (cancelled) return;
        setRequestedAppConnect(null);
        setDirectConnectState({
          kind: "error",
          appId,
          message: err instanceof Error ? err.message : "Sketch could not prepare this integration.",
        });
      }
    }

    void startConnection();
    return () => {
      cancelled = true;
    };
  }, [
    provider,
    requestedAppConnect,
    serversQuery.isLoading,
    connectionsQuery.isLoading,
    connectionsQuery.data,
    cliCatalogQuery.isLoading,
    cliConnectionsQuery.isLoading,
    githubConnection,
    linearConnection,
  ]);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    queryClient.invalidateQueries({ queryKey: ["connections"] });
    queryClient.invalidateQueries({ queryKey: ["agent-environment-variables"] });
    queryClient.invalidateQueries({ queryKey: ["cli-integration-apps"] });
    queryClient.invalidateQueries({ queryKey: ["cli-integration-connections"] });
  }, [queryClient]);

  const isLoading = serversQuery.isLoading;

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-[22px] font-medium text-foreground">Integrations</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Connect apps and tools to extend your workspace.</p>
      </div>

      <div className="mt-6 flex items-center gap-6 border-b border-border">
        <TabButton
          label="Applications"
          isActive={activeTab === "applications"}
          onClick={() => setActiveTab("applications")}
        />
        <TabButton label="MCPs" isActive={activeTab === "mcps"} onClick={() => setActiveTab("mcps")} />
        <TabButton
          label="Environment"
          isActive={activeTab === "environment"}
          onClick={() => setActiveTab("environment")}
        />
      </div>

      <TabContentContainer className="mt-5 space-y-8">
        {isLoading || (activeTab === "environment" && envVarsQuery.isLoading) ? (
          <LoadingSkeleton />
        ) : activeTab === "applications" ? (
          <>
            <DirectConnectPanel
              state={directConnectState}
              onSearch={(appId) => {
                setDirectConnectState({ kind: "idle" });
                setRequestedAppConnect(null);
                setRequestedAppSearch(appId);
                setShowAddIntegrationDialog(true);
              }}
              onSetupProvider={() => setShowProviderSelector(true)}
              onDismiss={() => setDirectConnectState({ kind: "idle" })}
            />
            {!provider ? (
              <ConnectionsBanner onConnect={() => setShowProviderSelector(true)} />
            ) : (
              <>
                {(connections.length > 0 || githubConnection || linearConnection) && (
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEED01]/10 px-2.5 py-1 text-xs text-muted-foreground">
                      <span className="inline-block size-1.5 rounded-full bg-[#FEED01]" />
                      via {provider.type === "canvas" ? "Canvas" : (provider.type ?? "Provider")}
                    </span>
                    <QuietAddButton
                      onClick={() => {
                        setRequestedAppConnect(null);
                        setRequestedAppSearch(null);
                        setShowAddIntegrationDialog(true);
                      }}
                    >
                      Add app
                    </QuietAddButton>
                  </div>
                )}
                <IntegrationsSection
                  connections={connections}
                  isLoadingConnections={connectionsQuery.isLoading || cliConnectionsQuery.isLoading}
                  githubConnection={githubConnection}
                  githubUsers={usersQuery.data?.users ?? []}
                  linearConnection={linearConnection}
                  linearUsers={usersQuery.data?.users ?? []}
                  linearSlackChannels={slackChannelsQuery.data?.channels ?? []}
                  linearWhatsappGroups={whatsappGroupsQuery.data?.groups ?? []}
                  linearCurrentUserId={auth.userId ?? ""}
                  linearIsAdmin={auth.role === "admin"}
                  githubSlackChannels={slackChannelsQuery.data?.channels ?? []}
                  githubWhatsappGroups={whatsappGroupsQuery.data?.groups ?? []}
                  githubCurrentUserId={auth.userId ?? ""}
                  githubIsAdmin={auth.role === "admin"}
                  onAdd={() => {
                    setRequestedAppConnect(null);
                    setRequestedAppSearch(null);
                    setShowAddIntegrationDialog(true);
                  }}
                  providerId={provider.id}
                  orgName={setupStatusQuery.data?.orgName ?? undefined}
                  onDisconnect={invalidateAll}
                />
              </>
            )}
          </>
        ) : activeTab === "mcps" ? (
          <McpServersSection
            servers={servers}
            onAdd={() => setShowAddMcpDialog(true)}
            onEdit={(server) => {
              if (server.type) {
                setEditingProvider(server);
              } else {
                setEditingServer(server);
              }
            }}
            onRemove={setRemovingServer}
            onTestConnection={async (server) => {
              try {
                const result = await api.mcpServers.testConnectionById(server.id);
                if (result.status === "ok") {
                  toast.success(`Connection OK. ${result.toolCount} tools available.`);
                } else {
                  toast.error(result.error ?? "Connection failed");
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Connection test failed");
              }
            }}
          />
        ) : (
          <EnvironmentVariablesSection
            variables={envVars}
            onAdd={() => setShowAddEnvDialog(true)}
            onEdit={setEditingEnvVar}
            onDelete={setDeletingEnvVar}
            onShare={setSharingEnvVar}
          />
        )}
      </TabContentContainer>

      <AddMcpDialog open={showAddMcpDialog} onOpenChange={setShowAddMcpDialog} onSuccess={invalidateAll} />

      <ProviderSelectorDialog
        open={showProviderSelector}
        onOpenChange={setShowProviderSelector}
        onSelectCanvas={() => {
          setShowProviderSelector(false);
          setShowAddProvider(true);
        }}
      />

      <AddProviderDialog open={showAddProvider} onOpenChange={setShowAddProvider} onSuccess={invalidateAll} />

      <EditMcpDialog
        server={editingServer}
        onOpenChange={(open) => !open && setEditingServer(null)}
        onSuccess={invalidateAll}
      />

      <EditProviderDialog
        server={editingProvider}
        onOpenChange={(open) => !open && setEditingProvider(null)}
        onSuccess={invalidateAll}
      />

      <RemoveMcpDialog
        server={removingServer}
        onOpenChange={(open) => !open && setRemovingServer(null)}
        onSuccess={invalidateAll}
      />

      <AddEnvironmentVariableDialog
        open={showAddEnvDialog}
        onOpenChange={setShowAddEnvDialog}
        onSuccess={invalidateAll}
      />

      <EditEnvironmentVariableDialog
        variable={editingEnvVar}
        onOpenChange={(open) => !open && setEditingEnvVar(null)}
        onSuccess={invalidateAll}
      />

      <DeleteEnvironmentVariableDialog
        variable={deletingEnvVar}
        onOpenChange={(open) => !open && setDeletingEnvVar(null)}
        onSuccess={invalidateAll}
      />
      <ShareEnvironmentVariableDialog
        variable={sharingEnvVar}
        users={usersQuery.data?.users ?? []}
        usersLoading={usersQuery.isLoading}
        slackChannels={slackChannelsQuery.data?.channels ?? []}
        whatsappGroups={whatsappGroupsQuery.data?.groups ?? []}
        currentUserId={auth.userId}
        isAdmin={auth.role === "admin"}
        slackChannelsLoading={slackChannelsQuery.isLoading}
        slackChannelsUnavailable={slackChannelsQuery.isError}
        whatsappGroupsLoading={whatsappGroupsQuery.isLoading}
        onOpenChange={(open) => !open && setSharingEnvVar(null)}
        onSuccess={invalidateAll}
      />

      {provider && (
        <AddIntegrationDialog
          open={showAddIntegrationDialog}
          onOpenChange={(open) => {
            setShowAddIntegrationDialog(open);
            if (!open) {
              setRequestedAppConnect(null);
              setRequestedAppSearch(null);
            }
          }}
          providerId={provider.id}
          connectedAppIds={getPersonallyConnectedAppIds(connections)}
          initialAppId={null}
          initialSearch={requestedAppSearch}
          cliCatalog={cliCatalog}
          cliConnections={cliConnections}
          onOpenGithubSetup={() => {
            setShowAddIntegrationDialog(false);
            setRequestedAppConnect(null);
            setRequestedAppSearch(null);
            setShowGithubSetup(true);
          }}
          onOpenLinearSetup={() => {
            setShowAddIntegrationDialog(false);
            setRequestedAppConnect(null);
            setRequestedAppSearch(null);
            setShowLinearSetup(true);
          }}
          onSuccess={(_app, connection) => {
            invalidateAll();
            if (connection) void maybeShowConnectorNudge(connection);
          }}
        />
      )}

      <GithubIntegrationDialog
        open={showGithubSetup}
        onOpenChange={setShowGithubSetup}
        users={usersQuery.data?.users ?? []}
        slackChannels={slackChannelsQuery.data?.channels ?? []}
        whatsappGroups={whatsappGroupsQuery.data?.groups ?? []}
        currentUserId={auth.userId ?? ""}
        isAdmin={auth.role === "admin"}
        onSuccess={invalidateAll}
      />

      <LinearIntegrationDialog
        open={showLinearSetup}
        onOpenChange={setShowLinearSetup}
        users={usersQuery.data?.users ?? []}
        slackChannels={slackChannelsQuery.data?.channels ?? []}
        whatsappGroups={whatsappGroupsQuery.data?.groups ?? []}
        currentUserId={auth.userId ?? ""}
        isAdmin={auth.role === "admin"}
        onSuccess={invalidateAll}
      />

      <ConnectorNudgeDialog
        suggestion={connectorNudge}
        onOpenChange={(open) => {
          if (!open) setConnectorNudge(null);
        }}
        onConnected={invalidateAll}
      />
    </div>
  );
}
