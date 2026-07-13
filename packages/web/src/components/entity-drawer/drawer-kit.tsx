/**
 * Shared visual primitives for the entity drawer and its lookalikes (e.g. the
 * review inspect sheet). Single source of truth so those surfaces stay visually
 * identical — same tokens, same borders, same spacing.
 */
import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

/** Small uppercase mono section label (e.g. "Summary", "Tasks under this"). */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/** Accent-tinted bordered card with a {@link SectionLabel} header. */
export function SectionCard({ accent, label, children }: { accent: string; label: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border p-4" style={{ borderColor: `${accent}33` }}>
      <SectionLabel className="mb-2">{label}</SectionLabel>
      {children}
    </section>
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
