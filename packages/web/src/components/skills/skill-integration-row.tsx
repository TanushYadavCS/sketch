import type { SkillIntegration } from "@/lib/skills-data";
import { XIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";

interface SkillIntegrationRowProps {
  integration: SkillIntegration;
  mode: "view" | "edit";
  onConnect?: (integration: SkillIntegration) => void;
  onRemove?: (integrationId: string) => void;
}

export function SkillIntegrationRow({ integration, mode, onConnect, onRemove }: SkillIntegrationRowProps) {
  if (mode === "edit") {
    return (
      <div className="flex items-center gap-3 py-2.5">
        <div
          className={`flex size-7 shrink-0 items-center justify-center rounded-full ${integration.iconBg} text-[10px] font-semibold text-white`}
        >
          {integration.iconLetter}
        </div>
        <span className="flex-1 truncate text-sm">{integration.name}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => onRemove?.(integration.integrationId)}>
          <XIcon size={14} className="text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div
        className={`flex size-7 shrink-0 items-center justify-center rounded-full ${integration.iconBg} text-[10px] font-semibold text-white`}
      >
        {integration.iconLetter}
      </div>
      <span className="flex-1 truncate text-sm">{integration.name}</span>
      <div className="flex items-center gap-2">
        {integration.status === "connected" && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-success">
            <span className="size-1.5 rounded-full bg-success" />
            Connected
          </span>
        )}
        {integration.status === "error" && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <span className="size-1.5 rounded-full bg-warning" />
            Error
          </span>
        )}
        {integration.status === "not_connected" && (
          <>
            <span className="text-xs text-muted-foreground">Not connected</span>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onConnect?.(integration)}>
              Connect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
