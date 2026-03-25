import { Skeleton } from "@sketch/ui/components/skeleton";

export function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <div className="rounded-lg border border-border bg-card">
          {[1, 2].map((i) => (
            <div key={i} className={`flex items-center gap-4 px-4 py-4 ${i < 2 ? "border-b border-border" : ""}`}>
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CaretIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={`transition-transform ${direction === "up" ? "rotate-0" : "rotate-180"}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 7.5L6 4L9.5 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
