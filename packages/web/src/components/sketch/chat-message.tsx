import { cn } from "@sketch/ui/lib/utils";
import type { ReactNode } from "react";

export function UserMessage({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%]">
        <div
          className={cn(
            "inline-block w-full min-w-0 rounded-[12px] border border-border",
            "bg-[#ebebea] px-[16px] py-[10px] text-[14px] text-foreground dark:bg-white/[0.06]",
          )}
          style={{ lineHeight: 1.5 }}
        >
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}

export function SketchMessage({
  children,
  streaming,
  footer,
}: {
  children: ReactNode;
  streaming?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div className="flex w-full items-start gap-[12px]">
      <span
        aria-label={streaming ? "Sketch is thinking" : "Sketch"}
        className={cn("block h-[24px] w-[24px] shrink-0", streaming && "sketch-icon-thinking")}
      >
        <img src="/logos/sketch-icon-light.png" alt="" aria-hidden className="block size-full dark:invert" />
      </span>
      <div className="min-w-0 flex-1 text-[14px] text-foreground" style={{ lineHeight: 1.7 }}>
        {children}
        {footer}
      </div>
    </div>
  );
}
