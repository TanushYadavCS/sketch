import { IntegrationIcon } from "@/components/connect-integration-dialog";
/**
 * ManageConnectorDialog — status summary, sync scope configuration, credential
 * update, and disconnect flow for a connected integration.
 *
 * Google Drive gets a drive/folder picker. Other connectors show a generic
 * read-only scope display. Disconnect triggers a confirmation alert dialog.
 *
 * Authz: edit controls render from server-provided connector capability fields.
 */
import { HierarchyMappingPanel } from "@/components/hierarchy-mapping-panel";
import { GenericScopeEditor } from "@/components/scope-picker";
import type { ConnectorConfig, HierarchyLevel, WhatsAppGroupMemberLabel } from "@/lib/api";
import { api } from "@/lib/api";
import type { IntegrationDefinition } from "@/lib/integrations";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  PencilSimpleIcon,
  PlusIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FileDetailSheet } from "./file-detail-sheet";

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
  onDisconnected: (connector: ConnectorConfig) => void | Promise<void>;
  onReconnect: (def: IntegrationDefinition) => void;
}) {
  const queryClient = useQueryClient();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [isBrowsingScope, setIsBrowsingScope] = useState(false);
  const [showRotateKey, setShowRotateKey] = useState(false);

  const canDisconnect = connector?.canDisconnect === true;
  const canSync = connector?.canSync === true;
  const canChangeScope = connector?.canChangeScope === true;
  const canUpdateCredentials = connector?.canUpdateCredentials === true;

  // Fetch entity count when disconnect confirmation opens — used in the dialog copy
  // so the user knows how much extracted data they're about to remove.
  const { data: entityCountData } = useQuery({
    queryKey: ["connector-entity-count", connector?.id],
    queryFn: () => api.integrations.entityCount(connector?.id ?? ""),
    enabled: showDisconnectConfirm && !!connector?.id && canDisconnect,
  });
  const entityCount = entityCountData?.count ?? 0;

  const syncMutation = useMutation({
    mutationFn: () => api.integrations.sync(connector?.id ?? ""),
    onSuccess: () => {
      toast.success("Sync started.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["sync-progress"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.integrations.disconnect(connector?.id ?? ""),
    onSuccess: async () => {
      const disconnectedConnector = connector;
      toast.success(`${definition?.name ?? "Connector"} disconnected.`);
      setShowDisconnectConfirm(false);
      onOpenChange(false);
      if (disconnectedConnector) await onDisconnected(disconnectedConnector);
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

  // For local credential connectors, "Update credentials" validates replacement
  // credentials before swapping them in place. OAuth connectors fall back to
  // reconnect because their redirect callback owns the uniqueness contract.
  const updateCredentials = () => {
    if (!canUpdateCredentials) return;
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
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <IntegrationIcon color={definition.color} name={definition.name} type={definition.type} />
              Manage {definition.name}
            </DialogTitle>
            <DialogDescription>{definition.description}</DialogDescription>
          </DialogHeader>

          <div className="flex min-w-0 flex-wrap items-center gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs">
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
              {canUpdateCredentials ? (
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
                <p className="mt-2 text-xs text-muted-foreground">Credentials can't be updated from this account.</p>
              )}
            </div>
          )}

          {canChangeScope ? (
            <>
              <ScopeEditorDispatch
                scopeType={definition.scopeType}
                connectorId={connector.id}
                connectorType={connector.connectorType}
                scopeConfig={connector.scopeConfig}
                hierarchyLevels={connector.hierarchyLevels}
                containerClassificationEnabled={connector.containerClassificationEnabled === true}
                scopeConfigKey={definition.scopeConfigKey}
                flatScopeShape={definition.flatScopeShape}
                scopeLabel={definition.scopeLabel}
                scopeEntries={scopeEntries}
                allowEmptySelection={definition.allowEmptyScopeSelection === true}
                onBrowsingChange={setIsBrowsingScope}
              />
              {connector.connectorType === "whatsapp" && (
                <WhatsAppMemberLabelsEditor connectorId={connector.id} scopeConfig={connector.scopeConfig} />
              )}
            </>
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              Read-only connection. Scope and credential controls are unavailable for this account.
            </div>
          )}

          {connector.connectorType === "gmail" && <GmailFilteredEmails connectorId={connector.id} />}
          {connector.connectorType === "gmail" && <GmailConversations connector={connector} />}

          <div className="flex items-center justify-between border-t border-border pt-3">
            {canDisconnect ? (
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
              {canUpdateCredentials && !isError && (
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
              {canSync && (
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
              )}
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

      <RotateCredentialsDialog
        open={showRotateKey}
        onOpenChange={setShowRotateKey}
        connectorId={connector.id}
        definition={definition}
      />
    </>
  );
}

/**
 * In-place credential dialog. Calls POST /api/connectors/:id/rotate-key, which
 * validates the new credentials and swaps them on the existing row.
 */
function RotateCredentialsDialog({
  open,
  onOpenChange,
  connectorId,
  definition,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectorId: string;
  definition: IntegrationDefinition;
}) {
  const queryClient = useQueryClient();
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const allFieldsFilled = definition.authFields.every((field) => (fieldValues[field.key] ?? "").trim().length > 0);

  const mutation = useMutation({
    mutationFn: () =>
      api.integrations.rotateCredentials(
        connectorId,
        Object.fromEntries(definition.authFields.map((field) => [field.key, fieldValues[field.key]?.trim() ?? ""])),
      ),
    onSuccess: () => {
      toast.success("Credentials updated.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      setFieldValues({});
      setError(null);
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message || "Failed to update credentials"),
  });

  const handleClose = (next: boolean) => {
    if (!next) {
      setFieldValues({});
      setError(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update {definition.name} credentials</DialogTitle>
          <DialogDescription>
            Enter new credentials. The existing connection stays in place until the new credentials validate.
            {definition.credentialUrl && (
              <>
                {" "}
                Get credentials at{" "}
                <a
                  href={definition.credentialUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {definition.credentialUrl}
                </a>
                .
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {definition.authFields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`rotate-${field.key}`}>{field.label}</Label>
              <Input
                id={`rotate-${field.key}`}
                type={field.type === "password" ? "password" : "text"}
                value={fieldValues[field.key] ?? ""}
                onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                autoComplete="off"
              />
              {field.helpText && <p className="text-[11px] text-muted-foreground">{field.helpText}</p>}
            </div>
          ))}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !allFieldsFilled}>
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
  hierarchyLevels,
  containerClassificationEnabled,
  scopeConfigKey,
  flatScopeShape,
  scopeLabel,
  scopeEntries,
  allowEmptySelection,
  onBrowsingChange,
}: {
  scopeType: "none" | "flat" | "nested" | "tree";
  connectorId: string;
  connectorType: string;
  scopeConfig: Record<string, unknown>;
  hierarchyLevels?: HierarchyLevel[] | null;
  containerClassificationEnabled?: boolean;
  scopeConfigKey?: string;
  flatScopeShape?: IntegrationDefinition["flatScopeShape"];
  scopeLabel: string;
  scopeEntries: [string, unknown][];
  allowEmptySelection?: boolean;
  onBrowsingChange?: (browsing: boolean) => void;
}) {
  const showHierarchy = Array.isArray(hierarchyLevels) && hierarchyLevels.length > 0;

  if (connectorType === "gmail") {
    return <EmailScopeEditor connectorId={connectorId} scopeConfig={scopeConfig} />;
  }

  const hierarchySection = showHierarchy ? (
    <HierarchyMappingPanel
      key={connectorId}
      connectorId={connectorId}
      levels={hierarchyLevels}
      scopeConfig={scopeConfig}
      containerClassificationEnabled={containerClassificationEnabled === true}
    />
  ) : null;

  if (scopeType === "none") {
    return (
      <div className="space-y-4">
        {hierarchySection}
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
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hierarchySection}
      <GenericScopeEditor
        connectorId={connectorId}
        scopeConfig={scopeConfig}
        scopeConfigKey={scopeConfigKey}
        flatScopeShape={flatScopeShape}
        noun={scopeLabel}
        allowEmptySelection={allowEmptySelection}
        onBrowsingChange={onBrowsingChange}
      />
    </div>
  );
}

function selectedWhatsAppGroupJids(scopeConfig: Record<string, unknown>): string[] {
  const value = scopeConfig.groupIndexing;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => enabled === true)
    .map(([jid]) => jid);
}

type WhatsAppGroupMemberLabelDraft = WhatsAppGroupMemberLabel & { phoneE164?: string };

function labelsKey(
  labels: Array<Pick<WhatsAppGroupMemberLabelDraft, "id" | "phoneE164" | "displayName" | "companyName">>,
): string {
  return JSON.stringify(
    labels
      .map((label) => [label.id, label.phoneE164 ?? "", label.displayName, label.companyName ?? ""])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function maskPhoneLastTwo(phoneE164: string): string {
  const lastTwo = phoneE164.replace(/\D/gu, "").slice(-2);
  return lastTwo ? `**${lastTwo}` : "**";
}

function WhatsAppMemberLabelsEditor({
  connectorId,
  scopeConfig,
}: {
  connectorId: string;
  scopeConfig: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const browseQuery = useQuery({
    queryKey: ["generic-browse", connectorId],
    queryFn: () => api.integrations.browseExisting(connectorId),
  });
  const groupJids = selectedWhatsAppGroupJids(browseQuery.data?.scopeConfig ?? scopeConfig);
  const [selectedGroupJid, setSelectedGroupJid] = useState(groupJids[0] ?? "");
  const [draftRows, setDraftRows] = useState<WhatsAppGroupMemberLabelDraft[]>([]);
  const [phone, setPhone] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const groupNameByJid = useMemo(() => {
    const map = new Map<string, string>();
    const data = browseQuery.data;
    if (data?.type === "flat") {
      for (const item of data.items) map.set(item.id, item.name);
    }
    return map;
  }, [browseQuery.data]);

  useEffect(() => {
    if (groupJids.length === 0) {
      setSelectedGroupJid("");
      return;
    }
    if (!selectedGroupJid || !groupJids.includes(selectedGroupJid)) {
      setSelectedGroupJid(groupJids[0] ?? "");
    }
  }, [groupJids, selectedGroupJid]);

  const labelsQuery = useQuery({
    queryKey: ["whatsapp-group-member-labels", selectedGroupJid],
    queryFn: () => api.channels.listWhatsAppGroupMemberLabels(selectedGroupJid),
    enabled: !!selectedGroupJid,
  });

  useEffect(() => {
    setDraftRows(labelsQuery.data?.labels ?? []);
    setPhone("");
    setDisplayName("");
    setCompanyName("");
    setEditingId(null);
  }, [labelsQuery.data?.labels]);

  const baselineKey = labelsKey(labelsQuery.data?.labels ?? []);
  const draftKey = labelsKey(draftRows);
  const dirty = draftKey !== baselineKey;

  const mutation = useMutation({
    mutationFn: () =>
      api.channels.replaceWhatsAppGroupMemberLabels(
        selectedGroupJid,
        draftRows.map((row) => ({
          ...(row.phoneE164 ? { phoneE164: row.phoneE164 } : { id: row.id }),
          displayName: row.displayName,
          companyName: row.companyName,
        })),
      ),
    onSuccess: () => {
      toast.success("Member labels saved.");
      queryClient.invalidateQueries({ queryKey: ["whatsapp-group-member-labels", selectedGroupJid] });
      setPhone("");
      setDisplayName("");
      setCompanyName("");
      setEditingId(null);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const startEdit = (row: WhatsAppGroupMemberLabelDraft) => {
    setEditingId(row.id);
    setPhone(row.phoneE164 ?? row.maskedPhone);
    setDisplayName(row.displayName);
    setCompanyName(row.companyName ?? "");
  };

  const resetForm = () => {
    setPhone("");
    setDisplayName("");
    setCompanyName("");
    setEditingId(null);
  };

  const addOrUpdateRow = () => {
    const trimmedPhone = phone.trim();
    const trimmedName = displayName.trim();
    if ((!editingId && !trimmedPhone) || !trimmedName) return;
    setDraftRows((rows) => {
      const draftId = editingId ?? `draft:${trimmedPhone}`;
      const next = rows.filter((row) => row.id !== draftId);
      const existing = rows.find((row) => row.id === draftId);
      const phoneE164 = editingId ? existing?.phoneE164 : trimmedPhone;
      return [
        ...next,
        {
          id: draftId,
          ...(phoneE164 ? { phoneE164 } : {}),
          maskedPhone: existing?.maskedPhone ?? maskPhoneLastTwo(trimmedPhone),
          displayName: trimmedName,
          companyName: companyName.trim() || null,
        },
      ].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
    });
    resetForm();
  };

  if (groupJids.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Member labels</p>
        <p className="mt-1 text-xs text-muted-foreground">Select WhatsApp groups above to label external members.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/10 px-3 py-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Member labels</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Manual identity hints for selected groups.</p>
        </div>
        <Select value={selectedGroupJid} onValueChange={setSelectedGroupJid}>
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groupJids.map((jid) => (
              <SelectItem key={jid} value={jid}>
                {groupNameByJid.get(jid) ?? jid}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+14155551234"
          aria-label="Member phone number"
          disabled={!!editingId}
          className="h-8 text-xs"
        />
        <Input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Name"
          aria-label="Member display name"
          className="h-8 text-xs"
        />
        <Input
          value={companyName}
          onChange={(event) => setCompanyName(event.target.value)}
          placeholder="Company"
          aria-label="Member company"
          className="h-8 text-xs"
        />
        <div className="flex gap-1">
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={addOrUpdateRow}
            disabled={(!editingId && !phone.trim()) || !displayName.trim()}
          >
            <PlusIcon size={12} />
            {editingId ? "Update" : "Add"}
          </Button>
          {editingId && (
            <Button variant="ghost" size="icon" className="size-8" onClick={resetForm}>
              <XIcon size={13} />
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <div className="grid grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_5rem] bg-muted/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>Number</span>
          <span>Name</span>
          <span>Company</span>
          <span className="text-right">Actions</span>
        </div>
        {labelsQuery.isLoading ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">Loading labels...</div>
        ) : draftRows.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">No member labels yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {draftRows.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_5rem] items-center gap-2 px-3 py-2 text-xs"
              >
                <span className="font-mono text-muted-foreground">{row.maskedPhone}</span>
                <span className="min-w-0 truncate font-medium">{row.displayName}</span>
                <span className="min-w-0 truncate text-muted-foreground">{row.companyName || "-"}</span>
                <span className="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => startEdit(row)}>
                    <PencilSimpleIcon size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-destructive hover:text-destructive"
                    onClick={() => setDraftRows((rows) => rows.filter((item) => item.id !== row.id))}
                  >
                    <TrashIcon size={12} />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Button
        size="sm"
        className="h-7 w-full text-xs"
        onClick={() => mutation.mutate()}
        disabled={!dirty || mutation.isPending || !selectedGroupJid}
      >
        {mutation.isPending ? (
          <>
            <SpinnerGapIcon size={12} className="animate-spin" />
            Saving...
          </>
        ) : (
          "Save labels"
        )}
      </Button>
    </div>
  );
}

/**
 * Email connectors (Gmail) have no browsable scope tree — the only meaningful
 * knobs are the lookback window and an optional provider search query. Saving
 * replaces scope_config and clears the sync cursor server-side, forcing a full
 * re-sync over the new window.
 */
const LOOKBACK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 1 year" },
  { value: "730", label: "Last 2 years" },
  { value: "1095", label: "Last 3 years" },
];

const EMAIL_MAX_LOOKBACK_DAYS = 1095;

function normalizeEmailLookbackDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 90;
  return Math.max(1, Math.min(Math.floor(value), EMAIL_MAX_LOOKBACK_DAYS));
}

function EmailScopeEditor({
  connectorId,
  scopeConfig,
}: {
  connectorId: string;
  scopeConfig: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const currentDays = normalizeEmailLookbackDays(scopeConfig.initialDays);
  const currentQuery = typeof scopeConfig.query === "string" ? scopeConfig.query : "";
  const [days, setDays] = useState(String(currentDays));
  const [query, setQuery] = useState(currentQuery);

  const dirty = days !== String(currentDays) || query.trim() !== currentQuery.trim();

  const mutation = useMutation({
    mutationFn: () =>
      api.integrations.updateScope(connectorId, {
        ...scopeConfig,
        initialDays: Number(days),
        query: query.trim(),
      }),
    onSuccess: () => {
      toast.success("Sync scope updated — re-syncing.");
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["sync-progress"] });
      queryClient.invalidateQueries({ queryKey: ["file-counts-by-source"] });
      queryClient.invalidateQueries({ queryKey: ["all-files"] });
      queryClient.invalidateQueries({ queryKey: ["hybrid-search"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label
          htmlFor="email-lookback"
          className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          Lookback window
        </Label>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger id="email-lookback" className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOOKBACK_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">How far back to ingest inbox and sent mail on a full sync.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email-query" className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Search filter <span className="font-normal normal-case">(optional)</span>
        </Label>
        <Input
          id="email-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. from:@acme.com"
          className="h-8 text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          A Gmail search query. When set, it overrides the inbox/sent + lookback defaults.
        </p>
      </div>

      <Button
        size="sm"
        className="h-7 text-xs"
        onClick={() => mutation.mutate()}
        disabled={!dirty || mutation.isPending}
      >
        {mutation.isPending ? "Saving…" : "Save & re-sync"}
      </Button>
    </div>
  );
}

/**
 * Read-only "Filtered email" section for Gmail connectors. Surfaces what the
 * shared email layer suppressed before indexing (bulk / operational / non-
 * reciprocal mail) so silent suppression becomes inspectable. Counts-only:
 * the suppression table stores only the reason + provider IDs, not sender or
 * subject (see GMAIL_CONNECTOR_UI §U3).
 */
const SUPPRESSION_REASON_LABELS: Record<string, string> = {
  bulk: "Bulk / newsletters",
  operational: "Operational / automated",
  role_account: "Role accounts",
  inbound_only: "Inbound-only (no reply)",
  missing_counterparty: "No counterparty",
};

function GmailFilteredEmails({ connectorId }: { connectorId: string }) {
  const [showRecent, setShowRecent] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["suppressed-emails", connectorId],
    queryFn: () => api.integrations.suppressedEmails(connectorId, { limit: 10 }),
  });

  if (isError) return null;

  const reasons = Object.entries(data?.countsByReason ?? {}).filter(([, count]) => count > 0);

  return (
    <div className="min-w-0 space-y-2 border-t border-border pt-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Filtered email</p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : data && data.total > 0 ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {reasons.map(([reason, count]) => (
              <Badge key={reason} variant="secondary" className="text-[10px]">
                {SUPPRESSION_REASON_LABELS[reason] ?? reason}: {count}
              </Badge>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {data.total} message{data.total === 1 ? "" : "s"} were filtered out before indexing — bulk, automated, and
            non-reciprocal mail are skipped to keep search and enrichment clean.
          </p>
          {data.recent.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-0 text-[11px] text-muted-foreground hover:bg-transparent"
                onClick={() => setShowRecent((v) => !v)}
              >
                {showRecent ? "Hide" : "Show"} recent filtered messages
              </Button>
              {showRecent && (
                <ul className="min-w-0 space-y-1">
                  {data.recent.map((row) => (
                    <li
                      key={row.providerFileId}
                      className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground"
                    >
                      <span className="min-w-0 truncate font-mono">{row.providerFileId}</span>
                      <span className="shrink-0">
                        {SUPPRESSION_REASON_LABELS[row.reason] ?? row.reason} ·{" "}
                        {new Date(row.observedAt).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing filtered yet.</p>
      )}
    </div>
  );
}

/**
 * Read-only "Conversations" section for Gmail connectors — one row per email
 * thread (newest first). Clicking a row opens the shared file-detail sheet on
 * the thread's latest message, which renders the whole visible conversation.
 */
function GmailConversations({ connector }: { connector: ConnectorConfig }) {
  const connectorId = connector.id;
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["email-threads", connectorId],
    queryFn: () => api.integrations.emailThreads(connectorId, { limit: 20 }),
  });

  if (isError) return null;

  return (
    <div className="min-w-0 space-y-2 border-t border-border pt-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Conversations</p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : data && data.threads.length > 0 ? (
        <ul className="max-h-72 min-w-0 space-y-1 overflow-y-auto pr-1">
          {data.threads.map((thread) => (
            <li key={thread.threadKey} className="min-w-0">
              <button
                type="button"
                onClick={() => setOpenFileId(thread.latestIndexedFileId)}
                className="block w-full min-w-0 rounded-md border border-border px-2.5 py-1.5 text-left transition-colors hover:bg-muted/30"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-medium">{thread.latestSubject ?? "(no subject)"}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {thread.lastActivity ? new Date(thread.lastActivity).toLocaleDateString() : ""}
                  </span>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge variant="secondary" className="text-[10px]">
                    {thread.messageCount} msg{thread.messageCount === 1 ? "" : "s"}
                  </Badge>
                  {thread.participants.length > 0 && (
                    <span className="min-w-0 truncate">{thread.participants.join(", ")}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No conversations yet.</p>
      )}
      <FileDetailSheet fileId={openFileId} connectors={[connector]} onClose={() => setOpenFileId(null)} />
    </div>
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
