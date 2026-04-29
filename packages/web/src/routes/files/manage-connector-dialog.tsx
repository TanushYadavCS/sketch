import { IntegrationIcon } from "@/components/connect-integration-dialog";
/**
 * ManageConnectorDialog — status summary, sync scope configuration, credential
 * update, and disconnect flow for a connected integration.
 *
 * Google Drive gets a drive/folder picker. Other connectors show a generic
 * read-only scope display. Disconnect triggers a confirmation alert dialog.
 *
 * Authz: org-wide connectors (perUserAuth: false) are admin-only for edits.
 * Members see a read-only "Managed by your admin" state with no destructive controls.
 */
import { GenericScopeEditor } from "@/components/scope-picker";
import type { ConnectorConfig } from "@/lib/api";
import { api } from "@/lib/api";
import type { IntegrationDefinition } from "@/lib/integrations";
import { useDashboardAuth } from "@/routes/dashboard";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  const auth = useDashboardAuth();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [isBrowsingScope, setIsBrowsingScope] = useState(false);
  const [showRotateKey, setShowRotateKey] = useState(false);

  // Edit allowed if admin OR this is the caller's own per-user row.
  // For org-wide connectors (perUserAuth: false), only admins can edit.
  const canEdit = auth.role === "admin" || (definition?.perUserAuth ?? false);

  // Fetch entity count when disconnect confirmation opens — used in the dialog copy
  // so the user knows how much extracted data they're about to remove.
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
    mutationFn: () => api.integrations.disconnect(connector?.id ?? ""),
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

  // For api_key connectors, "Update credentials" opens a non-destructive rotate
  // dialog (server validates the new key and replaces in place — no data loss
  // if the user cancels). For OAuth connectors, fall back to the disconnect →
  // reauth flow (destructive; can't be avoided without redoing the OAuth
  // callback uniqueness contract).
  const updateCredentials = () => {
    if (definition?.authType === "api_key") {
      setShowRotateKey(true);
    } else {
      reconnectMutation.mutate();
    }
  };

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
              {canEdit ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 gap-1.5 text-xs"
                  onClick={updateCredentials}
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
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Ask your admin to update the credentials.</p>
              )}
            </div>
          )}

          {canEdit ? (
            <ScopeEditorDispatch
              scopeType={definition.scopeType}
              connectorId={connector.id}
              connectorType={connector.connectorType}
              scopeConfig={connector.scopeConfig}
              scopeLabel={definition.scopeLabel}
              scopeEntries={scopeEntries}
              onBrowsingChange={setIsBrowsingScope}
            />
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              Managed by your admin. Ask them to change the {definition.scopeLabel} or rotate credentials.
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border pt-3">
            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                onClick={() => setShowDisconnectConfirm(true)}
              >
                <TrashIcon size={12} />
                Disconnect
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-1.5">
              {canEdit && !isError && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={updateCredentials}
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
              This will remove the connection, all indexed {definition.itemNoun}
              {entityCount > 0 ? (
                <>
                  , and <span className="font-medium text-foreground">{entityCount}</span> extracted{" "}
                  {entityCount === 1 ? "entity" : "entities"} (people, companies, and other records)
                </>
              ) : (
                ", and any extracted entities (people, companies, and other records)"
              )}{" "}
              created from {definition.name} data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
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

      <RotateKeyDialog
        open={showRotateKey}
        onOpenChange={setShowRotateKey}
        connectorId={connector.id}
        connectorName={definition.name}
        credentialUrl={definition.credentialUrl}
      />
    </>
  );
}

/**
 * In-place rotate-key dialog. Calls POST /api/connectors/:id/rotate-key, which
 * validates the new key and swaps it on the existing row. Cancel is safe — the
 * existing key isn't touched until the new one validates.
 */
function RotateKeyDialog({
  open,
  onOpenChange,
  connectorId,
  connectorName,
  credentialUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectorId: string;
  connectorName: string;
  credentialUrl: string;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.integrations.rotateKey(connectorId, apiKey.trim()),
    onSuccess: () => {
      toast.success("Credentials updated.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      setApiKey("");
      setError(null);
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message || "Failed to update credentials"),
  });

  const handleClose = (next: boolean) => {
    if (!next) {
      setApiKey("");
      setError(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update {connectorName} credentials</DialogTitle>
          <DialogDescription>
            Paste a new API key. The existing key stays in place until the new one validates — cancelling here keeps
            your current connection intact. Get a key at{" "}
            <a
              href={credentialUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {credentialUrl}
            </a>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rotate-api-key">New API key</Label>
          <Input
            id="rotate-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste new API key"
            autoComplete="off"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !apiKey.trim()}>
            {mutation.isPending ? "Updating…" : "Update credentials"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
