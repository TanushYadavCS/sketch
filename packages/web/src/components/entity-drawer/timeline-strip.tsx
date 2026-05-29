/**
 * Vertical timeline list for the entity drawer.
 *
 * Newest entries appear at the top. Items are grouped by month with a
 * sticky-feeling header per group. Each row shows the source-type tag, the
 * file name, a date, optional mention multiplier, and an optional context
 * snippet from the file.
 */
import type { EntityTimelineGroup, EntityTimelineItem } from "@/lib/api";

interface TimelineStripProps {
  groups: EntityTimelineGroup[];
  onSelectItem?: (item: EntityTimelineItem) => void;
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
  const totalCount = groups.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <div data-testid="timeline-strip">
      <div className="mb-2 text-[10px] text-muted-foreground">
        {totalCount === 0 ? "No entries" : totalCount === 1 ? "1 entry" : `${totalCount} entries`}
      </div>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.month} className="flex flex-col">
            <h4 className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {monthLabel(group.month)}
            </h4>
            <ul className="flex flex-col divide-y rounded-md border bg-background">
              {group.items.map((item) => (
                <li key={item.fileId}>
                  <button
                    type="button"
                    onClick={() => onSelectItem?.(item)}
                    className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                          {item.sourceType}
                        </span>
                        <span className="truncate text-sm font-medium">{item.fileName}</span>
                        {item.mentionCount > 1 ? (
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                            ×{item.mentionCount}
                          </span>
                        ) : null}
                      </div>
                      <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                        {formatDate(item.occurredAt)}
                      </span>
                    </div>
                    {item.contextSnippet ? (
                      <p className="line-clamp-2 text-[11px] text-muted-foreground">{item.contextSnippet}</p>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
