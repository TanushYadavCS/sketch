/**
 * ManageConnectorDialog — status summary, sync scope configuration, credential
 * update, and disconnect flow for a connected integration.
 *
 * Google Drive gets a drive/folder picker. Other connectors show a generic
 * read-only scope display. Disconnect triggers a confirmation alert dialog.
 */
import { FolderContents, IntegrationIcon } from "@/components/connect-integration-dialog";
import type { ConnectorConfig } from "@/lib/api";
import { api } from "@/lib/api";
import type { IntegrationDefinition } from "@/lib/integrations";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  FolderIcon,
  FolderOpenIcon,
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
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

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

  if (!definition || !connector) return null;

  const isError = connector.syncStatus === "error";
  const isGoogleDrive = definition.type === "google_drive";

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
            {connector.fileCount != null && (
              <span className="text-muted-foreground">
                {connector.fileCount.toLocaleString()} {definition.itemNoun}
              </span>
            )}
            {connector.lastSyncedAt && (
              <span className="text-muted-foreground">Synced {formatRelativeTime(connector.lastSyncedAt)}</span>
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

          {isGoogleDrive ? (
            <GoogleDriveScopeEditor connectorId={connector.id} scopeConfig={connector.scopeConfig} />
          ) : (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Sync scope — {definition.scopeLabel}
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
                  <p className="text-xs text-muted-foreground">
                    All accessible {definition.scopeLabel} are being synced.
                  </p>
                )}
              </div>
            </div>
          )}

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
                disabled={connector.syncStatus === "syncing" || syncMutation.isPending}
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

