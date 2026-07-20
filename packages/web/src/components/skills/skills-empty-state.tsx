import { QuietAddButton } from "@/components/quiet-add-button";
import { BrainIcon, FolderOpenIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";

interface SkillsEmptyStateProps {
  variant: "no-skills" | "no-results" | "no-category";
  searchQuery?: string;
  category?: string;
  onCreateClick: () => void;
  onClearSearch?: () => void;
}

export function SkillsEmptyState({
  variant,
  searchQuery,
  category,
  onCreateClick,
  onClearSearch,
}: SkillsEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      {variant === "no-skills" && (
        <>
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <BrainIcon size={24} className="text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-sm font-medium">Teach Sketch new tricks</h3>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Skills let you define custom behaviors, connect integrations, and automate workflows with Sketch.
          </p>
          <QuietAddButton onClick={onCreateClick} className="mt-4">
            Create Your First Skill
          </QuietAddButton>
        </>
      )}

      {variant === "no-results" && (
        <>
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <MagnifyingGlassIcon size={24} className="text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-sm font-medium">No skills match &lsquo;{searchQuery}&rsquo;</h3>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Try a different search term or create a new skill.
          </p>
          <div className="mt-4 flex items-center gap-2">
            {onClearSearch && (
              <Button variant="secondary" size="sm" onClick={onClearSearch}>
                Clear Search
              </Button>
            )}
            <QuietAddButton onClick={onCreateClick}>Create Skill</QuietAddButton>
          </div>
        </>
      )}

      {variant === "no-category" && (
        <>
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <FolderOpenIcon size={24} className="text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-sm font-medium">No {category} skills yet</h3>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            {`Create your first ${category?.toLowerCase()} skill to get started.`}
          </p>
          <QuietAddButton onClick={onCreateClick} className="mt-4">
            Create Skill
          </QuietAddButton>
        </>
      )}
    </div>
  );
}
