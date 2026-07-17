/**
 * Review tab — the full triage list. Every pending review row across all
 * types, grouped into bands by source ({@link reviewBandLabel}, a D3
 * `contextLabel` drop-in). Rows reuse {@link ReviewRowCard} (shared with the
 * per-tab capped bands); row clicks open the reconcile / birth sheets.
 *
 * Per-band "Dismiss all" is intentionally absent: the server exposes no batch
 * dismiss (only `confirm-batch` / `reject-batch` + single-row `dismiss`), so a
 * bulk control would fan out N calls. Omitted until a batch dismiss lands.
 */
import { api } from "@/lib/api";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ReviewEmpty, ReviewRowCard, useReviewRowSheets } from "./org-review";
import { reviewBandLabel } from "./review-band-label";

export function ReviewTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ["entity-review", "tab-all", debouncedSearch],
    queryFn: () => api.entityReview.list({ limit: 200, search: debouncedSearch || undefined }),
    refetchInterval: 30000,
  });
  const rows = data?.rows ?? [];
  const { openRow, sheets, refresh } = useReviewRowSheets();

  const bands = new Map<string, typeof rows>();
  for (const row of rows) {
    const label = reviewBandLabel(row);
    const bucket = bands.get(label);
    if (bucket) bucket.push(row);
    else bands.set(label, [row]);
  }
  const orderedBands = [...bands.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  return (
    <div>
      <div className="relative mt-1">
        <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          placeholder="Search the review queue…"
          className="pl-9 text-sm"
        />
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          {[1, 2, 3, 4].map((k) => (
            <Skeleton key={k} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4">
          <ReviewEmpty>
            {debouncedSearch
              ? "No pending reviews match your search."
              : "Nothing waiting. Candidates land here from WhatsApp groups, trackers, and email signatures as the graph proposes new entities."}
          </ReviewEmpty>
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {orderedBands.map(([label, bandRows]) => (
            <section
              key={label}
              className="overflow-hidden rounded-xl border border-border"
              data-testid={`review-band-${label}`}
            >
              <div className="flex items-baseline justify-between border-b border-border bg-muted/30 px-3 py-2">
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {label} · {bandRows.length}
                </span>
              </div>
              {bandRows.map((row) => (
                <ReviewRowCard key={row.id} row={row} onOpen={openRow} onResolved={refresh} />
              ))}
            </section>
          ))}
        </div>
      )}
      {sheets}
    </div>
  );
}
