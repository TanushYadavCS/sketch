import { GithubAppIcon } from "@/components/connections/app-icon";
import { type SlackChannelInfo, type User, type WhatsAppGroupInfo, api } from "@/lib/api";
import {
  CaretDownIcon,
  CheckCircleIcon,
  GearSixIcon,
  GlobeIcon,
  HashIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  ShareNetworkIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TrashIcon,
  UserCircleIcon,
  UserIcon,
  UsersThreeIcon,
  WhatsappLogoIcon,
} from "@phosphor-icons/react";
import type { AgentEnvironmentShareTargetInput, CliIntegrationConnection } from "@sketch/shared";
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
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";

const GITHUB_TOKEN_URL = "https://github.com/settings/personal-access-tokens";

type SetupStep = "token" | "access" | "success";
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
      await api.cliIntegrations.disconnect(connection.appId, connection.id);
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
  const [step, setStep] = useState<SetupStep>("token");
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<CliIntegrationConnection | null>(null);
  const [verifiedIdentity, setVerifiedIdentity] = useState<GithubVerificationIdentity | null>(null);
  const [targets, setTargets] = useState<AgentEnvironmentShareTargetInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setStep("token");
    setToken("");
    setConnection(null);
    setVerifiedIdentity(null);
    setTargets([]);
    setSaving(false);
    setError(null);
  }, [open]);

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
      setVerifiedIdentity(null);
      setTargets([]);
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
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          className="flex max-h-[min(90vh,720px)] flex-col overflow-hidden sm:max-w-2xl"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
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
          <div className="min-h-0 flex-1 overflow-y-auto px-1">
            {step === "token" && (
              <div className="space-y-5 py-2">
                <div className="space-y-3 text-sm">
                  <p>
                    Your personal access token stays encrypted in Sketch. GitHub actions run as the token&apos;s GitHub
                    account, and repository access follows the permissions GitHub grants that account.
                  </p>
                  <p className="text-muted-foreground">
                    We recommend a fine-grained token with the least privilege needed. Verification proves identity; it
                    does not prove access to every repository.
                  </p>
                  <a
                    className="inline-block underline underline-offset-4"
                    href={GITHUB_TOKEN_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create a GitHub personal access token
                  </a>
                </div>
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
                    The token stays in this form until saved and is never stored in browser storage.
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
                <AccessPicker
                  users={users}
                  slackChannels={slackChannels}
                  whatsappGroups={whatsappGroups}
                  currentUserId={currentUserId}
                  isAdmin={isAdmin}
                  targets={targets}
                  onTargetsChange={setTargets}
                  disabled={saving}
                />
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
          </div>

          <DialogFooter className="shrink-0 border-t bg-background/95 px-6 py-4 backdrop-blur">
            {step === "token" && (
              <>
                <Button variant="outline" onClick={close} disabled={saving}>
                  Cancel
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
    </>
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
  const [savedTargets, setSavedTargets] = useState<AgentEnvironmentShareTargetInput[]>(connection.shares);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setToken("");
      setTargets(connection.shares);
      setSavedTargets(connection.shares);
      setError(null);
    }
  }, [open, connection]);

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
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          className="flex max-h-[min(90vh,760px)] flex-col overflow-hidden sm:max-w-2xl"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Manage GitHub</DialogTitle>
            <DialogDescription>
              Connected as @{connection.accountLogin}. GitHub permissions remain controlled by GitHub.
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
                    Choose the people and conversation spaces that can use this connection.
                  </p>
                </div>
              </div>
              <AccessPicker
                users={users}
                slackChannels={slackChannels}
                whatsappGroups={whatsappGroups}
                currentUserId={currentUserId}
                isAdmin={isAdmin}
                targets={targets}
                onTargetsChange={setTargets}
                disabled={saving}
                className="mt-4"
              />
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                disabled={saving || sameTargets(targets, savedTargets)}
                onClick={() =>
                  void run(async () => {
                    await api.cliIntegrations.replaceShares(connection.appId, connection.id, targets);
                    setSavedTargets(targets);
                    toast.success("GitHub access updated");
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
                  <h3 className="text-sm font-semibold">Credential replacement</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Replace the token used by Sketch. The current token is never shown.
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-label="Replacement GitHub token"
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
                  Replace token
                </Button>
              </div>
              <Button
                className="mt-2"
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
            </section>

            <p className="px-1 text-xs text-muted-foreground">
              Disconnecting removes Sketch access and shares. It does not revoke the token at GitHub.
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
                if (!window.confirm("Disconnect GitHub from Sketch?")) return;
                void run(async () => {
                  await api.cliIntegrations.disconnect(connection.appId, connection.id);
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
    </>
  );
}

export type AccessPickerProps = {
  users: User[];
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId: string;
  isAdmin: boolean;
  targets: AgentEnvironmentShareTargetInput[];
  onTargetsChange: (targets: AgentEnvironmentShareTargetInput[]) => void;
  disabled?: boolean;
  className?: string;
};

export function AccessPicker({
  users,
  slackChannels,
  whatsappGroups,
  currentUserId,
  isAdmin,
  targets,
  onTargetsChange,
  disabled = false,
  className,
}: AccessPickerProps) {
  const pickerId = useId();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const teammates = users.filter((user) => user.id !== currentUserId && user.type !== "external");
  const selectedKeys = new Set(targets.map(targetKey));
  const toggle = (target: AgentEnvironmentShareTargetInput) => {
    const key = targetKey(target);
    onTargetsChange(selectedKeys.has(key) ? targets.filter((item) => targetKey(item) !== key) : [...targets, target]);
  };
  const matches = (value: string) => !query || value.toLowerCase().includes(query);
  const filteredUsers = teammates.filter((user) => matches(`${user.name} ${user.email ?? ""}`));
  const filteredSlack = slackChannels.filter((channel) => matches(channel.name));
  const filteredWhatsapp = whatsappGroups.filter((group) => matches(group.name));
  const totalAvailable = (isAdmin ? 1 : 0) + teammates.length + slackChannels.length + whatsappGroups.length;
  const visibleCount =
    (isAdmin && matches("organization") ? 1 : 0) +
    filteredUsers.length +
    filteredSlack.length +
    filteredWhatsapp.length;

  return (
    <div className={`space-y-3 ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Who can use this connection?</p>
          <p className="text-xs text-muted-foreground">You always have access as the connection owner.</p>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {targets.length} selected
        </Badge>
      </div>
      <div className="relative">
        <MagnifyingGlassIcon
          size={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          aria-label="Search access targets"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search people, channels, or groups"
          className="pl-9"
          disabled={disabled}
        />
      </div>
      <div className="max-h-[min(42vh,360px)] space-y-4 overflow-y-auto rounded-lg border border-border p-3">
        {isAdmin && (
          <TargetGroup
            contentId={`${pickerId}-organization`}
            title="Organization"
            count={1}
            selectedCount={targets.filter((target) => target.type === "org").length}
            icon={<GlobeIcon size={15} aria-hidden />}
            forceOpen={Boolean(query && matches("organization"))}
            empty={query && !matches("organization") ? "No organization target matches your search." : undefined}
          >
            {!query || matches("organization") ? (
              <TargetOption
                target={{ type: "org", id: "default" }}
                checked={selectedKeys.has("org:default")}
                disabled={disabled}
                icon={<GlobeIcon size={15} aria-hidden />}
                label="Everyone in the organization"
                description="All workspace members"
                onToggle={toggle}
              />
            ) : null}
          </TargetGroup>
        )}
        <TargetGroup
          contentId={`${pickerId}-members`}
          title="Members"
          count={teammates.length}
          selectedCount={targets.filter((target) => target.type === "user").length}
          icon={<UsersThreeIcon size={15} aria-hidden />}
          forceOpen={Boolean(query && filteredUsers.length > 0)}
          empty={
            teammates.length === 0
              ? "No other human members are available."
              : visibleCount === 0
                ? "No members match your search."
                : undefined
          }
        >
          {filteredUsers.map((user) => (
            <TargetOption
              key={user.id}
              target={{ type: "user", id: user.id }}
              checked={selectedKeys.has(`user:${user.id}`)}
              disabled={disabled}
              icon={<UserIcon size={15} aria-hidden />}
              label={user.name || "Teammate"}
              description={user.email ?? undefined}
              onToggle={toggle}
            />
          ))}
        </TargetGroup>
        <TargetGroup
          contentId={`${pickerId}-slack-channels`}
          title="Slack channels"
          count={slackChannels.length}
          selectedCount={targets.filter((target) => target.type === "slack_channel").length}
          icon={<SlackLogoIcon size={15} aria-hidden />}
          forceOpen={Boolean(query && filteredSlack.length > 0)}
          empty={
            slackChannels.length === 0
              ? "No Slack channels are available."
              : filteredSlack.length === 0
                ? "No Slack channels match your search."
                : undefined
          }
        >
          {filteredSlack.map((channel) => (
            <TargetOption
              key={channel.id}
              target={{ type: "slack_channel", id: channel.id }}
              checked={selectedKeys.has(`slack_channel:${channel.id}`)}
              disabled={disabled}
              icon={<HashIcon size={15} aria-hidden />}
              label={`#${channel.name}`}
              onToggle={toggle}
            />
          ))}
        </TargetGroup>
        <TargetGroup
          contentId={`${pickerId}-whatsapp-groups`}
          title="WhatsApp groups"
          count={whatsappGroups.length}
          selectedCount={targets.filter((target) => target.type === "whatsapp_group").length}
          icon={<WhatsappLogoIcon size={15} aria-hidden />}
          forceOpen={Boolean(query && filteredWhatsapp.length > 0)}
          empty={
            whatsappGroups.length === 0
              ? "No WhatsApp groups are available."
              : filteredWhatsapp.length === 0
                ? "No WhatsApp groups match your search."
                : undefined
          }
        >
          {filteredWhatsapp.map((group) => (
            <TargetOption
              key={group.jid}
              target={{ type: "whatsapp_group", id: group.jid }}
              checked={selectedKeys.has(`whatsapp_group:${group.jid}`)}
              disabled={disabled}
              icon={<UsersThreeIcon size={15} aria-hidden />}
              label={group.name}
              onToggle={toggle}
            />
          ))}
        </TargetGroup>
        {totalAvailable > 0 && visibleCount === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
            No access targets match “{search}”. Try another search.
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <UserCircleIcon size={15} className="shrink-0" aria-hidden />
        <span>
          {targets.length === 0
            ? "Only you can use this connection."
            : `You and ${targets.length} shared ${targets.length === 1 ? "target" : "targets"} can use this connection.`}
        </span>
      </div>
    </div>
  );
}

function TargetGroup({
  contentId,
  title,
  count,
  selectedCount,
  icon,
  empty,
  forceOpen = false,
  children,
}: {
  contentId: string;
  title: string;
  count: number;
  selectedCount: number;
  icon: ReactNode;
  empty?: string;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const open = expanded || forceOpen;

  return (
    <CollapsiblePrimitive.Root open={open} onOpenChange={setExpanded} className="rounded-md">
      <CollapsiblePrimitive.Trigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground">
            {count}
          </Badge>
          {selectedCount > 0 ? (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0 text-[10px] text-primary"
              title={`${selectedCount} selected`}
              aria-label={`${selectedCount} selected`}
            >
              {selectedCount}/{count}
            </Badge>
          ) : null}
          <CaretDownIcon
            size={14}
            className={`shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content id={contentId} className="overflow-hidden">
        <div className="space-y-1 pt-2">
          {empty ? (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
              {empty}
            </p>
          ) : (
            children
          )}
        </div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

function TargetOption({
  target,
  checked,
  disabled,
  icon,
  label,
  description,
  onToggle,
}: {
  target: AgentEnvironmentShareTargetInput;
  checked: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  description?: string;
  onToggle: (target: AgentEnvironmentShareTargetInput) => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
        checked ? "border-primary/40 bg-primary/5" : "border-transparent hover:border-border hover:bg-muted/50"
      }`}
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onToggle(target)}
    >
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-md ${checked ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
      </span>
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}
      >
        {checked ? <CheckCircleIcon size={14} weight="fill" aria-hidden /> : null}
      </span>
    </button>
  );
}

function targetKey(target: AgentEnvironmentShareTargetInput): string {
  return `${target.type}:${target.id}`;
}

function sameTargets(first: AgentEnvironmentShareTargetInput[], second: AgentEnvironmentShareTargetInput[]): boolean {
  if (first.length !== second.length) return false;
  const secondKeys = new Set(second.map(targetKey));
  return first.every((target) => secondKeys.has(targetKey(target)));
}
