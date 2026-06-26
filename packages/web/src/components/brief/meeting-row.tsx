import type { DailyBriefItem, DailyBriefMeetingAttendee } from "@/lib/api";
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";

/** Formats a meeting start time in the brief's timezone, e.g. "9:30 AM". */
export function formatMeetingTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(date);
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * A compact meeting row — time, title, attendee avatars. Clicking opens the full
 * prep detail in the drawer. The next meeting carries a "Now / Next" pill, which
 * the parent computes from the current time so it stays correct through the day.
 */
export function MeetingRow({
  item,
  timezone,
  isNext,
  isLast,
  onOpenDetail,
}: {
  item: DailyBriefItem;
  timezone: string;
  isNext: boolean;
  isLast: boolean;
  onOpenDetail: () => void;
}) {
  const payload = item.structuredPayload;
  const attendees = payload?.attendees ?? [];
  const time = payload?.startTime ? formatMeetingTime(payload.startTime, timezone) : "";

  return (
    <button
      type="button"
      onClick={onOpenDetail}
      className={cn("group flex w-full items-center gap-3 py-3 text-left", !isLast && "border-b border-border/50")}
    >
      <time className="w-[64px] shrink-0 font-mono text-[12px] font-medium tabular-nums text-foreground">{time}</time>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-foreground">{item.title}</span>
          {isNext ? (
            <span className="shrink-0 rounded-full bg-amber-400 px-2 py-[1px] font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-amber-950">
              Now / Next
            </span>
          ) : null}
        </div>
        {payload?.via ? <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{payload.via}</p> : null}
      </div>

      <AvatarStack attendees={attendees} />

      <CaretRightIcon
        size={14}
        className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}

function AvatarStack({ attendees }: { attendees: DailyBriefMeetingAttendee[] }) {
  const shown = attendees.slice(0, 3);
  const overflow = attendees.length - shown.length;

  return (
    <div className="hidden items-center sm:flex">
      {shown.map((attendee, index) => (
        <span
          key={`${attendee.name}-${index}`}
          className={cn(
            "flex size-[22px] items-center justify-center rounded-full text-[8px] font-medium ring-2 ring-background",
            index > 0 && "-ml-2",
            attendee.emphasis
              ? "bg-amber-400 text-amber-950"
              : "border-[0.5px] border-border bg-muted text-muted-foreground dark:bg-muted/50",
          )}
          aria-hidden
        >
          {initialsOf(attendee.name)}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="-ml-2 flex size-[22px] items-center justify-center rounded-full border-[0.5px] border-border bg-muted text-[8px] font-medium text-muted-foreground ring-2 ring-background dark:bg-muted/50">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
