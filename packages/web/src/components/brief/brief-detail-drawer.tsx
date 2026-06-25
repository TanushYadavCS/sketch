import type { DailyBriefItem } from "@/lib/api";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { BriefActionButton } from "./brief-action-button";
import { labelMeta, refChips, sourceLinkLabel } from "./item-metadata";

function drawerTitle(item: DailyBriefItem): string {
  if (item.sectionKey === "todos" && item.displayRef) return `${item.displayRef} \u00b7 ${item.title}`;
  return item.title;
}

function drawerSubtitle(item: DailyBriefItem): string {
  if (item.sectionKey === "todos") return "Assigned or inferred for you";
  if (item.sectionKey === "customer_updates") return "Customer Updates";
  return "Active Projects";
}

function priorityLabel(priority: DailyBriefItem["priority"]): string {
  if (priority === "high") return "High priority";
  if (priority === "medium") return "Medium priority";
  return "Low priority";
}

export function BriefDetailDrawer({
  item,
  onClose,
  onOpenChat,
}: {
  item: DailyBriefItem | null;
  onClose: () => void;
  onOpenChat: (prompt: string) => void;
}) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetTitle className="sr-only">Brief detail</SheetTitle>
        <SheetDescription className="sr-only">Context and actions for the selected brief item.</SheetDescription>
        {item ? <DrawerBody item={item} onOpenChat={onOpenChat} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ item, onOpenChat }: { item: DailyBriefItem; onOpenChat: (prompt: string) => void }) {
  const meta = labelMeta(item);
  const chips = refChips(item);
  const actionLabel = item.actionLabel ?? "Ask Sketch";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-12">
        <header>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {meta.eyebrow} {"\u00b7"} {meta.label}
          </p>
          <h2 className="mt-2 text-[18px] font-semibold leading-snug text-foreground">{drawerTitle(item)}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {drawerSubtitle(item)} {"\u00b7"} {priorityLabel(item.priority)}
          </p>
        </header>

        <div className="mt-5 space-y-5">
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Context</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>
          </div>

          {chips.length > 0 ? (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Evidence</p>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border-[0.5px] border-border bg-muted/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.04em] text-muted-foreground"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {item.actionPrompt || item.sourceUrl ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-6 py-4">
          {item.actionPrompt ? (
            <BriefActionButton
              label={actionLabel}
              stopPropagation={false}
              onClick={() => onOpenChat(item.actionPrompt as string)}
            />
          ) : null}
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-border bg-transparent px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowSquareOutIcon size={13} weight="bold" aria-hidden />
              {sourceLinkLabel(item.sourceUrl)}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
