import { QuietAddButton } from "@/components/quiet-add-button";
import { api } from "@/lib/api";
import type { SlackChannelInfo, User, WhatsAppGroupInfo } from "@/lib/api";
import {
  CopySimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  LockIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  SpinnerGapIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import {
  type AgentEnvironmentShareTargetInput,
  type AgentEnvironmentVariableRecord,
  isReservedAgentEnvName,
} from "@sketch/shared";
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Label } from "@sketch/ui/components/label";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Switch } from "@sketch/ui/components/switch";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const MASKED_VALUE = "••••••••••••••••";

export function EnvironmentVariablesSection({
  variables,
  onAdd,
  onEdit,
  onDelete,
  onShare,
}: {
  variables: AgentEnvironmentVariableRecord[];
  onAdd: () => void;
  onEdit: (variable: AgentEnvironmentVariableRecord) => void;
  onDelete: (variable: AgentEnvironmentVariableRecord) => void;
  onShare: (variable: AgentEnvironmentVariableRecord) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">Environment variables</p>
        <QuietAddButton onClick={onAdd}>New variable</QuietAddButton>
      </div>

      {variables.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
            <LockIcon size={24} className="text-[#8B7A00]" />
          </div>
          <p className="mt-3 text-sm font-medium">No environment variables</p>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            Add credentials and config for Bash commands run by Sketch.
          </p>
          <QuietAddButton className="mt-4" onClick={onAdd}>
            New variable
          </QuietAddButton>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[minmax(160px,0.8fr)_minmax(0,1.4fr)] gap-4 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>Key</span>
            <span>Value</span>
          </div>
          {variables.map((variable, i) => (
            <EnvironmentVariableRow
              key={variable.id}
              variable={variable}
              isLast={i === variables.length - 1}
              onEdit={() => onEdit(variable)}
              onDelete={() => onDelete(variable)}
              onShare={() => onShare(variable)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EnvironmentVariableRow({
  variable,
  isLast,
  onEdit,
  onDelete,
  onShare,
}: {
  variable: AgentEnvironmentVariableRecord;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const value = variable.value ?? "";
  const isSharedWithOrg = hasOrgShare(variable.shares);
  const directShareCount = countDirectShareTargets(variable.shares);
  const directShareLabel = `${directShareCount} direct ${directShareCount === 1 ? "share" : "shares"}`;
  const shareBadgeLabel = isSharedWithOrg ? "All" : formatDirectShareCountBadge(directShareCount);
  const isManaged = Boolean(variable.managedBy);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      toast.success("Value copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Unable to copy value");
    }
  };

  return (
    <div
      className={`grid grid-cols-[minmax(160px,0.8fr)_minmax(0,1.4fr)] items-center gap-4 px-4 py-3 ${
        isLast ? "" : "border-b border-border"
      }`}
    >
      <div className="min-w-0">
        <span className="block truncate font-mono text-sm font-medium text-muted-foreground">{variable.name}</span>
        {isManaged && <span className="mt-1 block text-xs text-muted-foreground">Managed by {variable.managedBy}</span>}
      </div>

      <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-left transition-colors hover:bg-muted">
        {variable.isSecret ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-muted-foreground">
            <LockIcon size={15} weight="fill" />
            Secret
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">
            {revealed ? value : MASKED_VALUE}
          </span>
        )}
        <span className="flex items-center gap-1 text-muted-foreground">
          {isManaged ? (
            <span className="px-1 text-xs">Read-only</span>
          ) : (
            <>
              {!variable.isSecret && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRevealed((current) => !current);
                    }}
                    aria-label={revealed ? `Hide ${variable.name}` : `Reveal ${variable.name}`}
                  >
                    {revealed ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy();
                    }}
                    aria-label={`Copy ${variable.name}`}
                  >
                    {copied ? <span className="text-[10px] font-medium">OK</span> : <CopySimpleIcon size={14} />}
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="relative"
                onClick={(e) => {
                  e.stopPropagation();
                  onShare();
                }}
                aria-label={getShareButtonLabel(variable.name, isSharedWithOrg, directShareCount, directShareLabel)}
              >
                <ShareNetworkIcon size={14} />
                {(isSharedWithOrg || directShareCount > 0) && (
                  <span
                    aria-hidden="true"
                    className="-top-1 -right-1 pointer-events-none absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none font-semibold text-primary-foreground shadow-xs ring-2 ring-background"
                  >
                    {shareBadgeLabel}
                  </span>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                aria-label={`Edit ${variable.name}`}
              >
                <PencilSimpleIcon size={14} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                aria-label={`Delete ${variable.name}`}
              >
                <TrashIcon size={14} />
              </Button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

async function copyTextToClipboard(value: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Copy command failed");
  } finally {
    document.body.removeChild(textarea);
  }
}

function countDirectShareTargets(shares: AgentEnvironmentVariableRecord["shares"]): number {
  return shares.filter((share) => share.targetType !== "org").length;
}

function hasOrgShare(shares: AgentEnvironmentVariableRecord["shares"]): boolean {
  return shares.some((share) => share.targetType === "org");
}

function formatDirectShareCountBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function getShareButtonLabel(
  variableName: string,
  isSharedWithOrg: boolean,
  directShareCount: number,
  directShareLabel: string,
): string {
  if (isSharedWithOrg) return `Share ${variableName} (shared with entire org)`;
  if (directShareCount > 0) return `Share ${variableName} (${directShareLabel})`;
  return `Share ${variableName}`;
}

export function AddEnvironmentVariableDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [isSecret, setIsSecret] = useState(true);
  const trimmedName = name.trim();
  const isReservedName = isReservedAgentEnvName(trimmedName);

  const addMutation = useMutation({
    mutationFn: () => api.agentEnvironmentVariables.create({ name: trimmedName, value, isSecret }),
    onSuccess: () => {
      toast.success("Environment variable saved");
      resetAndClose();
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetAndClose = () => {
    setName("");
    setValue("");
    setIsSecret(true);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add environment variable</DialogTitle>
          <DialogDescription>Available to Sketch agent Bash commands in your DMs.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="env-var-name">Name</Label>
            <Input
              id="env-var-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="BACKEND_API_URL"
              disabled={addMutation.isPending}
              className="font-mono text-xs"
              aria-invalid={isReservedName}
            />
            {isReservedName && (
              <p className="text-xs text-destructive">This environment variable name is reserved by Sketch.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="env-var-value">Value</Label>
            <Input
              id="env-var-value"
              type={isSecret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={addMutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/30 px-3 py-3">
            <div>
              <p className="text-sm font-medium">Secret value</p>
              <p className="mt-1 text-xs text-muted-foreground">Secret values cannot be revealed or copied later.</p>
            </div>
            <Switch checked={isSecret} onCheckedChange={setIsSecret} disabled={addMutation.isPending} />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={addMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={!trimmedName || isReservedName || addMutation.isPending}
          >
            {addMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save variable"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditEnvironmentVariableDialog({
  variable,
  onOpenChange,
  onSuccess,
}: {
  variable: AgentEnvironmentVariableRecord | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [value, setValue] = useState("");
  const [lastVariableId, setLastVariableId] = useState<string | null>(null);
  if (variable && variable.id !== lastVariableId) {
    setValue("");
    setLastVariableId(variable.id);
  }
  if (!variable && lastVariableId) {
    setLastVariableId(null);
  }

  const updateMutation = useMutation({
    mutationFn: () => api.agentEnvironmentVariables.update(variable?.id ?? "", { value }),
    onSuccess: () => {
      toast.success("Environment variable updated");
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={!!variable} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit environment variable</DialogTitle>
          <DialogDescription>Replace the value for this variable.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-env-var-name">Name</Label>
            <Input
              id="edit-env-var-name"
              value={variable?.name ?? ""}
              disabled
              readOnly
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-env-var-value">New value</Label>
            <Input
              id="edit-env-var-value"
              type={variable?.isSecret ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter a new value"
              disabled={updateMutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The variable name and secret setting cannot be changed after creation.
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={updateMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => updateMutation.mutate()} disabled={!value || updateMutation.isPending}>
            {updateMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Updating...
              </>
            ) : (
              "Update value"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShareEnvironmentVariableDialog({
  variable,
  users,
  usersLoading,
  slackChannels,
  whatsappGroups,
  currentUserId,
  isAdmin,
  slackChannelsLoading,
  slackChannelsUnavailable,
  whatsappGroupsLoading,
  onOpenChange,
  onSuccess,
}: {
  variable: AgentEnvironmentVariableRecord | null;
  users: User[];
  usersLoading: boolean;
  slackChannels: SlackChannelInfo[];
  whatsappGroups: WhatsAppGroupInfo[];
  currentUserId?: string;
  isAdmin: boolean;
  slackChannelsLoading: boolean;
  slackChannelsUnavailable: boolean;
  whatsappGroupsLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastVariableId, setLastVariableId] = useState<string | null>(null);
  const availableUsers = useMemo(
    () => users.filter((user) => user.type !== "external" && user.id !== currentUserId),
    [currentUserId, users],
  );

  useEffect(() => {
    if (variable && variable.id !== lastVariableId) {
      setSelected(new Set(variable.shares.map((share) => shareTargetKey(share.targetType, share.targetId))));
      setLastVariableId(variable.id);
    }
    if (!variable && lastVariableId) {
      setSelected(new Set());
      setLastVariableId(null);
    }
  }, [lastVariableId, variable]);

  const saveMutation = useMutation({
    mutationFn: () => api.agentEnvironmentVariables.replaceShares(variable?.id ?? "", [...selected].map(parseShareKey)),
    onSuccess: () => {
      toast.success("Sharing updated");
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleTarget = (target: AgentEnvironmentShareTargetInput, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      const key = shareTargetKey(target.type, target.id);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return (
    <Dialog open={!!variable} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share {variable?.name}</DialogTitle>
          <DialogDescription>
            Shared variables are injected into agent runs for selected users, channels, groups, or the entire org.
            Recipients cannot view the value.
          </DialogDescription>
        </DialogHeader>

        <div className="h-[min(58vh,520px)] space-y-5 overflow-y-auto py-2 pr-1">
          <ShareTargetSection title="Entire org">
            <ShareTargetCheckbox
              title="Entire org"
              subtitle={isAdmin ? "All agent runs across the workspace" : "Admin access is required"}
              checked={selected.has(shareTargetKey("org", "default"))}
              disabled={!isAdmin || saveMutation.isPending}
              onCheckedChange={(checked) => toggleTarget({ type: "org", id: "default" }, checked)}
            />
          </ShareTargetSection>

          <ShareTargetSection title="Users">
            {usersLoading ? (
              <ShareTargetSkeletonList label="Loading users" />
            ) : availableUsers.length === 0 ? (
              <ShareEmptyState>No other human users are available.</ShareEmptyState>
            ) : (
              availableUsers.map((user) => (
                <ShareTargetCheckbox
                  key={user.id}
                  title={user.name}
                  subtitle={user.email ?? undefined}
                  checked={selected.has(shareTargetKey("user", user.id))}
                  disabled={saveMutation.isPending}
                  onCheckedChange={(checked) => toggleTarget({ type: "user", id: user.id }, checked)}
                />
              ))
            )}
          </ShareTargetSection>

          <ShareTargetSection title="Slack channels">
            {slackChannelsLoading ? (
              <ShareTargetSkeletonList label="Loading Slack channels" />
            ) : slackChannelsUnavailable ? (
              <ShareEmptyState>Slack must be connected before channels can receive shared variables.</ShareEmptyState>
            ) : slackChannels.length === 0 ? (
              <ShareEmptyState>No Slack channels are available.</ShareEmptyState>
            ) : (
              slackChannels.map((channel) => (
                <ShareTargetCheckbox
                  key={channel.id}
                  title={`#${channel.name}`}
                  checked={selected.has(shareTargetKey("slack_channel", channel.id))}
                  disabled={saveMutation.isPending}
                  onCheckedChange={(checked) => toggleTarget({ type: "slack_channel", id: channel.id }, checked)}
                />
              ))
            )}
          </ShareTargetSection>

          <ShareTargetSection title="WhatsApp groups">
            {whatsappGroupsLoading ? (
              <ShareTargetSkeletonList label="Loading WhatsApp groups" />
            ) : whatsappGroups.length === 0 ? (
              <ShareEmptyState>No WhatsApp groups have been seen yet.</ShareEmptyState>
            ) : (
              whatsappGroups.map((group) => (
                <ShareTargetCheckbox
                  key={group.jid}
                  title={group.name}
                  checked={selected.has(shareTargetKey("whatsapp_group", group.jid))}
                  disabled={saveMutation.isPending}
                  onCheckedChange={(checked) => toggleTarget({ type: "whatsapp_group", id: group.jid }, checked)}
                />
              ))
            )}
          </ShareTargetSection>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={saveMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => saveMutation.mutate()} disabled={!variable || saveMutation.isPending}>
            {saveMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save sharing"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareTargetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function ShareTargetCheckbox({
  title,
  subtitle,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex min-h-12 items-center gap-3 rounded-md border border-border px-3 py-2 transition-colors ${
        disabled ? "cursor-not-allowed bg-muted/30 opacity-70" : "cursor-pointer hover:bg-muted/50"
      }`}
    >
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
    </label>
  );
}

function ShareTargetSkeletonList({ label }: { label: string }) {
  return (
    <div aria-label={label} className="space-y-2">
      {["one", "two", "three"].map((key) => (
        <div key={key} className="flex min-h-12 items-center gap-3 rounded-md border border-border px-3 py-2">
          <Skeleton className="size-4 shrink-0 rounded" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-20" />
          </span>
        </div>
      ))}
    </div>
  );
}

function ShareEmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function shareTargetKey(type: AgentEnvironmentShareTargetInput["type"], id: string): string {
  return `${type}:${id}`;
}

function parseShareKey(key: string): AgentEnvironmentShareTargetInput {
  const index = key.indexOf(":");
  return {
    type: key.slice(0, index) as AgentEnvironmentShareTargetInput["type"],
    id: key.slice(index + 1),
  };
}

export function DeleteEnvironmentVariableDialog({
  variable,
  onOpenChange,
  onSuccess,
}: {
  variable: AgentEnvironmentVariableRecord | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const deleteMutation = useMutation({
    mutationFn: () => api.agentEnvironmentVariables.remove(variable?.id ?? ""),
    onSuccess: () => {
      toast.success("Environment variable deleted");
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <AlertDialog open={!!variable} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {variable?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Sketch will stop injecting this variable into your DM Bash commands.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
