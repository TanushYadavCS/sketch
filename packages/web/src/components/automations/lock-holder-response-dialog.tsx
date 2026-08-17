/**
 * AutomationLockHolderResponseDialog — holder side of a pending takeover.
 *
 * Surfaces from the lock banner when `stealPending` is present while the
 * viewer holds the lock. Approving transfers the lock to the requester
 * (the polled lock view then flips the builder to read-only); denying leaves
 * the lock with the viewer.
 */
import type { AutomationEditLockView } from "@/lib/api";
import { api } from "@/lib/api";
import { SpinnerGapIcon, UserFocusIcon } from "@phosphor-icons/react";
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
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

export function AutomationLockHolderResponseDialog({
  taskId,
  open,
  onOpenChange,
  lock,
  lease,
  onResponded,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lock: AutomationEditLockView | null;
  lease: { clientSessionId: string; generation: number } | null;
  onResponded?: (lock: AutomationEditLockView) => void;
}) {
  const requesterName = lock?.stealPending?.requesterName ?? "Another member";
  const respondMutation = useMutation({
    mutationFn: (approve: boolean) => {
      if (!lease) throw new Error("The editing session is no longer active");
      return api.scheduledTasks.respondToStealRequest(taskId, approve, lease);
    },
    onSuccess: ({ lock: nextLock }, approve) => {
      if (nextLock) onResponded?.(nextLock);
      toast.success(approve ? `Editing handed over to ${requesterName}` : "Takeover request denied");
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not respond to the takeover request"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="automation-lock-holder-response-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">Takeover request</DialogTitle>
          <DialogDescription className="text-xs">
            {requesterName} wants to take over editing this automation. If you approve, they get the lock immediately
            and this view becomes read-only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 rounded-[8px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] text-foreground/85">
          <UserFocusIcon size={15} className="shrink-0 text-amber-700 dark:text-amber-300" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{requesterName}</span> is waiting to take over editing
          </span>
        </div>

        <DialogFooter className="sm:justify-between">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Keep editing
            </Button>
          </DialogClose>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-[7px] border-border/70 bg-background px-3 text-[12px] shadow-none"
              disabled={respondMutation.isPending}
              onClick={() => respondMutation.mutate(false)}
            >
              {respondMutation.isPending && respondMutation.variables === false ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : null}
              Deny takeover
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent px-3 text-[12px] text-[#161300] shadow-none hover:bg-brand-accent/90"
              disabled={respondMutation.isPending}
              onClick={() => respondMutation.mutate(true)}
            >
              {respondMutation.isPending && respondMutation.variables === true ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : (
                <UserFocusIcon size={14} />
              )}
              Approve takeover
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
