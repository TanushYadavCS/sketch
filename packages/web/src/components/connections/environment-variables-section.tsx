import { api } from "@/lib/api";
import {
  CopySimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  LockIcon,
  PencilSimpleIcon,
  PlusIcon,
  SpinnerGapIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type AgentEnvironmentVariableRecord, isReservedAgentEnvName } from "@sketch/shared";
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
import { Switch } from "@sketch/ui/components/switch";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

const MASKED_VALUE = "••••••••••••••••";

export function EnvironmentVariablesSection({
  variables,
  onAdd,
  onEdit,
  onDelete,
}: {
  variables: AgentEnvironmentVariableRecord[];
  onAdd: () => void;
  onEdit: (variable: AgentEnvironmentVariableRecord) => void;
  onDelete: (variable: AgentEnvironmentVariableRecord) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">Environment variables</p>
        <Button variant="ghost" size="sm" className="gap-1.5 hover:bg-brand-accent/8" onClick={onAdd}>
          <PlusIcon size={14} weight="bold" />
          New variable
        </Button>
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
          <Button variant="ghost" size="sm" className="mt-4 gap-1.5 hover:bg-brand-accent/8" onClick={onAdd}>
            <PlusIcon size={14} weight="bold" />
            New variable
          </Button>
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
}: {
  variable: AgentEnvironmentVariableRecord;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const value = variable.value ?? "";

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
      <span className="truncate font-mono text-sm font-medium text-muted-foreground">{variable.name}</span>

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
