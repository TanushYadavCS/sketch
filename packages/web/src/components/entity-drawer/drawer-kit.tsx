/**
 * Shared visual primitives for the entity drawer and its lookalikes (e.g. the
 * review inspect sheet). Single source of truth so those surfaces stay visually
 * identical — same tokens, same borders, same spacing.
 */
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

/** Compact relative date ("3d ago") shared by the drawer, popover, and panels. */
export function formatRelative(iso: string | null): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Small uppercase mono section label (e.g. "Summary", "Tasks under this"). */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/**
 * A {@link SectionLabel} eyebrow sitting ABOVE an accent-tinted bordered content
 * box — the label is outside the border, matching every other labelled section
 * in the drawer (SectionLabel + EntryList / input). Keeps content visually
 * grouped without burying the eyebrow inside the box.
 */
export function SectionCard({ accent, label, children }: { accent: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <SectionLabel className="mb-1.5 font-medium">{label}</SectionLabel>
      <section className="rounded-lg border p-4" style={{ borderColor: `${accent}33` }}>
        {children}
      </section>
    </div>
  );
}

/** Bordered, hairline-divided list — the row container used across drawer lists. */
export function EntryList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col divide-y rounded-md border bg-background">{children}</ul>;
}

/** The muted mono source tag shown at the start of an entry row. */
export function SourceTag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
      {children}
    </span>
  );
}
