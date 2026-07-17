import { cn } from "@sketch/ui/lib/utils";

interface TabButtonProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  /** Optional color-key dot before the label, for tab strips that double as a legend. */
  dot?: string;
}

export function TabButton({ label, isActive, onClick, dot }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative pb-3 font-mono text-[11px] uppercase tracking-[0.07em] transition-colors",
        isActive ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
          style={{ backgroundColor: dot }}
        />
      ) : null}
      {label}
      {isActive ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#FEED01]" /> : null}
    </button>
  );
}
