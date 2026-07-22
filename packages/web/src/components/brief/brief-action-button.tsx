import { ChatCircleIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

export function BriefActionButton({
  label = "Ask Sketch",
  onClick,
  className,
  stopPropagation = true,
  borderless = false,
}: {
  label?: string;
  onClick: () => void;
  className?: string;
  stopPropagation?: boolean;
  borderless?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap bg-transparent font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 ease-out hover:bg-muted/50 hover:text-foreground",
        borderless
          ? "h-7 rounded-md px-2 text-[11px]"
          : "rounded-full border-[0.5px] border-border px-3 py-1 text-[12px] hover:border-foreground/25",
        className,
      )}
    >
      <ChatCircleIcon size={13} weight="bold" aria-hidden />
      {label}
    </button>
  );
}
