import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { type ReactNode, useState } from "react";

export function BriefSection({
  label,
  children,
  defaultOpen = true,
  className,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={cn("flex flex-col", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group mb-3 flex w-full items-baseline justify-between gap-3 border-b border-border/60 pb-2 text-left"
      >
        <span className="flex items-center gap-1.5">
          <CaretRightIcon
            size={11}
            weight="bold"
            aria-hidden
            className={cn(
              "text-muted-foreground/60 transition-transform duration-150 group-hover:text-muted-foreground",
              open && "rotate-90",
            )}
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}
