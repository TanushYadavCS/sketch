import type {
  DailyBrief as DailyBriefData,
  DailyBriefItem,
  DailyBriefReviewDecision,
  DailyBriefReviewState,
  TaskStatus,
} from "@/lib/api";
import { useEntityUiOptional } from "@/lib/entity-ui";
import { SparkleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { BriefDetailDrawer } from "./brief-detail-drawer";
import { BriefItemRow } from "./brief-item-row";
import { BriefSection } from "./brief-section";
import { MeetingRow } from "./meeting-row";
import { BRIEF_SECTIONS } from "./sections";

function formatBriefDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** The current/next meeting: the earliest one whose start is still ahead of `now`. */
function computeNextMeetingId(items: DailyBriefItem[], now: number): string | null {
  let next: { id: string; start: number } | null = null;
  for (const item of items) {
    const startIso = item.structuredPayload?.startTime;
    const start = startIso ? new Date(startIso).getTime() : Number.NaN;
    if (Number.isNaN(start) || start < now) continue;
    if (!next || start < next.start) next = { id: item.id, start };
  }
  return next?.id ?? null;
}

/**
 * Tracks the current/next meeting and advances it as start times pass.
 *
 * `nextMeetingId` is time-dependent, so without a clock the badge would freeze
 * on a meeting that is no longer next once Home stays open across its start. A
 * timeout scheduled to the current marker's start re-evaluates exactly when it
 * elapses, then reschedules for the following meeting; it idles once none remain.
 */
function useNextMeetingId(items: DailyBriefItem[]): string | null {
  const [now, setNow] = useState(() => Date.now());
  const nextMeetingId = computeNextMeetingId(items, now);
  const nextStart = useMemo(() => {
    const current = items.find((item) => item.id === nextMeetingId);
    const startIso = current?.structuredPayload?.startTime;
    const start = startIso ? new Date(startIso).getTime() : Number.NaN;
    return Number.isNaN(start) ? null : start;
  }, [items, nextMeetingId]);

  useEffect(() => {
    if (nextStart === null) return;
    const delay = Math.max(0, nextStart - Date.now()) + 1000;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [nextStart]);

  return nextMeetingId;
}

export function DailyBrief({
  brief,
  running,
  enabledSections,
  calendarConnected,
  onOpenChat,
  onUpdateTaskStatus,
  updatingTaskId,
  onReviewFollowup,
  updatingReviewId,
}: {
  brief: DailyBriefData;
  running: boolean;
  /** Section keys enabled in the user's config; when omitted, all sections show. */
  enabledSections?: string[];
  /** Whether the reader has a calendar connected — drives the meetings empty state. */
  calendarConnected?: boolean;
  onOpenChat: (prompt: string) => void;
  /** Status-update handler owned by Home; passed through to the detail drawer. */
  onUpdateTaskStatus?: (taskId: string, status: TaskStatus) => void;
  /** taskId currently being updated, to disable its control; null when idle. */
  updatingTaskId?: string | null;
  onReviewFollowup?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void;
  updatingReviewId?: string | null;
}) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const entityUi = useEntityUiOptional();
  const nextMeetingId = useNextMeetingId(brief.sections.meetings ?? []);

  /**
   * Active-project rows deep-link into project detail — the shared entity
   * drawer — via the item's first entity reference. This is the daily path
   * into a project. Every other section opens the brief detail sheet.
   */
  const openItem = (item: DailyBriefItem) => {
    if (item.sectionKey === "active_projects" && entityUi) {
      const projectEntityId = item.knowledgeRefs.entityIds[0];
      if (projectEntityId) {
        entityUi.openEntity(projectEntityId);
        return;
      }
    }
    setSelectedItemId(item.id);
  };
  const subtitle =
    brief.masthead?.summary ?? brief.masthead?.title ?? "Today across your to-dos, customers, and projects.";
  const visibleSections = enabledSections
    ? BRIEF_SECTIONS.filter((section) => enabledSections.includes(section.key))
    : BRIEF_SECTIONS;
  const allItems = visibleSections.flatMap((section) => brief.sections[section.key] ?? []);
  const selectedItem = allItems.find((item) => item.id === selectedItemId) ?? null;

  return (
    <div>
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">The Brief</p>
        <h1 className="mt-3 font-serif text-[32px] font-medium leading-[1.1] tracking-[-0.01em] text-foreground">
          {formatBriefDate(brief.briefDate)}
        </h1>
        <p className="mt-2.5 max-w-xl font-serif text-[16px] italic leading-relaxed text-muted-foreground">
          &ldquo;{subtitle}&rdquo;
        </p>
        {running ? (
          <p className="mt-4 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            <SparkleIcon size={12} weight="fill" className="animate-pulse text-amber-500" aria-hidden />
            Generating a fresh brief&hellip;
          </p>
        ) : null}
      </header>

      <div className="mt-8 flex flex-col gap-8">
        {visibleSections.map((section) => {
          const items = brief.sections[section.key] ?? [];
          if (section.key === "meetings") {
            return (
              <BriefSection key={section.key} label={section.label}>
                {items.length === 0 ? (
                  <p className="py-1.5 text-[12.5px] text-muted-foreground/70">
                    {calendarConnected ? "Nothing on your calendar today." : "Connect a calendar to see your day."}
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {items.map((item, index) => (
                      <MeetingRow
                        key={item.id}
                        item={item}
                        timezone={brief.timezone}
                        isNext={item.id === nextMeetingId}
                        isLast={index === items.length - 1}
                        onOpenDetail={() => setSelectedItemId(item.id)}
                      />
                    ))}
                  </div>
                )}
              </BriefSection>
            );
          }
          return (
            <BriefSection key={section.key} label={section.label}>
              {items.length === 0 ? (
                <p className="py-1.5 text-[12.5px] text-muted-foreground/70">Nothing notable here today.</p>
              ) : (
                <div className="flex flex-col">
                  {items.map((item, index) => (
                    <BriefItemRow
                      key={item.id}
                      item={item}
                      isLast={index === items.length - 1}
                      onOpenDetail={() => openItem(item)}
                      onOpenChat={onOpenChat}
                      onReviewFollowup={onReviewFollowup}
                      updatingReviewId={updatingReviewId}
                    />
                  ))}
                </div>
              )}
            </BriefSection>
          );
        })}
      </div>

      <footer className="mt-12 border-t border-border/60 pt-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
          Assembled by Sketch from your org knowledge.
        </p>
      </footer>

      <BriefDetailDrawer
        item={selectedItem}
        timezone={brief.timezone}
        onClose={() => setSelectedItemId(null)}
        onOpenChat={onOpenChat}
        onUpdateTaskStatus={onUpdateTaskStatus}
        updatingTaskId={updatingTaskId}
        onReviewFollowup={onReviewFollowup}
        updatingReviewId={updatingReviewId}
      />
    </div>
  );
}
