import { api } from "@/lib/api";
import {
  CopySimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
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
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { dashboardRoute, useDashboardAuth } from "./dashboard";

const MASKED_VALUE = "********************************";

export const settingsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/settings",
  component: SettingsPage,
});

function SettingsPage() {
  const auth = useDashboardAuth();

  if (auth.role !== "admin") {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">Admin access is required to manage workspace settings.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <h1 className="text-xl font-semibold text-foreground">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">Manage workspace-level configuration.</p>

      <div className="mt-6 space-y-8">
        <ApiKeySection />
      </div>
    </div>
  );
}

function ApiKeySection() {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const keyQuery = useQuery({
    queryKey: ["settings", "api-key"],
    queryFn: () => api.settings.apiKey(),
  });

  const generateMutation = useMutation({
    mutationFn: () => api.settings.generateApiKey(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "api-key"] });
      setRevealed(true);
      toast.success("API key generated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: () => api.settings.revokeApiKey(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "api-key"] });
      setRevealed(false);
      setConfirmRevoke(false);
      toast.success("API key revoked");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const apiKey = keyQuery.data?.apiKey ?? "";
  const configured = keyQuery.data?.configured === true;
  const isBusy = generateMutation.isPending || revokeMutation.isPending;

  const handleCopy = async () => {
    if (!apiKey) return;
    try {
      await copyTextToClipboard(apiKey);
      setCopied(true);
      toast.success("API key copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Unable to copy API key");
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">API access</p>
        {configured ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 hover:bg-brand-accent/8"
            onClick={() => setConfirmRegenerate(true)}
            disabled={isBusy}
          >
            <KeyIcon size={14} weight="bold" />
            Regenerate
          </Button>
        ) : null}
      </div>

      {keyQuery.isLoading ? (
        <Skeleton className="h-32 rounded-lg" />
      ) : !configured ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
            <KeyIcon size={24} className="text-[#8B7A00]" />
          </div>
          <p className="mt-3 text-sm font-medium">No API key generated</p>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            Generate a key for trusted systems that need to invoke Sketch through the API.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-4 gap-1.5 hover:bg-brand-accent/8"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending ? <SpinnerGapIcon size={14} className="animate-spin" /> : <KeyIcon size={14} />}
            Generate key
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <Input
              value={revealed ? apiKey : MASKED_VALUE}
              readOnly
              className="h-9 flex-1 font-mono text-xs"
              aria-label="Sketch API key"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setRevealed((current) => !current)}
              aria-label={revealed ? "Hide API key" : "Reveal API key"}
            >
              {revealed ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleCopy} aria-label="Copy API key">
              {copied ? <span className="text-[10px] font-medium">OK</span> : <CopySimpleIcon size={16} />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="hover:text-destructive"
              onClick={() => setConfirmRevoke(true)}
              aria-label="Revoke API key"
              disabled={isBusy}
            >
              <TrashIcon size={16} />
            </Button>
          </div>
          <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <WarningIcon size={14} className="mt-px shrink-0" />
            <p>
              Anyone with this key can invoke Sketch through the external API. Regenerate it if access is shared
              accidentally.
            </p>
          </div>
        </div>
      )}

      <AlertDialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The current key will stop working immediately. Systems using it must be updated with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={generateMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                generateMutation.mutate();
                setConfirmRegenerate(false);
              }}
              disabled={generateMutation.isPending}
            >
              {generateMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Regenerating...
                </>
              ) : (
                "Regenerate"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>
              API clients using this key will lose access immediately. You can generate a new key later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => revokeMutation.mutate()}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? (
                <>
                  <SpinnerGapIcon size={14} className="animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
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
