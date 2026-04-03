import { IntegrationIcon } from "@/components/connect-integration-dialog";
/**
 * ManageConnectorDialog — status summary, sync scope configuration, credential
 * update, and disconnect flow for a connected integration.
 *
 * Google Drive gets a drive/folder picker. Other connectors show a generic
 * read-only scope display. Disconnect triggers a confirmation alert dialog.
 */
import { GenericScopeEditor } from "@/components/scope-picker";
import type { ConnectorConfig } from "@/lib/api";
import { api } from "@/lib/api";
import type { IntegrationDefinition } from "@/lib/integrations";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function ManageConnectorDialog({
  definition,
  connector,
  open,
  onOpenChange,
  onDisconnected,
  onReconnect,
}: {
  definition: IntegrationDefinition | null;
  connector: ConnectorConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
  onReconnect: (def: IntegrationDefinition) => void;
}) {
  const queryClient = useQueryClient();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [deleteEntities, setDeleteEntities] = useState(false);
  const [isBrowsingScope, setIsBrowsingScope] = useState(false);

  // Reset checkbox when dialog closes
  useEffect(() => {
    if (!showDisconnectConfirm) setDeleteEntities(false);
  }, [showDisconnectConfirm]);

  // Fetch entity count when disconnect confirmation opens
  const { data: entityCountData } = useQuery({
    queryKey: ["connector-entity-count", connector?.id],
    queryFn: () => api.integrations.entityCount(connector?.id ?? ""),
    enabled: showDisconnectConfirm && !!connector?.id,
  });
  const entityCount = entityCountData?.count ?? 0;

  const syncMutation = useMutation({
    mutationFn: () => api.integrations.sync(connector?.id ?? ""),
    onSuccess: () => {
      toast.success("Sync started.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.integrations.disconnect(connector?.id ?? "", { deleteEntities }),
    onSuccess: () => {
      toast.success(`${definition?.name ?? "Connector"} disconnected.`);
      setShowDisconnectConfirm(false);
      onOpenChange(false);
      onDisconnected();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reconnectMutation = useMutation({
    mutationFn: () => api.integrations.disconnect(connector?.id ?? ""),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      if (definition) onReconnect(definition);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isSyncing = connector?.syncStatus === "syncing";

  // Poll progress while syncing
  const { data: progressData } = useQuery({
    queryKey: ["sync-progress"],
    queryFn: () => api.integrations.progress(),
    refetchInterval: isSyncing ? 2000 : false,
    enabled: isSyncing,
  });

  const myProgress = progressData?.active.find((p) => p.connectorId === connector?.id);

  if (!definition || !connector) return null;

  const isError = connector.syncStatus === "error";

  const scopeEntries = Object.entries(connector.scopeConfig ?? {}).filter(
    ([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0),
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} />
              Manage {definition.name}
            </DialogTitle>
            <DialogDescription>{definition.description}</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <SyncStatusDot status={connector.syncStatus} />
              <span className="font-medium capitalize">{connector.syncStatus}</span>
            </div>
            {isSyncing && myProgress ? (
              <span className="text-muted-foreground">
                {myProgress.itemsProcessed} items processed
                {myProgress.itemsCreated > 0 && `, ${myProgress.itemsCreated} new`}
                {myProgress.itemsSkipped > 0 && `, ${myProgress.itemsSkipped} unchanged`}
              </span>
            ) : (
              <>
                {connector.fileCount != null && (
                  <span className="text-muted-foreground">
                    {connector.fileCount.toLocaleString()} {definition.itemNoun}
                  </span>
                )}
                {connector.lastSyncedAt && (
                  <span className="text-muted-foreground">Synced {formatRelativeTime(connector.lastSyncedAt)}</span>
                )}
              </>
            )}
          </div>

          {isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
              {connector.errorMessage && <p className="text-xs text-destructive">{connector.errorMessage}</p>}
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 gap-1.5 text-xs"
                onClick={() => reconnectMutation.mutate()}
                disabled={reconnectMutation.isPending}
              >
                {reconnectMutation.isPending ? (
                  <>
                    <SpinnerGapIcon size={12} className="animate-spin" />
                    Reconnecting...
                  </>
                ) : (
                  <>
                    <ArrowsClockwiseIcon size={12} />
                    Update credentials
                  </>
                )}
              </Button>
            </div>
          )}

          <ScopeEditorDispatch
            scopeType={definition.scopeType}
            connectorId={connector.id}
            connectorType={connector.connectorType}
            scopeConfig={connector.scopeConfig}
            scopeLabel={definition.scopeLabel}
            scopeEntries={scopeEntries}
            onBrowsingChange={setIsBrowsingScope}
          />

          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={() => setShowDisconnectConfirm(true)}
            >
              <TrashIcon size={12} />
              Disconnect
            </Button>
            <div className="flex items-center gap-1.5">
              {!isError && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => reconnectMutation.mutate()}
                  disabled={reconnectMutation.isPending}
                >
                  {reconnectMutation.isPending ? (
                    <>
                      <SpinnerGapIcon size={12} className="animate-spin" />
                      Updating...
                    </>
                  ) : (
                    "Update credentials"
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => syncMutation.mutate()}
                disabled={connector.syncStatus === "syncing" || syncMutation.isPending || isBrowsingScope}
              >
                <ArrowsClockwiseIcon size={12} className={connector.syncStatus === "syncing" ? "animate-spin" : ""} />
                {connector.syncStatus === "syncing" ? "Syncing..." : "Sync now"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDisconnectConfirm} onOpenChange={setShowDisconnectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {definition.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the connection and all indexed {definition.itemNoun} from {definition.name}. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {entityCount > 0 && (
            <label className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteEntities}
                onChange={(e) => setDeleteEntities(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-destructive"
              />
              <span className="text-xs text-muted-foreground">
                Also delete <span className="font-medium text-foreground">{entityCount}</span>{" "}
                {entityCount === 1 ? "entity" : "entities"} created from {definition.name} data (people, companies, and
                other extracted records)
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {disconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ScopeEditorDispatch({
  scopeType,
  connectorId,
  connectorType,
  scopeConfig,
  scopeLabel,
  scopeEntries,
  onBrowsingChange,
}: {
  scopeType: "none" | "flat" | "nested" | "tree";
  connectorId: string;
  connectorType: string;
  scopeConfig: Record<string, unknown>;
  scopeLabel: string;
  scopeEntries: [string, unknown][];
  onBrowsingChange?: (browsing: boolean) => void;
}) {
  if (scopeType === "none") {
    return (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Sync scope — {scopeLabel}
        </p>
        <div className="mt-1.5">
          {scopeEntries.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {scopeEntries.map(([key, value]) => (
                <Badge key={key} variant="secondary" className="text-[10px]">
                  {Array.isArray(value) ? value.join(", ") : String(value)}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">All accessible {scopeLabel} are being synced.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <GenericScopeEditor
      connectorId={connectorId}
      scopeConfig={scopeConfig}
      noun={scopeLabel}
      onBrowsingChange={onBrowsingChange}
    />
  );
}

function SyncStatusDot({ status }: { status: string }) {
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
