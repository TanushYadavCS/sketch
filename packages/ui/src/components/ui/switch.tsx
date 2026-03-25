import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@ui/lib/utils";

function Switch({
  className,
  size,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  const isSmall = size === "sm";
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        isSmall ? "h-4 w-7" : "h-5 w-9",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background pointer-events-none block rounded-full shadow-sm ring-0 transition-transform",
          isSmall
            ? "size-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0"
            : "size-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