function GoogleDriveScopeEditor({
  connectorId,
  scopeConfig,
}: {
  connectorId: string;
  scopeConfig: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const currentDriveIds = (scopeConfig?.sharedDrives as string[] | undefined) ?? [];
  const currentFolderIds = (scopeConfig?.folders as string[] | undefined) ?? [];

  const { data: browseData, isLoading: isBrowsing } = useQuery({
    queryKey: ["google-drive-browse", connectorId],
    queryFn: () => api.integrations.browseGoogleDriveExisting(connectorId),
  });

  const drives = browseData?.sharedDrives ?? [];
  const folders = browseData?.rootFolders ?? [];

  const [selectedDriveIds, setSelectedDriveIds] = useState<Set<string> | null>(null);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string> | null>(null);

  const effectiveDriveIds = selectedDriveIds ?? new Set(drives.filter((d) => d.selected).map((d) => d.id));
  const effectiveFolderIds = selectedFolderIds ?? new Set(folders.filter((f) => f.selected).map((f) => f.id));

  const toggleDrive = (driveId: string) => {
    setSelectedDriveIds((prev) => {
      const base = prev ?? new Set(drives.filter((d) => d.selected).map((d) => d.id));
      const next = new Set(base);
      if (next.has(driveId)) next.delete(driveId);
      else next.add(driveId);
      return next;
    });
  };

  const toggleFolder = (folderId: string) => {
    setSelectedFolderIds((prev) => {
      const base = prev ?? new Set(folders.filter((f) => f.selected).map((f) => f.id));
      const next = new Set(base);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const currentDriveSet = new Set(currentDriveIds);
  const currentFolderSet = new Set(currentFolderIds);

  const hasDriveChanges =
    selectedDriveIds !== null &&
    (effectiveDriveIds.size !== currentDriveSet.size || [...effectiveDriveIds].some((id) => !currentDriveSet.has(id)));

  const hasFolderChanges =
    selectedFolderIds !== null &&
    (effectiveFolderIds.size !== currentFolderSet.size ||
      [...effectiveFolderIds].some((id) => !currentFolderSet.has(id)));

  const hasChanges = hasDriveChanges || hasFolderChanges;

  const saveMutation = useMutation({
    mutationFn: () => {
      const newScope: Record<string, string[]> = {};
      if (drives.length > 0) newScope.sharedDrives = Array.from(effectiveDriveIds);
      if (folders.length > 0) newScope.folders = Array.from(effectiveFolderIds);
      return api.integrations.updateScope(connectorId, newScope);
    },
    onSuccess: () => {
      toast.success("Scope updated. Re-sync started.");
      setSelectedDriveIds(null);
      setSelectedFolderIds(null);
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["google-drive-browse", connectorId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const totalSelected = effectiveDriveIds.size + effectiveFolderIds.size;

  return (
    <div className="space-y-4">
      {isBrowsing ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <SpinnerGapIcon size={14} className="animate-spin" />
          Loading...
        </div>
      ) : (
        <>
          {(drives.length > 0 || folders.length > 0) && (
            <CombinedDrivePicker
              drives={drives}
              folders={folders}
              selectedDriveIds={effectiveDriveIds}
              selectedFolderIds={effectiveFolderIds}
              onToggleDrive={toggleDrive}
              onToggleFolder={toggleFolder}
              disabled={saveMutation.isPending}
              connectorId={connectorId}
            />
          )}
          {drives.length === 0 && folders.length === 0 && (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-3">
              <p className="text-xs font-medium">No drives or folders found</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Check that the connected Google account has access to Drive content.
              </p>
            </div>
          )}
          {hasChanges && (
            <Button
              size="sm"
              className="mt-2 h-7 w-full gap-1.5 text-xs"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || totalSelected === 0}
            >
              {saveMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={12} className="animate-spin" />
                  Saving...
                </>
              ) : (
                `Save & re-sync (${totalSelected} item${totalSelected === 1 ? "" : "s"})`
              )}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function CombinedDrivePicker({
  drives,
  folders,
  selectedDriveIds,
  selectedFolderIds,
  onToggleDrive,
  onToggleFolder,
  disabled,
  connectorId,
}: {
  drives: Array<{ id: string; name: string }>;
  folders: Array<{ id: string; name: string }>;
  selectedDriveIds: Set<string>;
  selectedFolderIds: Set<string>;
  onToggleDrive: (id: string) => void;
  onToggleFolder: (id: string) => void;
  disabled?: boolean;
  connectorId: string;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalItems = drives.length + folders.length;
  const totalSelected = selectedDriveIds.size + selectedFolderIds.size;
  const allSelected = totalSelected === totalItems && totalItems > 0;

  const selectAll = () => {
    for (const d of drives) {
      if (!selectedDriveIds.has(d.id)) onToggleDrive(d.id);
    }
    for (const f of folders) {
      if (!selectedFolderIds.has(f.id)) onToggleFolder(f.id);
    }
  };

  const deselectAll = () => {
    for (const d of drives) {
      if (selectedDriveIds.has(d.id)) onToggleDrive(d.id);
    }
    for (const f of folders) {
      if (selectedFolderIds.has(f.id)) onToggleFolder(f.id);
    }
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => (allSelected ? deselectAll() : selectAll())}
        disabled={disabled}
        className="flex w-full items-center gap-2 px-1 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <span className="inline-flex size-4 items-center justify-center rounded border border-border">
          {allSelected && <span className="size-2 rounded-sm bg-foreground" />}
        </span>
        {allSelected ? "Deselect all" : "Select all"} ({totalItems})
      </button>

      <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-border">
        {drives.map((drive) => {
          const isSelected = selectedDriveIds.has(drive.id);
          const isExpanded = expandedIds.has(drive.id);
          return (
            <div key={`drive-${drive.id}`}>
              <div
                className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                  isSelected ? "bg-muted/30" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(drive.id)}
                  className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
                  title="Preview drive contents"
                >
                  <CaretRightIcon size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => onToggleDrive(drive.id)}
                  disabled={disabled}
                  className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
                >
                  <CheckboxIndicator checked={isSelected} />
                  {isExpanded ? (
                    <FolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{drive.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">Shared</span>
                </button>
              </div>
              {isExpanded && <FolderContents connectorId={connectorId} folderId={drive.id} />}
            </div>
          );
        })}
        {folders.map((folder) => {
          const isSelected = selectedFolderIds.has(folder.id);
          const isExpanded = expandedIds.has(folder.id);
          return (
            <div key={`folder-${folder.id}`}>
              <div
                className={`flex w-full items-center gap-1 px-1 py-2 text-left text-sm transition-colors hover:bg-muted/50 ${
                  isSelected ? "bg-muted/30" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(folder.id)}
                  className="flex shrink-0 items-center justify-center size-6 rounded hover:bg-muted/80 text-muted-foreground"
                  title="Preview folder contents"
                >
                  <CaretRightIcon size={12} className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => onToggleFolder(folder.id)}
                  disabled={disabled}
                  className="flex flex-1 items-center gap-2.5 disabled:opacity-50"
                >
                  <CheckboxIndicator checked={isSelected} />
                  {isExpanded ? (
                    <FolderOpenIcon size={16} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{folder.name}</span>
                </button>
              </div>
              {isExpanded && <FolderContents connectorId={connectorId} folderId={folder.id} />}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {totalSelected} of {totalItems} item{totalItems === 1 ? "" : "s"} selected
      </p>
    </div>
  );
}

function CheckboxIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded border ${
        checked ? "border-primary bg-primary" : "border-border"
      }`}
    >
      {checked && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3 text-primary-foreground"
          role="img"
          aria-label="Selected"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
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
