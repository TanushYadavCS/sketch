import type { ComponentProps } from "react";

import { cn } from "@sketch/ui/lib/utils";

export function TabContentContainer({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("w-full", className)} {...props} />;
}
