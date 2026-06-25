/**
 * FileShareDialog — Google Drive style sharing for an indexed file.
 *
 * Mirrors the manage-shares contract on the server: emails go into
 * file_share_emails, the org-wide flag goes onto indexed_files. Connector
 * reconcile never touches these so manual shares survive resyncs.
 *
 * The calling component passes owning-connector capabilities. Email shares require
 * canManage; org-wide sharing is additionally admin-only.
 */
import { api } from "@/lib/api";
import type { FileManualShare, User } from "@/lib/api";
import { GlobeIcon, LockSimpleIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";
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
import { Switch } from "@sketch/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface FileShareDialogProps {
  fileId: string;
  fileName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  canShareWithEveryone: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim());
}

export function FileShareDialog({
  fileId,
  fileName,
  open,
  onOpenChange,
  canManage,
  canShareWithEveryone,
}: FileShareDialogProps) {
  const queryClient = useQueryClient();

  const sharesQuery = useQuery({
    queryKey: ["file-shares", fileId],
    queryFn: () => api.integrations.listFileShares(fileId),
    enabled: open,
  });

  const usersQuery = useQuery({
    queryKey: ["users-for-share"],
    queryFn: () => api.users.list(),
    enabled: open,
    staleTime: 60_000,
  });

  const [pendingEmails, setPendingEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [orgWideDraft, setOrgWideDraft] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) {
      setPendingEmails([]);
      setDraft("");
      setOrgWideDraft(null);
    }
  }, [open]);

  const currentEmails = useMemo(() => sharesQuery.data?.shares.map((s) => s.email) ?? [], [sharesQuery.data]);
  const finalEmails = useMemo(() => {
    const combined = new Set([...currentEmails, ...pendingEmails]);
    return [...combined];
  }, [currentEmails, pendingEmails]);
  const currentOrgWide = sharesQuery.data?.shareWithEveryone ?? false;
  const effectiveOrgWide = orgWideDraft ?? currentOrgWide;

  const updateMutation = useMutation({
    mutationFn: () =>
      api.integrations.updateFileShares(fileId, {
        emails: finalEmails.map((e) => e.toLowerCase()),
        shareWithEveryone: orgWideDraft ?? undefined,
      }),
    onSuccess: () => {
      toast.success("Sharing updated");
      queryClient.invalidateQueries({ queryKey: ["file-shares", fileId] });
      queryClient.invalidateQueries({ queryKey: ["file-content", fileId] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (email: string) => api.integrations.revokeFileShare(fileId, email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["file-shares", fileId] });
      queryClient.invalidateQueries({ queryKey: ["file-content", fileId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function tryAddEmail() {
    if (!canManage) return;
    const value = draft.trim().toLowerCase();
    if (!value) return;
    if (!isEmail(value)) {
      toast.error("Enter a valid email");
      return;
    }
    if (finalEmails.includes(value)) {
      setDraft("");
      return;
    }
    setPendingEmails((prev) => [...prev, value]);
    setDraft("");
  }

  function removePending(email: string) {
    setPendingEmails((prev) => prev.filter((e) => e !== email));
  }

  const hasOrgWideChange = orgWideDraft !== null && orgWideDraft !== currentOrgWide;
  const hasPendingEmails = pendingEmails.length > 0;
  const canSave = canManage && (hasPendingEmails || hasOrgWideChange) && (!hasOrgWideChange || canShareWithEveryone);

  const suggestions = useMemo(() => {
    const draftLower = draft.trim().toLowerCase();
    if (!draftLower) return [];
    const used = new Set(finalEmails);
    return (usersQuery.data?.users ?? [])
      .map((u) => u.email)
      .filter((email): email is string => !!email)
      .map((email) => email.toLowerCase())
      .filter((email) => email.includes(draftLower) && !used.has(email))
      .slice(0, 5);
  }, [draft, finalEmails, usersQuery.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Share "{fileName}"</DialogTitle>
          <DialogDescription className="text-xs">
            People you add can read this file's contents regardless of the underlying connector access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Add people</p>
            <div className="flex gap-2">
              <Input
                placeholder="name@example.com"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    tryAddEmail();
                  }
                }}
                className="text-sm"
                disabled={!canManage}
              />
              <Button size="sm" variant="outline" onClick={tryAddEmail} disabled={!canManage || !draft.trim()}>
                Add
              </Button>
            </div>
            {suggestions.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {suggestions.map((email) => (
                  <button
                    type="button"
                    key={email}
                    className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted"
                    onClick={() => {
                      if (!canManage) return;
                      setPendingEmails((prev) => (prev.includes(email) ? prev : [...prev, email]));
                      setDraft("");
                    }}
                    disabled={!canManage}
                  >
                    {email}
                  </button>
                ))}
              </div>
            )}
          </div>

          {sharesQuery.data?.shares.length || pendingEmails.length ? (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                People with access
              </p>
              <div className="space-y-1.5">
                {sharesQuery.data?.shares.map((share) => (
                  <ShareRow
                    key={share.email}
                    share={share}
                    user={usersQuery.data?.users.find((u) => u.email?.toLowerCase() === share.email)}
                    onRevoke={() => revokeMutation.mutate(share.email)}
                    canManage={canManage}
                    isRevoking={revokeMutation.isPending && revokeMutation.variables === share.email}
                  />
                ))}
                {pendingEmails.map((email) => (
                  <div
                    key={email}
                    className="flex items-center justify-between rounded-md border border-dashed border-border bg-muted/20 px-2.5 py-1.5 text-xs"
                  >
                    <span className="truncate">{email}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">Pending</span>
                      <button
                        type="button"
                        onClick={() => removePending(email)}
                        disabled={!canManage}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${email}`}
                      >
                        <XIcon size={12} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-border px-3 py-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {effectiveOrgWide ? (
                  <GlobeIcon size={14} className="text-muted-foreground" />
                ) : (
                  <LockSimpleIcon size={14} className="text-muted-foreground" />
                )}
                <div>
                  <p className="text-xs font-medium">{effectiveOrgWide ? "Anyone in the org" : "Restricted"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {effectiveOrgWide
                      ? "Every authenticated user in the org can read this file."
                      : "Only the people listed above and connector-derived access apply."}
                  </p>
                </div>
              </div>
              <Switch
                checked={effectiveOrgWide}
                onCheckedChange={(value) => setOrgWideDraft(value)}
                aria-label="Share with everyone in the org"
                disabled={!canShareWithEveryone}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={() => updateMutation.mutate()} disabled={!canSave || updateMutation.isPending}>
            {updateMutation.isPending ? (
              <>
                <SpinnerGapIcon size={12} className="animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareRow({
  share,
  user,
  onRevoke,
  canManage,
  isRevoking,
}: {
  share: FileManualShare;
  user?: User;
  onRevoke: () => void;
  canManage: boolean;
  isRevoking: boolean;
}) {
  const displayName = user?.name ?? share.email;
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{displayName}</p>
        {user?.name && <p className="truncate text-[11px] text-muted-foreground">{share.email}</p>}
      </div>
      <button
        type="button"
        onClick={onRevoke}
        disabled={!canManage || isRevoking}
        className="ml-2 text-muted-foreground hover:text-destructive disabled:opacity-50"
        aria-label={`Revoke ${share.email}`}
      >
        {isRevoking ? <SpinnerGapIcon size={12} className="animate-spin" /> : <XIcon size={12} />}
      </button>
    </div>
  );
}
