import { LinearAppIcon } from "@/components/connections/app-icon";
import { AccessPicker } from "@/components/connections/github-integration-dialog";
import { type SlackChannelInfo, type User, type WhatsAppGroupInfo, api } from "@/lib/api";
import { GearSixIcon, KeyIcon, ShareNetworkIcon, SpinnerGapIcon, TrashIcon } from "@phosphor-icons/react";
import type { AgentEnvironmentShareTargetInput, CliIntegrationConnection } from "@sketch/shared";
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
import { useEffect, useState } from "react";
import { toast } from "sonner";

type SetupStep = "key" | "access" | "success";
type LinearVerificationIdentity = {
  externalId: string;
  login: string;
  name?: string | null;
  email?: string | null;
  avatarUrl: string | null;
  accountType: string | null;
};

type LinearAccessProps = {
  users: User[];
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId: string;
  isAdmin: boolean;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LinearIntegrationRow({
  connection,
  isLast,
  onChanged,
  ...accessProps
}: LinearAccessProps & {
  connection: CliIntegrationConnection;
  isLast: boolean;
  onChanged: () => void;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const canManage = connection.canManage === true;

  const disconnect = async () => {
    if (!canManage || disconnecting || !window.confirm("Disconnect Linear from Sketch?")) return;
    setDisconnecting(true);
    try {
      await api.cliIntegrations.disconnect("linear", connection.id);
      toast.success("Linear disconnected");
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Linear could not be disconnected");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
        <LinearAppIcon className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">Linear</span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="max-w-[16rem] truncate">{connection.accountLogin}</span>
            <span aria-hidden="true">·</span>
            <span>Connected {formatDate(connection.createdAt)}</span>
          </span>
        </div>
        <div className="ml-auto grid shrink-0 grid-cols-[5rem_1.75rem_1.75rem] items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span
              className={`size-2 rounded-full ${connection.status === "active" ? "bg-success" : "bg-destructive"}`}
            />
            <span className="text-xs text-muted-foreground">
              {connection.status === "active" ? "Active" : connection.status}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={canManage ? "size-7 text-muted-foreground" : "size-7 text-muted-foreground/40"}
            aria-label="Open settings for Linear"
            title={canManage ? "Open settings for Linear" : "Only the owner can manage Linear"}
            onClick={() => setManageOpen(true)}
            disabled={!canManage}
          >
            <GearSixIcon size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={
              canManage ? "size-7 text-muted-foreground hover:text-destructive" : "size-7 text-muted-foreground/40"
            }
            aria-label="Disconnect Linear"
            title={canManage ? "Disconnect Linear" : "Only the owner can disconnect Linear"}
            onClick={() => void disconnect()}
            disabled={!canManage || disconnecting}
          >
            {disconnecting ? <SpinnerGapIcon size={14} className="animate-spin" /> : <TrashIcon size={14} />}
          </Button>
        </div>
      </div>
      <LinearConnectionManageDialog
        connection={connection}
        open={manageOpen}
        onOpenChange={setManageOpen}
        onChanged={onChanged}
        {...accessProps}
      />
    </>
  );
}

export function LinearIntegrationDialog({
  open,
  onOpenChange,
  onSuccess,
  ...accessProps
}: LinearAccessProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (connection: CliIntegrationConnection) => void;
}) {
  const [step, setStep] = useState<SetupStep>("key");
  const [apiKey, setApiKey] = useState("");
  const [identity, setIdentity] = useState<LinearVerificationIdentity | null>(null);
  const [connection, setConnection] = useState<CliIntegrationConnection | null>(null);
  const [targets, setTargets] = useState<AgentEnvironmentShareTargetInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setStep("key");
    setApiKey("");
    setIdentity(null);
    setConnection(null);
    setTargets([]);
    setSaving(false);
    setError(null);
  }, [open]);

  const close = () => {
    if (!saving) onOpenChange(false);
  };

  const verify = async () => {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.cliIntegrations.verifyLinearApiKey(apiKey.trim());
      setIdentity(result.identity);
      setStep("access");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Linear could not verify this API key.");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!identity || !apiKey.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.cliIntegrations.connectLinear(apiKey.trim(), targets);
      setApiKey("");
      setIdentity(null);
      setTargets([]);
      setConnection(result.connection);
      setStep("success");
      onSuccess(result.connection);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Linear access could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="flex max-h-[min(90vh,720px)] flex-col overflow-hidden sm:max-w-2xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-start gap-3 pr-8">
            <LinearAppIcon className="size-10" />
            <div>
              <DialogTitle>Connect Linear</DialogTitle>
              <DialogDescription className="mt-1">
                Use Linear through Sketch&apos;s managed GraphQL API.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-1">
          {step === "key" && (
            <div className="space-y-5 py-2">
              <div className="space-y-3 text-sm">
                <p>
                  Your personal API key stays encrypted in Sketch. Linear actions run with the permissions of the
                  account that created the key.
                </p>
                <p className="text-muted-foreground">
                  Verification checks the key&apos;s Linear identity. It does not grant access beyond Linear&apos;s own
                  permissions.
                </p>
                <a
                  className="inline-block underline underline-offset-4"
                  href="https://linear.app/settings/account/security"
                  target="_blank"
                  rel="noreferrer"
                >
                  Create a Linear personal API key
                </a>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="linear-api-key">Personal API key</Label>
                <Input
                  id="linear-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="new-password"
                  placeholder="Paste your Linear API key"
                  disabled={saving}
                />
                <p className="text-xs text-muted-foreground">
                  The key is used only for verification and connection setup. It is never stored in browser storage.
                </p>
              </div>
            </div>
          )}
          {step === "access" && identity && (
            <div className="space-y-4 py-2">
              <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
                Verified as <span className="font-medium">{identity.login}</span>. Choose who can use this connection.
              </div>
              <AccessPicker {...accessProps} targets={targets} onTargetsChange={setTargets} disabled={saving} />
            </div>
          )}
          {step === "success" && connection && (
            <div className="space-y-4 py-4 text-sm">
              <p>
                Linear is connected as <span className="font-medium">{connection.accountLogin}</span>.
              </p>
              <p className="text-muted-foreground">
                The managed Linear skill can now use this connection where shared.
              </p>
            </div>
          )}
          {error && (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t bg-background/95 px-6 py-4 backdrop-blur">
          {step === "key" && (
            <>
              <Button variant="outline" onClick={close} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void verify()} disabled={!apiKey.trim() || saving}>
                {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
                {saving ? "Verifying…" : "Verify and continue"}
              </Button>
            </>
          )}
          {step === "access" && (
            <>
              <Button variant="outline" onClick={close} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
                {saving ? "Saving…" : "Save access"}
              </Button>
            </>
          )}
          {step === "success" && <Button onClick={close}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinearConnectionManageDialog({
  connection,
  open,
  onOpenChange,
  onChanged,
  ...accessProps
}: LinearAccessProps & {
  connection: CliIntegrationConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [targets, setTargets] = useState<AgentEnvironmentShareTargetInput[]>(connection.shares);
  const [savedTargets, setSavedTargets] = useState<AgentEnvironmentShareTargetInput[]>(connection.shares);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setApiKey("");
    setTargets(connection.shares);
    setSavedTargets(connection.shares);
    setError(null);
  }, [connection, open]);

  const run = async (operation: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await operation();
      onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Linear settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!saving) onOpenChange(false);
  };
  const accessChanged = !sameTargets(targets, savedTargets);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="flex max-h-[min(90vh,760px)] flex-col overflow-hidden sm:max-w-2xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Manage Linear</DialogTitle>
          <DialogDescription>
            Connected as {connection.accountLogin}. Linear controls API permissions.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-2">
          <section className="rounded-lg border border-border bg-muted/10 p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ShareNetworkIcon size={17} aria-hidden />
              </span>
              <div>
                <h3 className="text-sm font-semibold">Access management</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose people and conversation spaces that can use Linear.
                </p>
              </div>
            </div>
            <AccessPicker
              {...accessProps}
              className="mt-4"
              targets={targets}
              onTargetsChange={setTargets}
              disabled={saving}
            />
            <Button
              className="mt-4"
              variant="outline"
              size="sm"
              disabled={saving || !accessChanged}
              onClick={() =>
                void run(async () => {
                  await api.cliIntegrations.replaceShares("linear", connection.id, targets);
                  setSavedTargets(targets);
                  toast.success("Linear access updated");
                })
              }
            >
              Save access
            </Button>
          </section>
          <section className="rounded-lg border border-border bg-muted/10 p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <KeyIcon size={17} aria-hidden />
              </span>
              <div>
                <h3 className="text-sm font-semibold">API key replacement</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Replace the key used by Sketch. The current key is never shown.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="Replacement Linear API key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste a replacement API key"
                autoComplete="new-password"
                disabled={saving}
              />
              <Button
                variant="outline"
                disabled={!apiKey.trim() || saving}
                onClick={() =>
                  void run(async () => {
                    await api.cliIntegrations.updateLinearApiKey(connection.id, apiKey.trim());
                    setApiKey("");
                    toast.success("Linear API key replaced");
                  })
                }
              >
                Replace key
              </Button>
            </div>
            <Button
              className="mt-2"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                void run(async () => {
                  const result = await api.cliIntegrations.reverifyLinear(connection.id);
                  if (result.connection.status === "active")
                    toast.success(`Verified as ${result.connection.accountLogin}`);
                  else toast.error(result.connection.lastVerificationError ?? "Linear verification failed");
                })
              }
            >
              Re-verify current key
            </Button>
          </section>
          <p className="px-1 text-xs text-muted-foreground">
            Disconnecting removes Sketch access and shares. It does not revoke the key at Linear.
          </p>
        </div>
        {error && (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
        <DialogFooter className="shrink-0 justify-between border-t bg-background/95 px-6 py-4 backdrop-blur sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => {
              if (!window.confirm("Disconnect Linear from Sketch?")) return;
              void run(async () => {
                await api.cliIntegrations.disconnect("linear", connection.id);
                toast.success("Linear disconnected");
                onOpenChange(false);
              });
            }}
          >
            Disconnect
          </Button>
          <Button variant="outline" onClick={close} disabled={saving}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function sameTargets(first: AgentEnvironmentShareTargetInput[], second: AgentEnvironmentShareTargetInput[]): boolean {
  if (first.length !== second.length) return false;
  const secondKeys = new Set(second.map((target) => `${target.type}:${target.id}`));
  return first.every((target) => secondKeys.has(`${target.type}:${target.id}`));
}
