import { GithubAppIcon } from "@/components/connections/app-icon";
import { type SlackChannelInfo, type User, type WhatsAppGroupInfo, api } from "@/lib/api";
import { GearSixIcon, SpinnerGapIcon, TrashIcon } from "@phosphor-icons/react";
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
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const GITHUB_TOKEN_URL = "https://github.com/settings/personal-access-tokens";

type SetupStep = "understand" | "token" | "access" | "success";
type GithubVerificationIdentity = {
  externalId: string;
  login: string;
  avatarUrl: string | null;
  accountType: string | null;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function GithubIntegrationCard({
  connection,
  users,
  slackChannels,
  whatsappGroups,
  currentUserId,
  isAdmin,
  onChanged,
  setupOpen: controlledSetupOpen,
  onSetupOpenChange,
}: {
  connection: CliIntegrationConnection | null;
  users: User[];
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId: string;
  isAdmin: boolean;
  onChanged: () => void;
  setupOpen?: boolean;
  onSetupOpenChange?: (open: boolean) => void;
}) {
  const [internalSetupOpen, setInternalSetupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const setupOpen = controlledSetupOpen ?? internalSetupOpen;
  const setSetupOpen = onSetupOpenChange ?? setInternalSetupOpen;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <GithubAppIcon className="size-10" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">GitHub</h2>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">GitHub CLI</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Use GitHub in Sketch chat and automations through the managed <code>gh</code> CLI.
            </p>
            {connection && (
              <p className={`mt-2 text-xs ${connection.status === "active" ? "text-success" : "text-destructive"}`}>
                {connection.status === "active" ? `Connected as @${connection.accountLogin}` : "GitHub needs attention"}
              </p>
            )}
          </div>
        </div>
        {connection ? (
          connection.canManage ? (
            <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
              Manage
            </Button>
          ) : null
        ) : (
          <Button size="sm" onClick={() => setSetupOpen(true)}>
            Connect
          </Button>
        )}
      </div>

      <GithubIntegrationDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        users={users}
        slackChannels={slackChannels}
        whatsappGroups={whatsappGroups}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onSuccess={() => onChanged()}
      />
      {connection && (
        <GithubConnectionManageDialog
          connection={connection}
          open={manageOpen}
          onOpenChange={setManageOpen}
          users={users}
          slackChannels={slackChannels}
          whatsappGroups={whatsappGroups}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

export function GithubIntegrationRow({
  connection,
  isLast,
  users,
  slackChannels,
  whatsappGroups,
  currentUserId,
  isAdmin,
  onChanged,
}: {
  connection: CliIntegrationConnection;
  isLast: boolean;
  users: User[];
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId: string;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const canManage = connection.canManage === true;

  const disconnect = async () => {
    if (!canManage || disconnecting || !window.confirm("Disconnect GitHub from Sketch?")) return;
    setDisconnecting(true);
    try {
      await api.cliIntegrations.disconnect(connection.id);
      toast.success("GitHub disconnected");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "GitHub could not be disconnected");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <div className={`flex items-center gap-4 px-4 py-4 ${isLast ? "" : "border-b border-border"}`}>
        <GithubAppIcon className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">GitHub</span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            <span className="max-w-[12rem] truncate">@{connection.accountLogin}</span>
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
            aria-label="Open settings for GitHub"
            title={canManage ? "Open settings for GitHub" : "Only the owner can manage GitHub"}
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
            aria-label="Disconnect GitHub"
            title={canManage ? "Disconnect GitHub" : "Only the owner can disconnect GitHub"}
            onClick={() => void disconnect()}
            disabled={!canManage || disconnecting}
          >
            {disconnecting ? <SpinnerGapIcon size={14} className="animate-spin" /> : <TrashIcon size={14} />}
          </Button>
        </div>
      </div>
      <GithubConnectionManageDialog
        connection={connection}
        open={manageOpen}
        onOpenChange={setManageOpen}
        users={users}
        slackChannels={slackChannels}
        whatsappGroups={whatsappGroups}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />
    </>
  );
}

export function GithubIntegrationDialog({
  open,
  onOpenChange,
  users,
  slackChannels,
  whatsappGroups,
  currentUserId,
  isAdmin,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: User[];
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId: string;
  isAdmin: boolean;
  onSuccess: (connection: CliIntegrationConnection) => void;
}) {
  const [step, setStep] = useState<SetupStep>("understand");
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<CliIntegrationConnection | null>(null);
  const [verifiedIdentity, setVerifiedIdentity] = useState<GithubVerificationIdentity | null>(null);
  const [targets, setTargets] = useState<AgentEnvironmentShareTargetInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setStep("understand");
    setToken("");
    setConnection(null);
    setVerifiedIdentity(null);
    setTargets([]);
    setSaving(false);
    setError(null);
  }, [open]);

  const teammateOptions = useMemo(
    () => users.filter((user) => user.id !== currentUserId && user.type !== "external"),
    [users, currentUserId],
  );

  const toggleTarget = (target: AgentEnvironmentShareTargetInput) => {
    const key = `${target.type}:${target.id}`;
    setTargets((current) =>
      current.some((item) => `${item.type}:${item.id}` === key)
        ? current.filter((item) => `${item.type}:${item.id}` !== key)
        : [...current, target],
    );
  };

  const verify = async () => {
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.cliIntegrations.verifyGitHubToken(token.trim());
      setVerifiedIdentity(result.identity);
      setStep("access");
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub could not verify this token.");
    } finally {
      setSaving(false);
    }
  };

  const saveAccess = async () => {
    if (!verifiedIdentity || !token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.cliIntegrations.connectGitHub(token.trim(), targets);
      setToken("");
      setConnection(result.connection);
      setStep("success");
      onSuccess(result.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub access could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!saving) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-start gap-3 pr-8">
            <GithubAppIcon className="size-10" />
            <div>
              <DialogTitle>Connect GitHub</DialogTitle>
              <DialogDescription className="mt-1">
                Use GitHub through Sketch&apos;s managed GitHub CLI.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {step === "understand" && (
          <div className="space-y-4 py-2 text-sm">
            <p>
              Your personal access token stays encrypted in Sketch. GitHub actions run as the token&apos;s GitHub
              account, and repository access follows the permissions GitHub grants that account.
            </p>
            <p className="text-muted-foreground">
              We recommend a fine-grained token with the least privilege needed. Token verification proves identity; it
              does not prove access to every repository.
            </p>
            <a
              className="text-sm underline underline-offset-4"
              href={GITHUB_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
            >
              Create a GitHub personal access token
            </a>
          </div>
        )}

        {step === "token" && (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="github-pat">Personal access token</Label>
              <Input
                id="github-pat"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
                placeholder="Paste your GitHub token"
                disabled={saving}
                aria-describedby="github-token-help"
              />
              <p id="github-token-help" className="text-xs text-muted-foreground">
                The token is kept only in this form until verification and is never returned to the browser.
              </p>
            </div>
          </div>
        )}

        {step === "access" && verifiedIdentity && (
          <div className="space-y-4 py-2">
            <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm">
              Verified as <span className="font-medium">@{verifiedIdentity.login}</span>. Choose who can use this
              connection.
            </div>
            <p className="text-sm text-muted-foreground">Only you is selected by default.</p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {isAdmin && (
                <TargetCheckbox
                  checked={targets.some((target) => target.type === "org" && target.id === "default")}
                  label="Everyone in the organization"
                  onChange={() => toggleTarget({ type: "org", id: "default" })}
                />
              )}
              {teammateOptions.map((user) => (
                <TargetCheckbox
                  key={user.id}
                  checked={targets.some((target) => target.type === "user" && target.id === user.id)}
                  label={user.name || user.email || "Teammate"}
                  onChange={() => toggleTarget({ type: "user", id: user.id })}
                />
              ))}
              {slackChannels.map((channel) => (
                <TargetCheckbox
                  key={channel.id}
                  checked={targets.some((target) => target.type === "slack_channel" && target.id === channel.id)}
                  label={`Slack #${channel.name}`}
                  onChange={() => toggleTarget({ type: "slack_channel", id: channel.id })}
                />
              ))}
              {whatsappGroups.map((group) => (
                <TargetCheckbox
                  key={group.jid}
                  checked={targets.some((target) => target.type === "whatsapp_group" && target.id === group.jid)}
                  label={`WhatsApp ${group.name}`}
                  onChange={() => toggleTarget({ type: "whatsapp_group", id: group.jid })}
                />
              ))}
              {teammateOptions.length === 0 &&
                slackChannels.length === 0 &&
                whatsappGroups.length === 0 &&
                !isAdmin && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">Only you can use this connection.</p>
                )}
            </div>
          </div>
        )}

        {step === "success" && connection && (
          <div className="space-y-4 py-4 text-sm">
            <p>
              GitHub is connected as <span className="font-medium">@{connection.accountLogin}</span>.
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

        <DialogFooter>
          {step === "understand" && (
            <>
              <Button variant="outline" onClick={close} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => setStep("token")}>Continue</Button>
            </>
          )}
          {step === "token" && (
            <>
              <Button variant="outline" onClick={() => setStep("understand")} disabled={saving}>
                Back
              </Button>
              <Button onClick={verify} disabled={!token.trim() || saving}>
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
              <Button onClick={saveAccess} disabled={saving}>
                {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
                {saving ? "Saving…" : "Save access"}
              </Button>
            </>
          )}
          {step === "success" && <Button onClick={() => close()}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GithubConnectionManageDialog({
  connection,
  open,
  onOpenChange,
  users,
  slackChannels,
  whatsappGroups,
  currentUserId,
  isAdmin,
  onChanged,
}: {
  connection: CliIntegrationConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: User[];
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId: string;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [token, setToken] = useState("");
  const [targets, setTargets] = useState<AgentEnvironmentShareTargetInput[]>(connection.shares);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setToken("");
      setTargets(connection.shares);
      setError(null);
    }
  }, [open, connection]);

  const teammateOptions = useMemo(
    () => users.filter((user) => user.id !== currentUserId && user.type !== "external"),
    [users, currentUserId],
  );

  const toggleTarget = (target: AgentEnvironmentShareTargetInput) => {
    const key = `${target.type}:${target.id}`;
    setTargets((current) =>
      current.some((item) => `${item.type}:${item.id}` === key)
        ? current.filter((item) => `${item.type}:${item.id}` !== key)
        : [...current, target],
    );
  };

  const run = async (operation: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await operation();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!saving) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage GitHub</DialogTitle>
          <DialogDescription>
            Connected as @{connection.accountLogin}. GitHub permissions remain controlled by GitHub.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">Access</p>
            <p className="text-xs text-muted-foreground">Changes apply to the next chat or automation run.</p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {isAdmin && (
                <TargetCheckbox
                  checked={targets.some((target) => target.type === "org" && target.id === "default")}
                  label="Everyone in the organization"
                  onChange={() => toggleTarget({ type: "org", id: "default" })}
                />
              )}
              {teammateOptions.map((user) => (
                <TargetCheckbox
                  key={user.id}
                  checked={targets.some((target) => target.type === "user" && target.id === user.id)}
                  label={user.name || user.email || "Teammate"}
                  onChange={() => toggleTarget({ type: "user", id: user.id })}
                />
              ))}
              {slackChannels.map((channel) => (
                <TargetCheckbox
                  key={channel.id}
                  checked={targets.some((target) => target.type === "slack_channel" && target.id === channel.id)}
                  label={`Slack #${channel.name}`}
                  onChange={() => toggleTarget({ type: "slack_channel", id: channel.id })}
                />
              ))}
              {whatsappGroups.map((group) => (
                <TargetCheckbox
                  key={group.jid}
                  checked={targets.some((target) => target.type === "whatsapp_group" && target.id === group.jid)}
                  label={`WhatsApp ${group.name}`}
                  onChange={() => toggleTarget({ type: "whatsapp_group", id: group.jid })}
                />
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() =>
                void run(async () => {
                  await api.cliIntegrations.replaceShares(connection.id, targets);
                  toast.success("GitHub access updated");
                })
              }
            >
              Save access
            </Button>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium">Credential</p>
            <div className="flex gap-2">
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste a replacement token"
                autoComplete="new-password"
                disabled={saving}
              />
              <Button
                variant="outline"
                disabled={!token.trim() || saving}
                onClick={() =>
                  void run(async () => {
                    await api.cliIntegrations.updateGitHubToken(connection.id, token.trim());
                    setToken("");
                    toast.success("GitHub token replaced");
                  })
                }
              >
                Replace
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                void run(async () => {
                  const result = await api.cliIntegrations.reverifyGitHub(connection.id);
                  if (result.connection.status === "active")
                    toast.success(`Verified as @${result.connection.accountLogin}`);
                  else toast.error(result.connection.lastVerificationError ?? "GitHub verification failed");
                })
              }
            >
              Re-verify current token
            </Button>
          </div>

          <div className="border-t border-border pt-4 text-xs text-muted-foreground">
            Disconnecting removes Sketch access and shares. It does not revoke the token at GitHub.
          </div>
        </div>

        {error && (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}

        <DialogFooter className="justify-between sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => {
              if (!window.confirm("Disconnect GitHub from Sketch?")) return;
              void run(async () => {
                await api.cliIntegrations.disconnect(connection.id);
                toast.success("GitHub disconnected");
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

function TargetCheckbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
