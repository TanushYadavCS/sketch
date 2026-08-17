/**
 * AutomationLockStealDialog — requester side of the whole-automation edit lock.
 *
 * The viewer (read-only because another member holds the lock) requests a
 * takeover here. The backend only returns `{ status: "pending" }`; whether the
 * request was approved, denied, or expired is learned from the lock view that
 * the builder polls, so the dialog watches the live `lock` prop:
 *
 * - `lock.isHeldByMe` becomes true  -> approved: toast + close (heartbeat
 *   starts in the builder once the viewer is the holder)
 * - `stealPending` disappears       -> denied: toast + terminal state
 * - the request deadline passes     -> expired: timeout state + toast
 */
import {
  AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS,
  lockRemainingLabel,
  useLockNow,
} from "@/components/automations/lock-banner";
import type { AutomationEditLockView } from "@/lib/api";
import { api } from "@/lib/api";
import { HourglassMediumIcon, LockKeyIcon, SpinnerGapIcon, XCircleIcon } from "@phosphor-icons/react";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type StealPhase = "confirm" | "waiting" | "denied" | "expired";

export function AutomationLockStealDialog({
  taskId,
  open,
  onOpenChange,
  lock,
  clientSessionId,
  generation,
  onRequested,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lock: AutomationEditLockView | null;
  clientSessionId: string;
  generation?: number;
  onRequested?: () => void;
}) {
  const [phase, setPhase] = useState<StealPhase>("confirm");
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const sawPendingRef = useRef(false);
  const resolvedRef = useRef(false);
  const holderName = lock?.heldByName ?? "the current editor";
  const heldByMyOtherSession = lock?.isHeldByMyOtherSession === true;
  const stealPending = lock?.stealPending ?? null;
  const now = useLockNow(phase === "waiting");

  const stealMutation = useMutation({
    mutationFn: () =>
      api.scheduledTasks.requestSteal(taskId, {
        clientSessionId,
        ...(generation === undefined ? {} : { generation }),
      }),
    onSuccess: () => {
      onRequested?.();
      setRequestedAt(Date.now());
      setPhase("waiting");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Takeover request failed"),
  });

  useEffect(() => {
    if (!open) {
      setPhase("confirm");
      setRequestedAt(null);
      sawPendingRef.current = false;
      resolvedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (phase === "waiting" && stealPending) sawPendingRef.current = true;
  }, [phase, stealPending]);

  const deadline = useMemo(() => {
    if (stealPending?.expiresAt) return new Date(stealPending.expiresAt).getTime();
    return requestedAt ? requestedAt + AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS : null;
  }, [requestedAt, stealPending?.expiresAt]);

  useEffect(() => {
    if (phase !== "waiting" || resolvedRef.current) return;
    if (lock?.isHeldByMe) {
      resolvedRef.current = true;
      toast.success("You're now editing");
      onOpenChange(false);
      return;
    }
    if (sawPendingRef.current && !stealPending) {
      resolvedRef.current = true;
      toast.error("Your takeover request was not approved");
      setPhase("denied");
      return;
    }
    if (deadline !== null && now >= deadline) {
      resolvedRef.current = true;
      toast.error("Your takeover request expired");
      setPhase("expired");
    }
  }, [deadline, lock?.isHeldByMe, now, onOpenChange, phase, stealPending]);

  const waitingCountdown = useMemo(() => {
    if (deadline === null) return null;
    return lockRemainingLabel(new Date(deadline).toISOString(), now);
  }, [deadline, now]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="automation-lock-steal-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">
            {phase === "confirm"
              ? "Take over editing?"
              : phase === "waiting"
                ? "Waiting for approval"
                : phase === "denied"
                  ? "Request not approved"
                  : "Request expired"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {phase === "confirm" ? (
              <>
                {heldByMyOtherSession
                  ? "This automation is open in another one of your sessions. Sketch will ask that session to approve the takeover — until it does, the workflow stays read-only."
                  : `${holderName} is currently editing this automation. Sketch will ask them to approve the takeover — until they do, the workflow stays read-only.`}
              </>
            ) : phase === "waiting" ? (
              <>Waiting for {holderName} to approve. This automation is still read-only for now.</>
            ) : phase === "denied" ? (
              <>You can try again later, or wait for the editing lease to expire.</>
            ) : (
              <>The holder did not respond in time. You can request the takeover again.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {phase === "waiting" ? (
          <div className="flex items-center gap-2.5 rounded-[8px] border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] text-foreground/85">
            <SpinnerGapIcon size={15} className="shrink-0 animate-spin text-amber-700 dark:text-amber-300" />
            <span className="min-w-0 flex-1">
              Waiting for <span className="font-medium">{holderName}</span> to approve
            </span>
            {waitingCountdown ? (
              <span
                data-testid="automation-lock-steal-countdown"
                className="shrink-0 font-mono text-[10px] text-muted-foreground"
              >
                expires in {waitingCountdown}
              </span>
            ) : null}
          </div>
        ) : null}

        {phase === "denied" || phase === "expired" ? (
          <div
            data-testid="automation-lock-steal-outcome"
            className="flex items-center gap-2.5 rounded-[8px] border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-[12px] text-destructive"
          >
            {phase === "expired" ? (
              <HourglassMediumIcon size={15} className="shrink-0" />
            ) : (
              <XCircleIcon size={15} weight="fill" className="shrink-0" />
            )}
            <span>{phase === "expired" ? "The takeover request expired." : "The holder denied the takeover."}</span>
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          {phase === "confirm" ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <LockKeyIcon size={12} />
              {heldByMyOtherSession ? "Only the other session can approve" : `Only ${holderName} can approve`}
            </span>
          ) : null}
          {phase === "confirm" ? (
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                size="sm"
                className="h-8 gap-1.5 rounded-[7px] bg-brand-accent px-3 text-[12px] text-[#161300] shadow-none hover:bg-brand-accent/90"
                disabled={stealMutation.isPending}
                onClick={() => stealMutation.mutate()}
              >
                {stealMutation.isPending ? (
                  <SpinnerGapIcon size={14} className="animate-spin" />
                ) : (
                  <LockKeyIcon size={14} />
                )}
                Request takeover
              </Button>
            </div>
          ) : (
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Close
              </Button>
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
