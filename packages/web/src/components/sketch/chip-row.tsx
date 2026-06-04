import {
  CalendarDotsIcon,
  ChartBarIcon,
  ChatIcon,
  EnvelopeIcon,
  FileIcon,
  type IconProps,
  LightbulbIcon,
  PencilSimpleIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
import { type ComponentType, type MouseEvent, type PointerEvent, useRef, useState } from "react";

export interface ChipSuggestion {
  label: string;
  prompt: string;
  icon: ComponentType<IconProps>;
}

export const DEFAULT_CHIPS: ChipSuggestion[] = [
  { label: "Triage inbox", prompt: "Triage my inbox from the last 24 hours", icon: EnvelopeIcon },
  { label: "Draft a reply", prompt: "Draft a reply to ", icon: PencilSimpleIcon },
  { label: "Schedule a task", prompt: "Schedule a recurring task to ", icon: CalendarDotsIcon },
  { label: "Summarize thread", prompt: "Summarize the latest thread in ", icon: ChatIcon },
  { label: "Browse skills", prompt: "Show me the skills I can install", icon: SparkleIcon },
  { label: "Find a file", prompt: "Find a file about ", icon: FileIcon },
  { label: "Run a report", prompt: "Run a report on ", icon: ChartBarIcon },
  { label: "Show me what's possible", prompt: "Show me what's possible with Sketch", icon: LightbulbIcon },
];

export interface ChipRowProps {
  chips?: ChipSuggestion[];
  onPick: (chip: ChipSuggestion) => void;
  className?: string;
}

function useDragScroll(scrollerRef: React.RefObject<HTMLDivElement | null>) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
    captured: boolean;
    suppressClick: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const el = scrollerRef.current;
    if (!el) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: el.scrollLeft,
      moved: false,
      captured: false,
      suppressClick: false,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const el = scrollerRef.current;
    if (!drag || !el || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    if (Math.abs(deltaX) > 3) {
      drag.moved = true;
      drag.suppressClick = true;
      if (!drag.captured) {
        drag.captured = true;
        el.setPointerCapture?.(event.pointerId);
      }
      setDragging(true);
    }
    el.scrollLeft = drag.startScrollLeft - deltaX;
    if (drag.moved) event.preventDefault();
  }

  function stopDragging(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const el = scrollerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.captured) el?.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  }

  function handleClickCapture(event: MouseEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag?.suppressClick) {
      dragRef.current = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
  }

  return {
    dragging,
    dragHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
      onClickCapture: handleClickCapture,
    },
  };
}

export function ChipRow({ chips = DEFAULT_CHIPS, onPick, className }: ChipRowProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const { dragging, dragHandlers } = useDragScroll(scrollerRef);

  return (
    <div className={cn("relative w-full", className)}>
      <div
        ref={scrollerRef}
        className={cn(
          "chip-scrollbar flex w-full overflow-x-auto pb-2 select-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        aria-label="Suggested prompts"
        {...dragHandlers}
      >
        <div className="flex w-max gap-[8px]">
          {chips.map((chip) => {
            const Icon = chip.icon;
            return (
              <button
                key={chip.label}
                type="button"
                onClick={() => onPick(chip)}
                className={cn(
                  "group/chip inline-flex shrink-0 items-center gap-[7px] rounded-full px-[14px] py-[8px]",
                  "bg-card border border-border text-[13px] text-muted-foreground",
                  "transition-colors duration-150 ease-out cursor-pointer",
                  "hover:bg-muted/60 hover:border-foreground/20 hover:text-foreground",
                  "active:scale-[0.97]",
                )}
              >
                <Icon
                  size={14}
                  weight="regular"
                  className={cn(
                    "text-muted-foreground transition-all duration-150 ease-out",
                    "group-hover/chip:text-foreground group-hover/chip:scale-[1.08]",
                  )}
                  aria-hidden
                />
                <span className="whitespace-nowrap">{chip.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
