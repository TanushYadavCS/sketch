import { ArrowClockwiseIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { JSX } from "react";

export type ChatRecoveryStage = "idle" | "silent" | "reconnecting" | "persistent";

export function ChatConversationSkeleton(): JSX.Element {
  return (
    <div aria-label="Loading conversation" className="flex flex-col gap-6" aria-busy="true">
      <div className="h-16 w-3/5 animate-pulse rounded-2xl bg-muted/55" />
      <div className="ml-auto h-12 w-2/5 animate-pulse rounded-2xl bg-muted/45" />
      <div className="h-24 w-4/5 animate-pulse rounded-2xl bg-muted/55" />
    </div>
  );
}

export function ChatConversationLoadError(props: { onRetry: () => void }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] rounded-[10px] border border-destructive/30 bg-destructive/5 px-[12px] py-[8px]">
      <p
        role="alert"
        aria-live="assertive"
        className="inline-flex items-center gap-[6px] text-[13px] font-medium text-destructive"
      >
        <WarningCircleIcon size={14} aria-hidden />
        Couldn’t load this conversation.
      </p>
      <button
        type="button"
        onClick={props.onRetry}
        className="inline-flex h-[28px] items-center gap-[6px] rounded-[7px] bg-foreground px-[10px] text-[12px] font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
      >
        <ArrowClockwiseIcon size={13} aria-hidden />
        Retry
      </button>
    </div>
  );
}

export function ChatRecoveryStatus(props: { stage: ChatRecoveryStage; onRetry: () => void }): JSX.Element | null {
  const { stage, onRetry } = props;

  if (stage === "idle" || stage === "silent") return null;

  if (stage === "reconnecting") {
    return (
      <output className="inline-flex items-center gap-[8px] rounded-[10px] border border-border/70 bg-muted/40 px-[12px] py-[8px] text-[13px] font-medium text-muted-foreground">
        <SpinnerGapIcon size={14} className="animate-spin" aria-hidden />
        Reconnecting…
      </output>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] rounded-[10px] border border-destructive/30 bg-destructive/5 px-[12px] py-[8px]">
      <p
        role="alert"
        aria-live="assertive"
        className="inline-flex items-center gap-[6px] text-[13px] font-medium text-destructive"
      >
        <WarningCircleIcon size={14} aria-hidden />
        Connection interrupted. Retrying…
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-[28px] items-center gap-[6px] rounded-[7px] bg-foreground px-[10px] text-[12px] font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
      >
        <ArrowClockwiseIcon size={13} aria-hidden />
        Retry now
      </button>
    </div>
  );
}
