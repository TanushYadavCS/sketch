import type { Skill } from "@/lib/skills-data";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { cn } from "@sketch/ui/lib/utils";
import { Download, Star, Store } from "lucide-react";

interface SkillCardProps {
  skill: Skill;
  onCardClick: (skillId: string) => void;
  onDuplicate: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}

export function SkillCard({ skill, onCardClick, onDuplicate, onDelete }: SkillCardProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: div instead of button to avoid nested button hydration error
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "cursor-pointer rounded-xl border bg-card p-5 transition-[background-color,border-color] duration-200 ease-in-out flex flex-col text-left w-full",
        // Light mode (theme-aware)
        "border-border/70 hover:border-primary/25 hover:bg-accent/30",
        // Dark mode (as in sketch-frontend diff)
        "dark:border-[rgba(255,255,255,0.07)] dark:hover:border-[rgba(255,255,255,0.2)] dark:hover:bg-[rgba(107,125,250,0.03)]",
      )}
      onClick={() => onCardClick(skill.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCardClick(skill.id);
        }
      }}
    >
      {/* Top row: skill name + overflow menu */}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-base font-semibold">{skill.name}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="-mr-2 size-7 shrink-0" onClick={(e) => e.stopPropagation()}>
              <DotsThreeIcon size={16} className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={() => onDuplicate(skill)}>Duplicate</DropdownMenuItem>
            {/* TODO: Enable/Disable skill will be implemented later. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(skill)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Description */}
      {skill.description && (
        <p className="mt-1 text-xs text-muted-foreground/70 line-clamp-3 leading-relaxed">{skill.description}</p>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Hub source + stats */}
      <div className="mt-3 min-h-[18px]">
        {skill.source ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Store size={12} strokeWidth={1.75} />
            <span>{skill.source.hub}</span>
            <span className="text-muted-foreground/50">&middot;</span>
            <Star size={12} strokeWidth={1.75} />
            <span>{skill.source.stars}</span>
            <span className="text-muted-foreground/50">&middot;</span>
            <Download size={12} strokeWidth={1.75} />
            <span>{skill.source.downloads}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
