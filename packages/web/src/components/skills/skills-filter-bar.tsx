import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

interface SkillsFilterBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchPlaceholder?: string;
}

export function SkillsFilterBar({
  searchQuery,
  onSearchChange,
  searchPlaceholder = "Search skills...",
}: SkillsFilterBarProps) {
  return (
    <div className="relative mt-4">
      <div
        className={cn(
          "flex h-9 items-center gap-2 rounded-lg border bg-transparent px-3 transition-colors",
          "border-border/60 focus-within:border-primary/30",
          "dark:border-[rgba(255,255,255,0.1)] dark:focus-within:border-[rgba(107,125,250,0.25)]",
        )}
      >
        <MagnifyingGlass size={14} className="shrink-0 text-muted-foreground" />
        <input
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-full flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            className="mr-2 flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-accent"
            aria-label="Clear search"
          >
            <X size={14} className="text-muted-foreground/70" />
          </button>
        )}
      </div>
    </div>
  );
}
