import type { AutomationArtifact } from "@/lib/api";
import { CalendarDotsIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { cn } from "@sketch/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";

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
  className,
}: {
  artifact: AutomationArtifact;
  conversationId?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const tags = Array.from(new Set(artifact.tags));
  const continuationConversationId = conversationIdFromBuilderUrl(artifact.builderUrl) ?? conversationId;

  const openBuilder = () => {
    void navigate({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: artifact.taskId },
      search: continuationConversationId ? { conversationId: continuationConversationId } : {},
    });
  };

  const saveAsIs = () => {
    void navigate({ to: "/scheduled-tasks" });
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
          onClick={openBuilder}
        >
          {continuationConversationId ? "Continue in builder" : "Open automation"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-[8px] px-4 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground sm:px-5"
          onClick={saveAsIs}
        >
          Save as-is
        </Button>
      </div>
    </div>
  );
}
