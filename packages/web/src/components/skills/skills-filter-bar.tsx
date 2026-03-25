import { type SkillCategory, skillCategories } from "@/lib/skills-data";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SkillsFilterBarProps {
  activeCategories: SkillCategory[];
  onCategoryToggle: (category: SkillCategory) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchPlaceholder?: string;
}

export function SkillsFilterBar({
  activeCategories,
  onCategoryToggle,
  searchQuery,
  onSearchChange,
  searchPlaceholder = "Search skills...",
}: SkillsFilterBarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const sortedCategories = useMemo(() => {
    const selected = skillCategories.filter((c) => activeCategories.includes(c.value));
    const unselected = skillCategories.filter((c) => !activeCategories.includes(c.value));
    return [...selected, ...unselected];
  }, [activeCategories]);

  useEffect(() => {
    if (!searchOpen) return;
    inputRef.current?.focus();
  }, [searchOpen]);

  const handleClose = useCallback(() => {
    setSearchOpen(false);
    onSearchChange("");
  }, [onSearchChange]);

  return (
    <div className="relative mt-4 h-[34px]">
      <div
        className={cn(
          "flex h-[34px] items-center gap-2 overflow-x-auto scrollbar-none",
          "mr-[42px]",
          "transition-opacity duration-200",
          searchOpen && "pointer-events-none opacity-30",
        )}
      >
        {sortedCategories.map((cat) => {
          const isSelected = activeCategories.includes(cat.value);
          return (
            <button
              key={cat.value}
              type="button"
              onClick={() => onCategoryToggle(cat.value)}
              className={cn(
                "shrink-0 rounded-full px-3.5 py-[5px] text-xs font-medium transition-colors",
                isSelected
                  ? [
                      // Light mode (theme-aware)
                      "border border-primary/30 bg-primary/10 text-foreground",
                      // Dark mode (as in sketch-frontend diff)
                      "dark:border-[rgba(107,125,250,0.4)] dark:bg-[rgba(107,125,250,0.15)] dark:text-white",
                    ].join(" ")
                  : [
                      // Light mode (theme-aware)
                      "border border-border/60 text-muted-foreground hover:bg-accent",
                      // Dark mode (as in sketch-frontend diff)
                      "dark:border-[rgba(255,255,255,0.1)] dark:text-[rgba(255,255,255,0.45)] dark:hover:bg-[rgba(255,255,255,0.04)]",
                    ].join(" "),
              )}
            >
              {cat.label}
            </button>
          );
        })}
      </div>

      {!searchOpen && (
        <div
          className="pointer-events-none absolute right-[42px] top-0 h-full w-4"
          style={{
            background: "var(--background)",
            maskImage: "linear-gradient(to right, transparent, black)",
            WebkitMaskImage: "linear-gradient(to right, transparent, black)",
          }}
        />
      )}

      {!searchOpen && (
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className={cn(
            "absolute right-0 top-0 flex h-[34px] w-[34px] items-center justify-center rounded-lg border bg-transparent transition-colors",
            "border-border/60 hover:border-primary/30 hover:bg-accent",
            "dark:border-[rgba(255,255,255,0.1)] dark:hover:border-[rgba(107,125,250,0.25)] dark:hover:bg-[rgba(107,125,250,0.06)]",
          )}
        >
          <MagnifyingGlass size={14} className="text-muted-foreground dark:text-[rgba(255,255,255,0.5)]" />
        </button>
      )}

      {searchOpen && (
        <>
          <div
            className="pointer-events-none absolute inset-0 z-10"
            style={{
              background: "linear-gradient(90deg, transparent 0%, var(--background) 28%)",
            }}
          />

          <div className="animate-search-expand absolute inset-0 z-20 flex items-center rounded-lg border border-primary/30 bg-[var(--background)] dark:border-[rgba(107,125,250,0.25)]">
            <MagnifyingGlass size={14} className="ml-2.5 shrink-0 text-primary/70 dark:text-[rgba(107,125,250,0.55)]" />
            <input
              ref={inputRef}
              type="text"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-full flex-1 bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              type="button"
              onClick={handleClose}
              className="mr-2 flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-accent dark:hover:bg-[rgba(255,255,255,0.06)]"
            >
              <X size={14} className="text-muted-foreground/70 dark:text-[rgba(255,255,255,0.4)]" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
