import type { DailyBrief as DailyBriefData } from "@/lib/api";
import { SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { BriefDetailDrawer } from "./brief-detail-drawer";
import { BriefItemRow } from "./brief-item-row";
import { BriefSection } from "./brief-section";
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

export function DailyBrief({
  brief,
  running,
  onOpenChat,
}: {
  brief: DailyBriefData;
  running: boolean;
  onOpenChat: (prompt: string) => void;
}) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const subtitle =
    brief.masthead?.summary ?? brief.masthead?.title ?? "Today across your to-dos, customers, and projects.";
  const allItems = BRIEF_SECTIONS.flatMap((section) => brief.sections[section.key]);
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
        {BRIEF_SECTIONS.map((section) => {
          const items = brief.sections[section.key];
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
                      onOpenDetail={() => setSelectedItemId(item.id)}
                      onOpenChat={onOpenChat}
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

      <BriefDetailDrawer item={selectedItem} onClose={() => setSelectedItemId(null)} onOpenChat={onOpenChat} />
    </div>
  );
}
