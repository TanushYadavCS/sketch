/**
 * ConnectorPicker — horizontal source pill strip and "Browse all" catalog dialog.
 * Chips filter files by connector source. Clicking an unconnected chip opens the
 * connect flow. "Browse all" shows the full catalog with manage/sync actions.
 */
import { ConnectIntegrationDialog } from "@/components/connect-integration-dialog";
import { IntegrationIcon } from "@/components/connect-integration-dialog";
import {
  isNativeCanvasAppConnection,
  isOwnedOrPersonalAppConnection,
} from "@/components/connections/connection-status";
import { ConnectorLogo } from "@/components/connector-logos";
import type { ConnectorConfig } from "@/lib/api";
import { api } from "@/lib/api";
import { INTEGRATIONS, type IntegrationDefinition, type IntegrationType, getIntegration } from "@/lib/integrations";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  type IntegrationConnection,
  PERSONAL_CANVAS_CONNECTOR_MAPPINGS,
  personalCanvasConnectorTypeFromAppId,
} from "@sketch/shared";

// These are single org-wide credential rows. Per-user connectors are handled in
// Browse all with one account row per visible user-owned connector.
const ORG_LEVEL_INTEGRATIONS = INTEGRATIONS.filter((def) => !def.perUserAuth);

const SYNC_STATUS_PRECEDENCE: Record<string, number> = {
  error: 4,
  syncing: 3,
  pending: 2,
  active: 1,
  paused: 0,
  disabled: 0,
};
function mergeStatus(a: string, b: string): string {
  return (SYNC_STATUS_PRECEDENCE[a] ?? 0) >= (SYNC_STATUS_PRECEDENCE[b] ?? 0) ? a : b;
}

function preferredConnectorForDefinition(
  def: IntegrationDefinition,
  connectors: ConnectorConfig[],
): ConnectorConfig | null {
  const matches = connectors.filter((connector) => connector.connectorType === def.type);
  if (matches.length === 0) return null;
  return matches.find((connector) => connector.canManage === true) ?? matches[0] ?? null;
}

function connectorsForDefinition(def: IntegrationDefinition, connectors: ConnectorConfig[]): ConnectorConfig[] {
  return connectors.filter((connector) => connector.connectorType === def.type);
}

function connectorOwnerLabel(connector: ConnectorConfig): string {
  if (connector.isOwner === true) return "You";
  return connector.createdByName?.trim() || connector.createdByEmail?.trim() || "Team member";
}

function connectorAccountHint(connector: ConnectorConfig): string | null {
  const hint = connector.credentialHint?.trim();
  const email = connector.createdByEmail?.trim();
  const label = connectorOwnerLabel(connector);
  if (hint && hint !== label) return hint;
  if (email && email !== label) return email;
  return null;
}

function sortConnectorsForDisplay(connectors: ConnectorConfig[]): ConnectorConfig[] {
  return [...connectors].sort((a, b) => {
    if (a.canManage === true && b.canManage !== true) return -1;
    if (a.canManage !== true && b.canManage === true) return 1;
    return connectorOwnerLabel(a).localeCompare(connectorOwnerLabel(b));
  });
}

function connectorAdoptionSummary(connectedMemberCount: number, teamMemberCount: number): string {
  const denominator = Math.max(teamMemberCount, connectedMemberCount);
  const memberLabel = denominator === 1 ? "member" : "members";
  return `${connectedMemberCount.toLocaleString()} of ${denominator.toLocaleString()} ${memberLabel} connected`;
}

const PERSONAL_CANVAS_CONNECTOR_TYPES = new Set<IntegrationType>(
  PERSONAL_CANVAS_CONNECTOR_MAPPINGS.map((mapping) => mapping.connectorType as IntegrationType),
);

function canResolveNativeCanvasConnection(definition: IntegrationDefinition | null): boolean {
  return !!definition && definition.perUserAuth && PERSONAL_CANVAS_CONNECTOR_TYPES.has(definition.type);
}

