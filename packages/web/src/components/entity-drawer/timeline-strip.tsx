/**
 * Snap-scrolling horizontal carousel for the entity drawer Timeline section.
 *
 * Pattern: month dividers inline, one card per file (mentionCount badge for
 * files with multiple mentions), source-type icon, sync'd arrow buttons,
 * live "{index+1} of {total}" counter, auto-scroll to newest on mount.
 */
import type { EntityTimelineGroup, EntityTimelineItem } from "@/lib/api";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const CARD_WIDTH_PX = 320;
const CARD_GAP_PX = 12;

interface TimelineStripProps {
  groups: EntityTimelineGroup[];
  onSelectItem?: (item: EntityTimelineItem) => void;
}

interface FlatEntry {
  kind: "divider" | "card";
  dividerKey?: string;
  monthLabel?: string;
  item?: EntityTimelineItem;
  cardIndex: number;
}

function monthLabel(key: string): string {
  if (key === "unknown" || !key.match(/^\d{4}-\d{2}$/)) return "Unknown date";
  const [year, month] = key.split("-");
  const monthIdx = Number.parseInt(month, 10) - 1;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[monthIdx] ?? month} ${year}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TimelineStrip({ groups, onSelectItem }: TimelineStripProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeCardIndex, setActiveCardIndex] = useState(0);

  const { entries, cardCount } = useMemo(() => {
    const result: FlatEntry[] = [];
    let cardIdx = 0;
    for (const group of groups) {
      result.push({
        kind: "divider",
        dividerKey: `month:${group.month}`,
        monthLabel: monthLabel(group.month),
        cardIndex: -1,
      });
      for (const item of group.items) {
        result.push({ kind: "card", item, cardIndex: cardIdx });
        cardIdx += 1;
      }
    }
    return { entries: result, cardCount: cardIdx };
  }, [groups]);

  const scrollToCard = useCallback((cardIndex: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const targets = container.querySelectorAll<HTMLDivElement>("[data-timeline-card]");
    const target = targets[cardIndex];
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
    }
  }, []);

  // Auto-scroll to first (newest) on mount
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (initialMountRef.current && cardCount > 0) {
      initialMountRef.current = false;
      // Use rAF so the layout is in place before scrollIntoView fires.
      requestAnimationFrame(() => scrollToCard(0));
    }
  }, [cardCount, scrollToCard]);

  // Update active index on scroll
  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const cards = container.querySelectorAll<HTMLDivElement>("[data-timeline-card]");
    let best = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    const refLeft = container.scrollLeft;
    cards.forEach((card, idx) => {
      const delta = Math.abs(card.offsetLeft - refLeft);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = idx;
      }
    });
    setActiveCardIndex(best);
  }, []);

  const goPrev = () => scrollToCard(Math.max(0, activeCardIndex - 1));
  const goNext = () => scrollToCard(Math.min(cardCount - 1, activeCardIndex + 1));

  const atStart = activeCardIndex <= 0;
  const atEnd = activeCardIndex >= cardCount - 1;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span aria-live="polite">{cardCount === 0 ? "0 of 0" : `${activeCardIndex + 1} of ${cardCount}`}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            disabled={atStart}
            className="rounded p-1 hover:bg-muted disabled:opacity-30"
            aria-label="Previous card"
          >
            <CaretLeftIcon className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={atEnd}
            className="rounded p-1 hover:bg-muted disabled:opacity-30"
            aria-label="Next card"
          >
            <CaretRightIcon className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="snap-x snap-mandatory overflow-x-auto pb-2"
        style={{ scrollPaddingInlineStart: "0px" }}
        data-testid="timeline-strip"
      >
        <div className="flex items-stretch" style={{ gap: `${CARD_GAP_PX}px` }}>
          {entries.map((entry) => {
            if (entry.kind === "divider") {
              return (
                <div
                  key={entry.dividerKey}
                  className="flex shrink-0 items-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  {entry.monthLabel}
                </div>
              );
            }
            const item = entry.item;
            if (!item) return null;
            return (
              <button
                key={`c-${item.fileId}`}
                type="button"
                data-timeline-card
                data-card-index={entry.cardIndex}
                onClick={() => onSelectItem?.(item)}
                className={cn(
                  "snap-start shrink-0 rounded-lg border bg-background p-3 text-left hover:bg-muted/40",
                  "transition-colors",
                )}
                style={{ width: `${CARD_WIDTH_PX}px` }}
              >
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="rounded-sm bg-muted px-1 py-0.5 font-mono">{item.sourceType}</span>
                  <span>{formatDate(item.occurredAt)}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{item.fileName}</span>
                  {item.mentionCount > 1 ? (
                    <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                      ×{item.mentionCount}
                    </span>
                  ) : null}
                </div>
                {item.contextSnippet ? (
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.contextSnippet}</p>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
