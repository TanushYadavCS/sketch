import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { cn } from "@sketch/ui/lib/utils";
import type { ComponentProps } from "react";

export function QuietAddButton({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto gap-1 px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted/50 hover:text-foreground [&_svg]:size-3",
        className,
      )}
      {...props}
    >
      <PlusIcon weight="bold" aria-hidden />
      {children}
    </Button>
  );
}