function nativeCanvasConnectionForIntegration(
  definition: IntegrationDefinition,
  connections: IntegrationConnection[],
): IntegrationConnection | null {
  return (
    connections.find(
      (connection) =>
        connection.status === "active" &&
        isNativeCanvasAppConnection(connection) &&
        isOwnedOrPersonalAppConnection(connection) &&
        personalCanvasConnectorTypeFromAppId(connection.appId) === definition.type,
    ) ?? null
  );
}
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  EyeIcon,
  EyeSlashIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GridFourIcon,
  PlusIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Switch } from "@sketch/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const SYNC_INTERVAL_OPTIONS = [
  { value: 5, label: "Every 5 minutes" },
  { value: 15, label: "Every 15 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 120, label: "Every 2 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" },
];

export function ConnectorPicker({
  connectors,
  teamMemberCount,
  connectorMemberCounts,
  sourceCounts,
  totalFiles,
  localFileCount,
  sourceFilter,
  onSourceFilterChange,
  onConnected,
  onManageConnector,
  forcedConnectIntegration,
  onForcedConnectDone,
}: {
  connectors: ConnectorConfig[];
  teamMemberCount: number;
  connectorMemberCounts: Record<string, number>;
  /** Viewer-aware file count by source. Source of truth for chip counts. */
  sourceCounts: Map<string, number>;
  totalFiles: number;
  localFileCount: number;
  sourceFilter: string | null;
  onSourceFilterChange: (value: string | null) => void;
  onConnected: () => void;
  /** Called when user clicks Manage on a connected connector (from BrowseAll). */
  onManageConnector?: (def: IntegrationDefinition, connector: ConnectorConfig) => void;
  /** If set, opens the connect dialog for this integration immediately. */
  forcedConnectIntegration?: IntegrationDefinition | null;
  /** Called after the forced connect dialog is closed. */
  onForcedConnectDone?: () => void;
}) {
  const [connectingIntegration, setConnectingIntegration] = useState<IntegrationDefinition | null>(null);
  const [showBrowseAll, setShowBrowseAll] = useState(false);
  const auth = useDashboardAuth();
  const isAdmin = auth.role === "admin";

  const connectedByType = new Map<string, ConnectorConfig>();
  // aggregatedByType drives sync-status indicator on the chip (which is
  // connector-row data). Chip *counts* read from `sourceCounts` so a member with
  // file-access via meetings whose connector row they can't see still sees a
  // count that matches the file list.
  const aggregatedByType = new Map<string, { syncStatus: string }>();
  for (const c of connectors) {
    const def = getIntegration(c.connectorType as IntegrationType);
    if (!def || preferredConnectorForDefinition(def, connectors) === c) connectedByType.set(c.connectorType, c);
    const cur = aggregatedByType.get(c.connectorType);
    aggregatedByType.set(c.connectorType, {
      syncStatus: cur ? mergeStatus(cur.syncStatus, c.syncStatus) : c.syncStatus,
    });
  }

  const handleConnected = () => {
    onConnected();
  };

  const effectiveConnectingIntegration = forcedConnectIntegration ?? connectingIntegration;
  const shouldResolveNativeCanvasConnection = canResolveNativeCanvasConnection(effectiveConnectingIntegration);
  const integrationProvidersQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.mcpServers.list(),
    enabled: shouldResolveNativeCanvasConnection,
  });
  const canvasProvider = integrationProvidersQuery.data?.find((server) => server.type === "canvas") ?? null;
  const canvasConnectionsQuery = useQuery({
    queryKey: ["connections", canvasProvider?.id],
    queryFn: () => api.mcpServers.listConnections(canvasProvider?.id ?? ""),
    enabled: shouldResolveNativeCanvasConnection && !!canvasProvider,
  });
  const nativeCanvasConnection =
    effectiveConnectingIntegration && canvasConnectionsQuery.data
      ? nativeCanvasConnectionForIntegration(effectiveConnectingIntegration, canvasConnectionsQuery.data)
      : null;
  const canvasConnectionLookupPending =
    shouldResolveNativeCanvasConnection &&
    (integrationProvidersQuery.isLoading || (!!canvasProvider && canvasConnectionsQuery.isLoading));

  const handleConnectDialogClose = (open: boolean) => {
    if (!open) {
      if (forcedConnectIntegration && onForcedConnectDone) {
        onForcedConnectDone();
      } else {
        setConnectingIntegration(null);
      }
    }
  };

  return (
    <>
      <div className="mt-5 flex items-center gap-1.5 flex-wrap">
        <SourceChip
          active={!sourceFilter}
          onClick={() => onSourceFilterChange(null)}
          label="All"
          count={totalFiles}
          icon={<FileTextIcon size={12} />}
        />

        <SourceChip
          active={sourceFilter === "local"}
          onClick={() => onSourceFilterChange(sourceFilter === "local" ? null : "local")}
          onClear={() => onSourceFilterChange(null)}
          label="Local"
          count={localFileCount}
          icon={<FolderSimpleIcon size={12} />}
        />

        {INTEGRATIONS.map((def) => {
          const agg = aggregatedByType.get(def.type);
          const count = sourceCounts.get(def.type) ?? 0;
          // Render if the viewer either owns/can see a connector row of this
          // type (status info available), or has file-access to indexed files
          // of this source (count > 0). Skip otherwise.
          if (!agg && count === 0) return null;
          return (
            <SourceChip
              key={def.type}
              active={sourceFilter === def.type}
              onClick={() => onSourceFilterChange(sourceFilter === def.type ? null : def.type)}
              onClear={() => onSourceFilterChange(null)}
              label={def.name}
              count={count}
              color={def.color}
              connectorType={def.type}
              status={agg?.syncStatus}
            />
          );
        })}

        {isAdmin &&
          ORG_LEVEL_INTEGRATIONS.map((def) => {
            if (connectedByType.has(def.type)) return null;
            return (
              <button
                key={def.type}
                type="button"
                onClick={() => setConnectingIntegration(def)}
                className="flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/30 hover:text-foreground"
              >
                <PlusIcon size={10} />
                <ConnectorLogo type={def.type} size={10} />
                {def.name}
              </button>
            );
          })}

        <button
          type="button"
          onClick={() => setShowBrowseAll(true)}
          className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          <GridFourIcon size={12} />
          Browse all
        </button>
      </div>

      <BrowseConnectorsDialog
        open={showBrowseAll}
        onOpenChange={setShowBrowseAll}
        connectors={connectors}
        teamMemberCount={teamMemberCount}
        connectorMemberCounts={connectorMemberCounts}
        isAdmin={isAdmin}
        onConnect={(def) => {
          setShowBrowseAll(false);
          // All connectors — per-user (Fireflies, Drive) and org-wide (ClickUp,
          // Notion, Linear) — use the same workspace-level connect dialog. Settings
          // → My Connections lists/manages already-connected per-user rows but no
          // longer hosts the add UI.
          setConnectingIntegration(def);
        }}
        onManage={(def, connector) => {
          setShowBrowseAll(false);
          if (onManageConnector) onManageConnector(def, connector);
        }}
      />

      <ConnectIntegrationDialog
        integration={effectiveConnectingIntegration}
        open={!!effectiveConnectingIntegration}
        onOpenChange={handleConnectDialogClose}
        onConnected={handleConnected}
        preferCanvasCredentialSource={!!nativeCanvasConnection}
        canvasConnectionReady={!!nativeCanvasConnection}
        canvasAccountId={nativeCanvasConnection?.id ?? null}
        canvasConnectionLookupPending={canvasConnectionLookupPending}
      />
    </>
  );
}

