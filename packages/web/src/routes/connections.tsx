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
import { EditMcpDialog } from "@/components/connections/edit-mcp-dialog";
import { EditProviderDialog } from "@/components/connections/edit-provider-dialog";
import {
  AddEnvironmentVariableDialog,
  DeleteEnvironmentVariableDialog,
  EditEnvironmentVariableDialog,
  EnvironmentVariablesSection,
  ShareEnvironmentVariableDialog,
} from "@/components/connections/environment-variables-section";
import { IntegrationsSection } from "@/components/connections/integrations-section";
import { McpServersSection } from "@/components/connections/mcp-servers-section";
import { RemoveMcpDialog } from "@/components/connections/remove-mcp-dialog";
import { LoadingSkeleton } from "@/components/connections/shared";
import { api } from "@/lib/api";
import { PlusIcon } from "@phosphor-icons/react";
import type { AgentEnvironmentVariableRecord, IntegrationConnection, McpServerRecord } from "@sketch/shared";
import { TabButton } from "@sketch/ui/components/tab-button";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
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
    window.close();
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

export function getPersonallyConnectedAppIds(
  connections: IntegrationConnection[],
  accessSettingsEnabled = true,
): Set<string> {
  return new Set(
    connections
      .filter(
        (connection) =>
          !accessSettingsEnabled ||
          connection.source !== "canvas_user_secrets" ||
          connection.accessLevel !== "organization" ||
          connection.isOwnedByViewer !== false,
      )
      .map((connection) => connection.appId),
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ConnectionsPage() {
  const auth = useDashboardAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<IntegrationsTab>(() => {
    if (typeof window === "undefined") return "applications";
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "mcps" || tab === "environment") return tab;
    return "applications";
  });

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

  const connections = connectionsQuery.data ?? [];
  const accessSettingsEnabled = setupStatusQuery.data?.experimentalFlag === true;

  const envVarsQuery = useQuery({
    queryKey: ["agent-environment-variables"],
    queryFn: () => api.agentEnvironmentVariables.list(),
    enabled: activeTab === "environment",
  });
  const envVars = envVarsQuery.data ?? [];

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => api.users.list(),
    enabled: activeTab === "environment",
  });

  const slackChannelsQuery = useQuery({
    queryKey: ["slack-channels"],
    queryFn: () => api.channels.listSlack(),
    enabled: activeTab === "environment",
    retry: false,
  });

  const whatsappGroupsQuery = useQuery({
    queryKey: ["whatsapp-groups"],
    queryFn: () => api.channels.listWhatsAppGroups(),
    enabled: activeTab === "environment",
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
  const [showProviderSelector, setShowProviderSelector] = useState(false);
  const [showAddProvider, setShowAddProvider] = useState(false);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    queryClient.invalidateQueries({ queryKey: ["connections"] });
    queryClient.invalidateQueries({ queryKey: ["agent-environment-variables"] });
  }, [queryClient]);

  const isLoading = serversQuery.isLoading;

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Integrations</h1>
        <p className="mt-2 text-sm text-muted-foreground">Connect apps and tools to extend your workspace.</p>
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
            {!provider ? (
              <ConnectionsBanner onConnect={() => setShowProviderSelector(true)} />
            ) : (
              <>
                {connections.length > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEED01]/10 px-2.5 py-1 text-xs text-muted-foreground">
                      <span className="inline-block size-1.5 rounded-full bg-[#FEED01]" />
                      via {provider.type === "canvas" ? "Canvas" : (provider.type ?? "Provider")}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowAddIntegrationDialog(true)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <PlusIcon size={12} weight="bold" />
                      Add app
                    </button>
                  </div>
                )}
                <IntegrationsSection
                  connections={connections}
                  isLoadingConnections={connectionsQuery.isLoading}
                  onAdd={() => setShowAddIntegrationDialog(true)}
                  providerId={provider.id}
                  orgName={setupStatusQuery.data?.orgName ?? undefined}
                  accessSettingsEnabled={accessSettingsEnabled}
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
          onOpenChange={setShowAddIntegrationDialog}
          providerId={provider.id}
          connectedAppIds={getPersonallyConnectedAppIds(connections, accessSettingsEnabled)}
          onSuccess={invalidateAll}
        />
      )}
    </div>
  );
}
