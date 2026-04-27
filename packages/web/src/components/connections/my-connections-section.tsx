/**
 * "My Connections" — per-user data connectors (currently Fireflies only).
 *
 * Each user adds their own API key and can rotate, sync, or disconnect it.
 * Visibility for other team members is driven by attendee email matching at
 * search time, not by who pulled the data.
 */
import { ConnectorLogo } from "@/components/connector-logos";
import { api } from "@/lib/api";
import { type IntegrationDefinition, type IntegrationType, getIntegration } from "@/lib/integrations";
import {
  ArrowsClockwiseIcon,
  ArrowsCounterClockwiseIcon,
  KeyIcon,
  PlusIcon,
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
import { useEffect, useState } from "react";
import { toast } from "sonner";

type MyConnector = {
  id: string;
  connectorType: string;
  credentialHint: string | null;
  syncStatus: string;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  fileCount: number;
};

const PER_USER_INTEGRATION_TYPES: IntegrationType[] = ["fireflies"];

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Active", cls: "bg-success/10 text-success" },
    syncing: { label: "Syncing", cls: "bg-primary/10 text-primary" },
    pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
    error: { label: "Error", cls: "bg-destructive/10 text-destructive" },
    disabled: { label: "Disabled", cls: "bg-muted text-muted-foreground" },
    paused: { label: "Paused", cls: "bg-muted text-muted-foreground" },
  };
  const entry = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${entry.cls}`}>{entry.label}</span>;
}

export function MyConnectionsSection({ autoAddType }: { autoAddType?: string | null } = {}) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState<IntegrationDefinition | null>(null);
  const [rotating, setRotating] = useState<MyConnector | null>(null);
  const [disconnecting, setDisconnecting] = useState<MyConnector | null>(null);

  const query = useQuery({
    queryKey: ["my-connectors"],
    queryFn: () => api.integrations.listMine(),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["my-connectors"] });

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.integrations.sync(id),
    onSuccess: () => {
      toast.success("Sync started");
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const connectors = query.data?.connectors ?? [];
  const availableToAdd: IntegrationDefinition[] = PER_USER_INTEGRATION_TYPES.map((t) => getIntegration(t)).filter(
    (def): def is IntegrationDefinition => !!def && !connectors.some((c) => c.connectorType === def.type),
  );

  // Auto-open the add dialog when ?add=<type> is passed via the URL (e.g. user
  // clicked "Connect Fireflies" from the Files page catalog).
  useEffect(() => {
    if (!autoAddType || query.isLoading) return;
    const def = availableToAdd.find((d) => d.type === autoAddType);
    if (def) setShowAdd(def);
  }, [autoAddType, query.isLoading, availableToAdd]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">My Connections</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Personal data sources you've connected. Files are visible to other team members only when they were
            attendees on the meeting.
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">Loading…</div>
      ) : connectors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center">
          <p className="text-sm font-medium text-foreground">No personal connections yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Connect Fireflies to sync your meeting transcripts.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {connectors.map((c, i) => {
            const def = getIntegration(c.connectorType as IntegrationType);
            return (
              <div
                key={c.id}
                className={`flex items-center gap-4 px-4 py-4 ${i < connectors.length - 1 ? "border-b border-border" : ""}`}
              >
                <div
                  className="flex size-9 items-center justify-center rounded-lg"
                  style={{ backgroundColor: def?.color ?? "#999" }}
                >
                  <ConnectorLogo type={c.connectorType} size={18} className="text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{def?.name ?? c.connectorType}</span>
                    <StatusPill status={c.syncStatus} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {c.credentialHint ? (
                      <span className="font-mono">••••••{c.credentialHint}</span>
                    ) : (
                      <span>Connected</span>
                    )}
                    <span>·</span>
                    <span>{c.fileCount.toLocaleString()} files</span>
                    <span>·</span>
                    <span>Last synced {formatRelative(c.lastSyncedAt)}</span>
                  </div>
                  {c.errorMessage && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
                      <WarningCircleIcon size={12} weight="fill" />
                      <span>{c.errorMessage}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => syncMutation.mutate(c.id)}
                    disabled={syncMutation.isPending || c.syncStatus === "syncing"}
                  >
                    <ArrowsClockwiseIcon size={14} />
                    Sync now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRotating(c)}>
                    <KeyIcon size={14} />
                    Rotate key
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDisconnecting(c)}>
                    <TrashIcon size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {availableToAdd.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {availableToAdd.map((def) => (
            <Button key={def.type} variant="outline" size="sm" onClick={() => setShowAdd(def)}>
              <PlusIcon size={12} weight="bold" />
              Add {def.name}
            </Button>
          ))}
        </div>
      )}

      <FirefliesAddDialog
        integration={showAdd}
        onOpenChange={(open) => !open && setShowAdd(null)}
        onSuccess={refresh}
        onSwitchToRotate={(existing) => {
          setShowAdd(null);
          if (existing) setRotating(existing);
        }}
        existingByType={new Map(connectors.map((c) => [c.connectorType, c]))}
      />

      <RotateKeyDialog connector={rotating} onOpenChange={(open) => !open && setRotating(null)} onSuccess={refresh} />

      <DisconnectDialog
        connector={disconnecting}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        onSuccess={refresh}
      />
    </div>
  );
}

function FirefliesAddDialog({
  integration,
  onOpenChange,
  onSuccess,
  onSwitchToRotate,
  existingByType,
}: {
  integration: IntegrationDefinition | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onSwitchToRotate: (existing: MyConnector | null) => void;
  existingByType: Map<string, MyConnector>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!integration || !apiKey.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.integrations.connect({
        connectorType: integration.type,
        authType: "api_key",
        credentials: { api_key: apiKey.trim() },
      });
      toast.success("Syncing your meetings now — they'll appear in Search shortly.");
      setApiKey("");
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect";
      // 409 ALREADY_CONNECTED → offer rotate flow
      if (message.toLowerCase().includes("already")) {
        const existing = existingByType.get(integration.type) ?? null;
        onSwitchToRotate(existing);
        return;
      }
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!integration) return null;

  return (
    <Dialog open={!!integration} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {integration.name}</DialogTitle>
          <DialogDescription>
            Paste your personal {integration.name} API key. You can find it at{" "}
            <a
              href={integration.credentialUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              {integration.credentialUrl}
            </a>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="fireflies-api-key">API key</Label>
          <Input
            id="fireflies-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste API key"
            autoComplete="off"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !apiKey.trim()}>
            {submitting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyDialog({
  connector,
  onOpenChange,
  onSuccess,
}: {
  connector: MyConnector | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!connector || !apiKey.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.integrations.rotateKey(connector.id, apiKey.trim());
      toast.success("Key rotated");
      setApiKey("");
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
    } finally {
      setSubmitting(false);
    }
  };

  if (!connector) return null;

  return (
    <Dialog open={!!connector} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate API key</DialogTitle>
          <DialogDescription>The new key replaces the existing one after validation.</DialogDescription>
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
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !apiKey.trim()}>
            <ArrowsCounterClockwiseIcon size={14} />
            {submitting ? "Rotating…" : "Rotate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisconnectDialog({
  connector,
  onOpenChange,
  onSuccess,
}: {
  connector: MyConnector | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!connector) return;
    setSubmitting(true);
    try {
      await api.integrations.disconnect(connector.id);
      toast.success("Disconnected");
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setSubmitting(false);
    }
  };

  if (!connector) return null;

  return (
    <AlertDialog open={!!connector} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect this integration?</AlertDialogTitle>
          <AlertDialogDescription>
            Future syncs will stop. Files already synced remain visible to other attendees.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
