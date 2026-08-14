import { type AutomationArtifact, api } from "@/lib/api";
import { shouldUseChatViewTransition } from "@/lib/chat-target";
import { CalendarDotsIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { cn } from "@sketch/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const AUTOMATION_BUILDER_AUTO_OPEN_DELAY_MS = 3_000;
const AUTOMATION_AUTO_OPEN_STORAGE_PREFIX = "sketch:automation-auto-open:";

function autoOpenStorageKey(key: string): string {
  return `${AUTOMATION_AUTO_OPEN_STORAGE_PREFIX}${key}`;
}

function hasConsumedAutoOpen(key: string | undefined): boolean {
  if (!key) return false;
  try {
    return window.sessionStorage.getItem(autoOpenStorageKey(key)) === "true";
  } catch {
    return false;
  }
}

function consumeAutoOpen(key: string | undefined): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(autoOpenStorageKey(key), "true");
  } catch {
    return;
  }
}

function conversationIdFromBuilderUrl(builderUrl: string): string | undefined {
  try {
    const value = new URL(builderUrl, "http://sketch.local").searchParams.get("conversationId")?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function AutomationArtifactCard({
  artifact,
  conversationId,
  autoOpen = false,
  autoOpenKey,
  className,
}: {
  artifact: AutomationArtifact;
  conversationId?: string;
  autoOpen?: boolean;
  autoOpenKey?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const tags = Array.from(new Set(artifact.tags));
  const isUpdate = artifact.kind.trim().toLowerCase() === "updated automation";
  const existingConversationId = conversationIdFromBuilderUrl(artifact.builderUrl);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const autoOpenHandledRef = useRef(false);
  const autoOpenTimerRef = useRef<number | null>(null);

  const setOpeningState = useCallback((value: boolean) => {
    openingRef.current = value;
    setOpening(value);
  }, []);

  const openBuilder = useCallback(async () => {
    if (openingRef.current) return;
    setOpeningState(true);
    try {
      const builderConversationId = existingConversationId
        ? existingConversationId
        : (await api.scheduledTasks.createConversation(artifact.taskId, { createNew: true })).conversation
            .conversationId;
      await navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: artifact.taskId },
        search: { conversationId: builderConversationId },
        viewTransition: shouldUseChatViewTransition(),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open automation builder");
    } finally {
      setOpeningState(false);
    }
  }, [artifact.taskId, existingConversationId, navigate, setOpeningState]);

  useEffect(() => {
    if (!autoOpen || autoOpenHandledRef.current || hasConsumedAutoOpen(autoOpenKey)) return;
    if (autoOpenTimerRef.current !== null) return;
    autoOpenTimerRef.current = window.setTimeout(() => {
      autoOpenTimerRef.current = null;
      autoOpenHandledRef.current = true;
      consumeAutoOpen(autoOpenKey);
      void openBuilder();
    }, AUTOMATION_BUILDER_AUTO_OPEN_DELAY_MS);
    return () => {
      if (autoOpenTimerRef.current !== null) {
        window.clearTimeout(autoOpenTimerRef.current);
        autoOpenTimerRef.current = null;
      }
    };
  }, [autoOpen, autoOpenKey, openBuilder]);

  const handleOpenClick = () => {
    if (autoOpenTimerRef.current !== null) {
      window.clearTimeout(autoOpenTimerRef.current);
      autoOpenTimerRef.current = null;
    }
    consumeAutoOpen(autoOpenKey);
    openingRef.current = false;
    void openBuilder();
  };

  return (
    <div
      className={cn(
        "mt-4 w-full max-w-[calc(100vw-96px)] rounded-[8px] border border-border bg-card px-4 py-4 shadow-sm sm:max-w-[560px]",
        className,
      )}
    >
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {artifact.kind}
      </div>
      <div className="mt-3 flex items-start gap-3">
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[5px] bg-brand-accent text-[#161300]">
          <CalendarDotsIcon size={15} weight="fill" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="break-words text-[17px] font-semibold leading-snug text-foreground">{artifact.title}</h3>
          <p className="mt-2 break-words text-[13.5px] leading-5 text-muted-foreground">{artifact.description}</p>
        </div>
      </div>

      <p className="mt-4 text-[13px] leading-5 text-muted-foreground">
        {isUpdate
          ? "Would you like to go to this automation in the builder?"
          : "This seems like a new automation. You can go to the builder to create it."}
      </p>

      {tags.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {tags.map((tag, index) => (
            <span key={tag} className="flex items-center gap-2">
              {index > 0 ? <span className="text-muted-foreground/60">·</span> : null}
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          type="button"
          className="h-9 rounded-[8px] bg-brand-accent px-4 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#161300] shadow-none hover:bg-brand-accent/90 sm:px-5"
          onClick={handleOpenClick}
          disabled={opening}
        >
          {opening ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
          {opening ? "Opening builder…" : "Go to builder"}
        </Button>
      </div>
    </div>
  );
}
