import type { AutomationEditLockView } from "@/lib/api";
/**
 * AutomationLockBanner — toolbar strip for the whole-automation edit lock.
 *
 * The backend contract carries no "acquired at" timestamp, only the lease
 * `expiresAt` plus a fixed 15-minute TTL, so the "editing since" label is
 * derived as `expiresAt - TTL`. The banner renders three states:
 *
 * - held by another member: read-only hint + "Take over editing" entry point
 * - held by the viewer: "You're editing"
 * - held by the viewer with a pending steal request: prompt that opens the
 *   holder response dialog (approve/deny)
 *
 * The viewer's lock state is driven by polling the definition endpoint (see
 * the builder), so this component is purely presentational.
 */
import { LockIcon, LockSimpleIcon, UserFocusIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { cn } from "@sketch/ui/lib/utils";
import { useEffect, useState } from "react";

export const AUTOMATION_EDIT_LOCK_TTL_MS = 90 * 1000;
export const AUTOMATION_EDIT_LOCK_HEARTBEAT_INTERVAL_MS = 20 * 1000;
export const AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS = 10 * 1000;
export const AUTOMATION_EDIT_LOCK_STEAL_REQUEST_TTL_MS = 60 * 1000;

/**
 * Live clock that only ticks while `active`, so closed dialogs and unlocked
 * builders never re-render on a timer.
 */
export function useLockNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function formatLockClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * "Editing since" label: the lock contract exposes only the lease expiry, so
 * the acquisition time is reconstructed as `expiresAt - TTL`.
 */
export function lockSinceLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const acquiredAt = new Date(expiresAt).getTime() - AUTOMATION_EDIT_LOCK_TTL_MS;
  if (Number.isNaN(acquiredAt)) return null;
  return formatLockClock(new Date(acquiredAt).toISOString());
}

/** mm:ss remaining until the given ISO deadline, floored at zero. */
export function lockRemainingLabel(expiresAt: string | null, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(remainingMs)) return null;
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function AutomationLockBanner({
  lock,
  canEdit,
  onRequestTakeover,
  onReviewStealRequest,
}: {
  lock: AutomationEditLockView | null;
  canEdit: boolean;
  onRequestTakeover: () => void;
  onReviewStealRequest: () => void;
}) {
  if (!lock?.heldByUserId) return null;

  if (lock.isHeldByMe) {
    const stealPending = lock.stealPending;
    return (
      <div
        data-testid="automation-lock-banner"
        data-lock-state="held-by-me"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[8px] border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-1.5 text-[11px] font-medium text-foreground/85 shadow-md backdrop-blur"
      >
        <LockSimpleIcon size={13} weight="fill" className="shrink-0 text-emerald-700 dark:text-emerald-300" />
        <span>You're editing</span>
        {stealPending ? (
          <>
            <span aria-hidden className="text-muted-foreground/60">
              ·
            </span>
            <span className="min-w-0 truncate text-amber-700 dark:text-amber-300">
              {stealPending.requesterName} wants to take over editing
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 rounded-[6px] border-border/70 bg-card/80 px-2 text-[11px] shadow-none hover:bg-muted"
              onClick={onReviewStealRequest}
            >
              <UserFocusIcon size={12} />
              Review request
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  const since = lockSinceLabel(lock.expiresAt);
  return (
    <div
      data-testid="automation-lock-banner"
      data-lock-state="held-by-other"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[8px] border border-amber-500/30 bg-amber-500/[0.07] px-3 py-1.5 text-[11px] font-medium text-foreground/85 shadow-md backdrop-blur"
    >
      <LockIcon size={13} weight="fill" className="shrink-0 text-amber-700 dark:text-amber-300" />
      <span className="min-w-0 truncate">
        {lock.isHeldByMyOtherSession
          ? "Open in another one of your sessions"
          : `Editing by ${lock.heldByName ?? "another member"}`}
        {since ? (
          <span data-testid="automation-lock-since" className="text-muted-foreground">
            {" "}
            · since {since}
          </span>
        ) : null}
      </span>
      {canEdit ? (
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-6 gap-1 rounded-[6px] border-border/70 bg-card/80 px-2 text-[11px] shadow-none hover:bg-muted",
            "text-foreground/80",
          )}
          onClick={onRequestTakeover}
        >
          <UserFocusIcon size={12} />
          Take over editing
        </Button>
      ) : null}
    </div>
  );
}
