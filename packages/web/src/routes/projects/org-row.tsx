/**
 * OrgRow — the row primitive for the Your Org People directory. It keeps
 * avatar size, type scale, gaps, and padding consistent as the directory
 * grows. The density target is the compact review row: quiet, one-line-first,
 * small type.
 *
 * Slots:
 * - `avatar` — always an {@link EntityAvatar} at `sm`, the one shared size.
 * - `primary` — the primary line (name), with optional inline `primaryChips`.
 * - `inlineSuffix` — a muted continuation on the *same* line as the primary
 *   (the review row's "→ suggestion"); mutually exclusive in practice with
 *   `secondary`.
 * - `secondary` — a muted line *below* the primary (people's role · subtype).
 * - `middle` — an optional fixed-width middle column (the contact column).
 * - `meta` — right-aligned fixed-width columns (counts, dates, status, type).
 * - `trailing` — arbitrary non-interactive trailing content.
 * - `caret` — an optional trailing affordance caret.
 * - `footer` — rendered inside the bordered cell, under the interactive area.
 */
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export interface OrgRowProps {
  avatar: ReactNode;
  primary: ReactNode;
  primaryChips?: ReactNode;
  inlineSuffix?: ReactNode;
  secondary?: ReactNode;
  middle?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  caret?: boolean;
  footer?: ReactNode;
  onOpen: () => void;
  className?: string;
  testId?: string;
}

export function OrgRow({
  avatar,
  primary,
  primaryChips,
  inlineSuffix,
  secondary,
  middle,
  meta,
  trailing,
  caret,
  footer,
  onOpen,
  className,
  testId,
}: OrgRowProps) {
  return (
    <div className={cn("group border-b border-border last:border-b-0", className)} data-testid={testId}>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted/30"
      >
        {avatar}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-[12.5px] font-medium", inlineSuffix ? "shrink-0" : "min-w-0")}>
              {primary}
            </span>
            {primaryChips}
            {inlineSuffix ? (
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{inlineSuffix}</span>
            ) : null}
          </div>
          {secondary ? <p className="truncate text-[11px] text-muted-foreground">{secondary}</p> : null}
        </div>
        {middle}
        {meta}
        {trailing}
        {caret ? (
          <CaretRightIcon
            size={12}
            aria-hidden
            className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
          />
        ) : null}
      </button>
      {footer}
    </div>
  );
}
