/**
 * Review tab — the full triage list. Every pending review row across all
 * types, grouped into bands by source ({@link reviewBandLabel}, a D3
 * `contextLabel` drop-in). Rows reuse {@link ReviewRowCompact} (shared with
 * the per-tab capped bands, `detail` on for candidate email + evidence
 * summary); row clicks open the reconcile / birth sheets.
 *
 * Per-band "Dismiss all" is intentionally absent: the server exposes no batch
 * dismiss (only `confirm-batch` / `reject-batch` + single-row `dismiss`), so a
 * bulk control would fan out N calls. Omitted until a batch dismiss lands.
 */
import {
  WhatsAppIdentityDrawer,
  WhatsAppIdentityRow,
  useWhatsAppIdentityReview,
} from "@/components/entity-review/whatsapp-identity-review";
import { ProjectSuggestionsSection } from "@/components/project-suggestions";
import { api } from "@/lib/api";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ReviewEmpty, ReviewRowCompact, useReviewRowSheets } from "./org-review";
import { reviewBandLabel } from "./review-band-label";

export function ReviewTab({ isAdmin = false }: { isAdmin?: boolean } = {}) {
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

  const wa = useWhatsAppIdentityReview([]);
  const [waSelected, setWaSelected] = useState<string | null>(null);
  const showWa = !debouncedSearch && wa.items.length > 0;

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
      {isAdmin ? <ProjectSuggestionsSection /> : null}
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
      ) : rows.length === 0 && !showWa ? (
        <div className="mt-4">
          <ReviewEmpty>
            {debouncedSearch
              ? "No pending reviews match your search."
              : "Nothing waiting. Candidates land here from WhatsApp groups, trackers, and email signatures as the graph proposes new entities."}
          </ReviewEmpty>
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {showWa ? (
            <section
              className="overflow-hidden rounded-xl border border-amber-300/60 bg-amber-50/30 dark:border-amber-700/50 dark:bg-amber-950/20"
              data-testid="review-band-whatsapp-identities"
            >
              <div className="flex items-baseline justify-between border-b border-amber-300/50 px-3 py-2 dark:border-amber-700/40">
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
                  Unidentified WhatsApp contacts · {wa.items.length}
                </span>
              </div>
              {wa.items.map((item) => (
                <WhatsAppIdentityRow
                  key={item.id}
                  item={item}
                  onOpen={() => setWaSelected(item.id)}
                  onResolve={(message) => wa.resolve(item.id, message)}
                />
              ))}
            </section>
          ) : null}
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
                <ReviewRowCompact key={row.id} row={row} onOpen={openRow} onResolved={refresh} detail />
              ))}
            </section>
          ))}
        </div>
      )}
      {sheets}
      <WhatsAppIdentityDrawer
        item={wa.items.find((item) => item.id === waSelected) ?? null}
        onClose={() => setWaSelected(null)}
        onResolve={wa.resolve}
      />
    </div>
  );
}