function SourceChip({
  active,
  onClick,
  onClear,
  label,
  count,
  icon,
  color,
  connectorType,
  status,
}: {
  active: boolean;
  onClick: () => void;
  onClear?: () => void;
  label: string;
  count: number;
  icon?: React.ReactNode;
  color?: string;
  connectorType?: string;
  status?: string;
}) {
  const logo = connectorType ? <ConnectorLogo type={connectorType} size={12} style={{ color }} /> : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-primary/40 bg-primary/5 text-foreground ring-1 ring-primary/20"
          : "border-border bg-card text-foreground hover:bg-muted/30"
      }`}
    >
      {icon || logo || <span className="inline-block size-2 rounded-sm" style={{ backgroundColor: color }} />}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{count.toLocaleString()}</span>
      {status && <SyncStatusDot status={status} />}
      {active && onClear && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <XIcon size={10} />
        </button>
      )}
    </button>
  );
}

export function SyncStatusDot({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <CheckCircleIcon size={10} className="text-success" weight="fill" />;
    case "syncing":
      return <CircleNotchIcon size={10} className="animate-spin text-primary" />;
    case "error":
      return <WarningCircleIcon size={10} className="text-destructive" weight="fill" />;
    default:
      return null;
  }
}

type BrowseTab = "connectors" | "settings";

function BrowseConnectorsDialog({
  open,
  onOpenChange,
  connectors,
  teamMemberCount,
  connectorMemberCounts,
  isAdmin,
  onConnect,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorConfig[];
  teamMemberCount: number;
  connectorMemberCounts: Record<string, number>;
  isAdmin: boolean;
  onConnect: (def: IntegrationDefinition) => void;
  onManage: (def: IntegrationDefinition, connector: ConnectorConfig) => void;
}) {
  const [tab, setTab] = useState<BrowseTab>("connectors");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setTab("connectors");
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>All connectors</DialogTitle>
          <DialogDescription>Connect external sources to sync files into your knowledge base.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border">
          <button
            type="button"
            onClick={() => setTab("connectors")}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              tab === "connectors"
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Connectors
          </button>
          <button
            type="button"
            onClick={() => setTab("settings")}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              tab === "settings"
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Settings
          </button>
        </div>

        {tab === "connectors" ? (
          <div className="-mr-1 min-h-0 overflow-y-auto pr-1">
            <div className="space-y-2">
              {INTEGRATIONS.map((def) => {
                const matchingConnectors = connectorsForDefinition(def, connectors);
                const connector = preferredConnectorForDefinition(def, matchingConnectors);
                return (
                  <ConnectorRow
                    key={def.type}
                    definition={def}
                    connector={connector}
                    visibleConnectors={matchingConnectors}
                    teamMemberCount={teamMemberCount}
                    connectedMemberCount={connectorMemberCounts[def.type] ?? matchingConnectors.length}
                    isAdmin={isAdmin}
                    onConnect={() => onConnect(def)}
                    onManage={(selectedConnector) => {
                      onManage(def, selectedConnector);
                    }}
                  />
                );
              })}
            </div>
            <p className="mt-4 text-center text-xs text-muted-foreground">More connectors coming soon</p>
          </div>
        ) : (
          <div className="-mr-1 min-h-0 overflow-y-auto pr-1">
            <ConnectorSettings />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectorSettings() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["settings", "search"],
    queryFn: () => api.settings.searchConfig(),
  });

  const [syncInterval, setSyncInterval] = useState(30);
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(true);
  const [geminiKey, setGeminiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setSyncInterval(data.syncIntervalMinutes);
      setEnrichmentEnabled(data.enrichmentEnabled === 1);
      setKeyConfigured(data.geminiApiKeyConfigured);
      setGeminiKey("");
      setDirty(false);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (updates: {
      syncIntervalMinutes?: number;
      enrichmentEnabled?: boolean;
      geminiApiKey?: string | null;
    }) => api.settings.updateSearchConfig(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "search"] });
      setDirty(false);
      toast.success("Settings saved");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSave() {
    const updates: { syncIntervalMinutes?: number; enrichmentEnabled?: boolean; geminiApiKey?: string | null } = {};
    if (syncInterval !== data?.syncIntervalMinutes) updates.syncIntervalMinutes = syncInterval;
    if (enrichmentEnabled !== (data?.enrichmentEnabled === 1)) updates.enrichmentEnabled = enrichmentEnabled;
    if (geminiKey.trim()) updates.geminiApiKey = geminiKey.trim();
    mutation.mutate(updates);
  }

  const needsKey = enrichmentEnabled && !keyConfigured && !geminiKey.trim();

  return (
    <div className="mt-2 space-y-4">
      {/* Sync frequency */}
      <div className="rounded-lg border border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="sync-interval" className="text-sm font-medium">
            Sync frequency
          </Label>
          <Select
            value={String(syncInterval)}
            onValueChange={(v) => {
              setSyncInterval(Number(v));
              setDirty(true);
            }}
          >
            <SelectTrigger id="sync-interval" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SYNC_INTERVAL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">How often all connectors sync, followed by enrichment</p>
      </div>

      {/* AI Enrichment */}
      <div className="rounded-lg border border-border p-3 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="enrichment-toggle" className="text-sm font-medium">
              AI Enrichment
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enrichmentEnabled
                ? "Files are tagged, summarized & embedded for semantic search"
                : "Search uses keyword matching only (FTS5)"}
            </p>
          </div>
          <Switch
            id="enrichment-toggle"
            checked={enrichmentEnabled}
            onCheckedChange={(checked) => {
              setEnrichmentEnabled(checked);
              setDirty(true);
            }}
          />
        </div>

        {enrichmentEnabled && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <Label htmlFor="gemini-key" className="text-xs">
              Gemini API Key
            </Label>
            <div className="relative">
              <Input
                id="gemini-key"
                type={showKey ? "text" : "password"}
                value={geminiKey}
                onChange={(e) => {
                  setGeminiKey(e.target.value);
                  setDirty(true);
                }}
                placeholder={keyConfigured ? "Key configured (enter new to replace)" : "AIza..."}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Used for generating vector embeddings.{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 underline hover:text-foreground"
              >
                Get API key
                <ArrowSquareOutIcon size={12} />
              </a>
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!dirty || mutation.isPending || needsKey} size="sm">
          {mutation.isPending && <SpinnerGapIcon size={14} className="mr-1.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function ConnectorRow({
  definition,
  connector,
  visibleConnectors,
  teamMemberCount,
  connectedMemberCount,
  isAdmin,
  onConnect,
  onManage,
}: {
  definition: IntegrationDefinition;
  connector: ConnectorConfig | null;
  visibleConnectors: ConnectorConfig[];
  teamMemberCount: number;
  connectedMemberCount: number;
  isAdmin: boolean;
  onConnect: () => void;
  onManage: (connector: ConnectorConfig) => void;
}) {
  const queryClient = useQueryClient();
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const isConnected = !!connector;
  const isSyncing = connector?.syncStatus === "syncing";
  const canManage = connector?.canManage === true;
  const canSync = connector?.canSync === true;
  const canConnect = definition.perUserAuth || isAdmin;
  const onlyOtherPerUserConnectors = definition.perUserAuth && isConnected && !canManage;
  const connectedAccounts = definition.perUserAuth ? sortConnectorsForDisplay(visibleConnectors) : [];
  const showConnectedAccounts = accountsExpanded && connectedAccounts.length > 0;
  const adoptionSummary = definition.perUserAuth
    ? connectorAdoptionSummary(connectedMemberCount, teamMemberCount)
    : null;
  const accountListId = `${definition.type}-connected-accounts`;

  const syncMutation = useMutation({
    mutationFn: () => api.integrations.sync(connector?.id ?? ""),
    onSuccess: () => {
      toast.success("Sync started.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["sync-progress"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Poll progress while syncing
  const { data: progressData } = useQuery({
    queryKey: ["sync-progress"],
    queryFn: () => api.integrations.progress(),
    refetchInterval: isSyncing ? 2000 : false,
    enabled: isSyncing,
  });

  const myProgress = progressData?.active.find((p) => p.connectorId === connector?.id);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} size="sm" />

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{definition.name}</p>
            <p className="text-xs text-muted-foreground">
              {definition.perUserAuth ? (
                definition.description
              ) : isSyncing && myProgress ? (
                <>
                  Syncing — {myProgress.itemsProcessed} items processed
                  {myProgress.itemsCreated > 0 && `, ${myProgress.itemsCreated} new`}
                  {myProgress.itemsSkipped > 0 && `, ${myProgress.itemsSkipped} unchanged`}
                </>
              ) : isConnected ? (
                <>
                  {connector.fileCount != null && `${connector.fileCount.toLocaleString()} ${definition.itemNoun}`}
                  {connector.lastSyncedAt && ` · Synced ${formatRelativeTime(connector.lastSyncedAt)}`}
                </>
              ) : (
                definition.description
              )}
            </p>
          </div>
        </div>

        {isConnected ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:shrink-0">
            <SyncStatusDot status={connector.syncStatus} />
            {canSync && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => syncMutation.mutate()}
                disabled={isSyncing || syncMutation.isPending}
              >
                <ArrowsClockwiseIcon size={14} className={isSyncing ? "animate-spin" : ""} />
              </Button>
            )}
            {onlyOtherPerUserConnectors && (
              <Button variant="outline" size="sm" className="h-7 gap-1.5 whitespace-nowrap text-xs" onClick={onConnect}>
                <PlusIcon size={12} />
                Connect mine
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 whitespace-nowrap text-xs"
              aria-controls={definition.perUserAuth ? accountListId : undefined}
              aria-expanded={definition.perUserAuth ? accountsExpanded : undefined}
              onClick={() => {
                if (definition.perUserAuth) {
                  setAccountsExpanded((expanded) => !expanded);
                  return;
                }
                onManage(connector);
              }}
            >
              {definition.perUserAuth ? "Manage" : canManage ? "Manage" : "View"}
            </Button>
          </div>
        ) : canConnect ? (
          <div className="flex items-center justify-end gap-2 self-end sm:self-auto sm:shrink-0">
            <Button variant="outline" size="sm" className="h-7 whitespace-nowrap text-xs" onClick={onConnect}>
              <PlusIcon size={12} />
              Connect
            </Button>
          </div>
        ) : (
          <span className="self-end whitespace-nowrap text-xs text-muted-foreground sm:self-auto sm:shrink-0">
            Managed by admin
          </span>
        )}
      </div>

      {showConnectedAccounts && (
        <div id={accountListId} className="mt-3 space-y-1 border-t border-border pt-2">
          {adoptionSummary && (
            <div className="flex items-center justify-between gap-3 px-2 pb-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Connected accounts
              </p>
              <p className="shrink-0 text-[11px] text-muted-foreground">{adoptionSummary}</p>
            </div>
          )}
          {connectedAccounts.map((account) => {
            const label = connectorOwnerLabel(account);
            const hint = connectorAccountHint(account);
            const actionLabel = account.canManage === true ? "Manage" : "View";
            return (
              <div
                key={account.id}
                className="flex min-w-0 flex-col gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-muted/30 sm:min-h-8 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <SyncStatusDot status={account.syncStatus} />
                  <span className="min-w-0 max-w-[8rem] shrink-0 truncate font-medium sm:max-w-[10rem]">{label}</span>
                  {hint && <span className="min-w-0 flex-1 truncate text-muted-foreground">{hint}</span>}
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 sm:shrink-0 sm:justify-end">
                  {account.fileCount != null && (
                    <span className="min-w-0 truncate text-muted-foreground sm:whitespace-nowrap">
                      {account.fileCount.toLocaleString()} {definition.itemNoun}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    aria-label={`${actionLabel} ${label}`}
                    onClick={() => onManage(account)}
                  >
                    {actionLabel}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
