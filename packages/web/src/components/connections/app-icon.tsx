import { cn, getAbbreviation } from "@sketch/ui/lib/utils";
import { useState } from "react";

interface AppIconProps {
  name: string;
  icon?: string;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
}

export function AppIcon({ name, icon, className, imageClassName, fallbackClassName }: AppIconProps) {
  const [loadedIcon, setLoadedIcon] = useState<string | null>(null);
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const imageLoaded = Boolean(icon && loadedIcon === icon);
  const imageFailed = Boolean(icon && failedIcon === icon);
  const showImage = Boolean(icon && !imageFailed);

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden bg-muted font-semibold text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "transition-opacity duration-150",
          showImage && imageLoaded ? "opacity-0" : "opacity-100",
          fallbackClassName,
        )}
      >
        {getAbbreviation(name)}
      </span>
      {showImage && (
        <img
          src={icon}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={() => setLoadedIcon(icon ?? null)}
          onError={() => setFailedIcon(icon ?? null)}
          className={cn(
            "absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded object-contain opacity-0 transition-opacity duration-150",
            imageLoaded && "opacity-100",
            imageClassName,
          )}
        />
      )}
    </span>
  );
}
