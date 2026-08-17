/**
 * AutomationShareDialog — per-person sharing for an automation.
 *
 * Every org member is listed with an on/off toggle; only the automation owner
 * can grant or revoke (the trigger button is owner-only and toggles are
 * additionally disabled when `canShare` is false). Shared members can run and
 * edit the automation, so the dialog copy states that runs execute with the
 * owner's integrations and deliver to the owner's destinations.
 *
 * Toggling is optimistic: the switch flips immediately and rolls back on
 * error. Grant/revoke endpoints are idempotent per the API contract.
 */
import { api } from "@/lib/api";
import { invalidateAutomationQueries } from "@/lib/automation-refresh";
import { MagnifyingGlassIcon, ShareNetworkIcon, SpinnerGapIcon } from "@phosphor-icons/react";
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

interface AutomationShareDialogProps {
  taskId: string;
  taskName: string;
  ownerUserId: string | null | undefined;
  canShare: boolean;
  lease?: { clientSessionId: string; generation: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SHARES_QUERY_KEY = (taskId: string) => ["automation-shares", taskId] as const;

export function AutomationShareDialog({
  taskId,
  taskName,
  ownerUserId,
  canShare,
  lease,
  open,
  onOpenChange,
}: AutomationShareDialogProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  const sharesQuery = useQuery({
    queryKey: SHARES_QUERY_KEY(taskId),
    queryFn: () => api.scheduledTasks.listShares(taskId),
    enabled: open,
  });

  const usersQuery = useQuery({
    queryKey: ["users-for-automation-share"],
    queryFn: () => api.users.list(),
    enabled: open,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) {
      setQuery("");
      setOptimistic({});
    }
  }, [open]);

  const shares = sharesQuery.data?.shares ?? [];
  const grantedUserIds = useMemo(() => {
    const granted = new Set(shares.map((share) => share.userId));
    for (const [userId, isGranted] of Object.entries(optimistic)) {
      if (isGranted) {
        granted.add(userId);
      } else {
        granted.delete(userId);
      }
    }
    return granted;
  }, [optimistic, shares]);

  const members = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (
      (usersQuery.data?.users ?? [])
        // Admins already have access to every automation; listing them as share
        // targets would be redundant, so they are excluded from the picker.
        .filter((user) => user.auth_role !== "admin")
        .filter((user) => user.id !== ownerUserId)
        .filter(
          (user) =>
            !normalizedQuery ||
            user.name.toLowerCase().includes(normalizedQuery) ||
            (user.email ?? "").toLowerCase().includes(normalizedQuery),
        )
        .sort((left, right) => left.name.localeCompare(right.name))
    );
  }, [ownerUserId, query, usersQuery.data]);

  const toggleMutation = useMutation({
    mutationFn: ({ userId, grant }: { userId: string; grant: boolean }) =>
      grant
        ? api.scheduledTasks.grantShare(taskId, userId, lease ?? undefined)
        : api.scheduledTasks.revokeShare(taskId, userId, lease ?? undefined),
    onMutate: async ({ userId, grant }) => {
      await queryClient.cancelQueries({ queryKey: SHARES_QUERY_KEY(taskId) });
      setOptimistic((previous) => ({ ...previous, [userId]: grant }));
      return { userId };
    },
    onError: (error, variables) => {
      setOptimistic((previous) => {
        const next = { ...previous };
        delete next[variables.userId];
        return next;
      });
      toast.error(error instanceof Error ? error.message : "Failed to update sharing");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY(taskId) });
      void invalidateAutomationQueries(queryClient, [taskId]);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Share "{taskName}"</DialogTitle>
          <DialogDescription className="text-xs">
            People you share with can run and edit this automation. Runs always execute with your integrations and
            deliver to your destinations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Members</p>
            <div className="relative">
              <MagnifyingGlassIcon
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search members by name or email"
                aria-label="Search members"
                className="pl-7 text-sm"
              />
            </div>
          </div>

          {sharesQuery.isLoading || usersQuery.isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <SpinnerGapIcon size={16} className="animate-spin" />
            </div>
          ) : members.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {query.trim() ? "No members match this search." : "No other members in this workspace yet."}
            </p>
          ) : (
            <div className="max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
              {members.map((user) => {
                const isGranted = grantedUserIds.has(user.id);
                const isMutating = toggleMutation.isPending && toggleMutation.variables?.userId === user.id;
                return (
                  <div
                    key={user.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-2.5 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{user.name}</p>
                      {user.email ? <p className="truncate text-[11px] text-muted-foreground">{user.email}</p> : null}
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {isMutating ? <SpinnerGapIcon size={12} className="animate-spin text-muted-foreground" /> : null}
                      <Switch
                        checked={isGranted}
                        disabled={!canShare || isMutating}
                        onCheckedChange={(grant) => toggleMutation.mutate({ userId: user.id, grant })}
                        aria-label={`Share with ${user.name}`}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {!canShare ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShareNetworkIcon size={12} />
              Only the owner can change sharing
            </span>
          ) : null}
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Done
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
