/**
 * ConnectorPicker — horizontal source pill strip and "Browse all" catalog dialog.
 * Chips filter files by connector source. Clicking an unconnected chip opens the
 * connect flow. "Browse all" shows the full catalog with manage/sync actions.
 */
import { ConnectIntegrationDialog } from "@/components/connect-integration-dialog";
import { IntegrationIcon } from "@/components/connect-integration-dialog";
import { ConnectorLogo } from "@/components/connector-logos";
import type { ConnectorConfig } from "@/lib/api";
import { api } from "@/lib/api";
import { INTEGRATIONS, type IntegrationDefinition, type IntegrationType, getIntegration } from "@/lib/integrations";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GridFourIcon,
  PlusIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export function ConnectorPicker({
  connectors,
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

  const connectedByType = new Map<string, ConnectorConfig>();
  for (const c of connectors) {
    connectedByType.set(c.connectorType, c);
  }

  const handleConnected = () => {
    onConnected();
  };

  const effectiveConnectingIntegration = forcedConnectIntegration ?? connectingIntegration;
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
          const connector = connectedByType.get(def.type);
          if (!connector) return null;
          return (
            <SourceChip
              key={def.type}
              active={sourceFilter === def.type}
              onClick={() => onSourceFilterChange(sourceFilter === def.type ? null : def.type)}
              onClear={() => onSourceFilterChange(null)}
              label={def.name}
              count={connector.fileCount ?? 0}
              color={def.color}
              connectorType={def.type}
              status={connector.syncStatus}
            />
          );
        })}

        {INTEGRATIONS.map((def) => {
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
        onConnect={(def) => {
          setShowBrowseAll(false);
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

function BrowseConnectorsDialog({
  open,
  onOpenChange,
  connectors,
  onConnect,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectors: ConnectorConfig[];
  onConnect: (def: IntegrationDefinition) => void;
  onManage: (def: IntegrationDefinition, connector: ConnectorConfig) => void;
}) {
  const connectedByType = new Map<string, ConnectorConfig>();
  for (const c of connectors) {
    connectedByType.set(c.connectorType, c);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>All connectors</DialogTitle>
          <DialogDescription>Connect external sources to sync files into your knowledge base.</DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-2">
          {INTEGRATIONS.map((def) => {
            const connector = connectedByType.get(def.type);
            return (
              <ConnectorRow
                key={def.type}
                definition={def}
                connector={connector ?? null}
                onConnect={() => onConnect(def)}
                onManage={() => {
                  if (connector) onManage(def, connector);
                }}
              />
            );
          })}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">More connectors coming soon</p>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorRow({
  definition,
  connector,
  onConnect,
  onManage,
}: {
  definition: IntegrationDefinition;
  connector: ConnectorConfig | null;
  onConnect: () => void;
  onManage: () => void;
}) {
  const queryClient = useQueryClient();
  const isConnected = !!connector;

  const syncMutation = useMutation({
    mutationFn: () => api.integrations.sync(connector?.id ?? ""),
    onSuccess: () => {
      toast.success("Sync started.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} size="sm" />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{definition.name}</p>
        <p className="text-xs text-muted-foreground">
          {isConnected ? (
            <>
              {connector.fileCount != null && `${connector.fileCount.toLocaleString()} ${definition.itemNoun}`}
              {connector.lastSyncedAt && ` · Synced ${formatRelativeTime(connector.lastSyncedAt)}`}
            </>
          ) : (
            definition.description
          )}
        </p>
      </div>

      {isConnected ? (
        <div className="flex items-center gap-1.5">
          <SyncStatusDot status={connector.syncStatus} />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => syncMutation.mutate()}
            disabled={connector.syncStatus === "syncing" || syncMutation.isPending}
          >
            <ArrowsClockwiseIcon size={14} className={connector.syncStatus === "syncing" ? "animate-spin" : ""} />
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onManage}>
            Manage
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onConnect}>
          <PlusIcon size={12} />
          Connect
        </Button>
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
