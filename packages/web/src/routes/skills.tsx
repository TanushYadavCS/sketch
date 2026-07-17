import { QuietAddButton } from "@/components/quiet-add-button";
import { DeleteSkillDialog } from "@/components/skills/delete-skill-dialog";
import { DiscardChangesDialog } from "@/components/skills/discard-changes-dialog";
import { SkillCard } from "@/components/skills/skill-card";
import { SkillDetailEdit, type SkillDraft } from "@/components/skills/skill-detail-edit";
import { SkillDetailView } from "@/components/skills/skill-detail-view";
import { SkillsEmptyState } from "@/components/skills/skills-empty-state";
import { SkillsFilterBar } from "@/components/skills/skills-filter-bar";
import { api } from "@/lib/api";
import { type Skill, categoryMeta, fromApiSkill, isSkillEnabled } from "@/lib/skills-data";
import { Button } from "@sketch/ui/components/button";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";
/**
 * Skills page — create, manage, and configure skills (custom agent behaviors).
 *
 * Shows active skills (those enabled for the current user) with a search box.
 * Page modes: listing → view | edit | create
 */

export const skillsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/skills",
  component: SkillsPage,
});

type PageMode = "listing" | "view" | "edit" | "create";

export function SkillsPage() {
  // ── Core state ────────────────────────────────────────────
  const [mode, setMode] = useState<PageMode>("listing");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // ── Dialogs ────────────────────────────────────────────────
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);

  const queryClient = useQueryClient();

  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: async () => {
      const res = await api.skills.list();
      return {
        skills: res.skills.map(fromApiSkill),
      };
    },
  });

  const skills = skillsQuery.data?.skills ?? [];
  const skillsErrorMessage = skillsQuery.error instanceof Error ? skillsQuery.error.message : "Failed to load skills.";

  const setSkillsCache = useCallback(
    (updater: (currentSkills: Skill[]) => Skill[]) => {
      queryClient.setQueryData<{ skills: Skill[] }>(["skills"], (current) => ({
        skills: updater(current?.skills ?? []),
      }));
    },
    [queryClient],
  );

  const createSkillMutation = useMutation({
    mutationFn: (draft: SkillDraft) =>
      api.skills.create({
        name: draft.name,
        description: draft.description,
        category: draft.category,
        body: draft.body,
      }),
    onSuccess: async (res) => {
      const created = fromApiSkill(res.skill);
      setSkillsCache((currentSkills) => [created, ...currentSkills.filter((s) => s.id !== created.id)]);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      setSelectedSkillId(created.id);
      setMode("view");
      toast.success("Skill created");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to create skill");
    },
  });

  const updateSkillMutation = useMutation({
    mutationFn: (args: { id: string; draft: SkillDraft }) =>
      api.skills.update(args.id, {
        name: args.draft.name,
        description: args.draft.description,
        category: args.draft.category,
        body: args.draft.body,
      }),
    onSuccess: async (res) => {
      setSkillsCache((currentSkills) =>
        currentSkills.map((s) =>
          s.id === res.skill.id
            ? {
                ...s,
                name: res.skill.name,
                description: res.skill.description,
                body: res.skill.body,
                category: res.skill.category,
                iconBg: categoryMeta[res.skill.category].iconBg,
                iconEmoji: categoryMeta[res.skill.category].iconEmoji,
              }
            : s,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      setMode("view");
      toast.success("Skill updated");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to update skill");
    },
  });

  const deleteSkillMutation = useMutation({
    mutationFn: (id: string) => api.skills.remove(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["skills"] });
      const previous = queryClient.getQueryData<{ skills: Skill[] }>(["skills"]);
      queryClient.setQueryData<{ skills: Skill[] }>(["skills"], (current) => ({
        skills: (current?.skills ?? []).filter((s) => s.id !== id),
      }));
      return { previous };
    },
    onSuccess: async () => {
      toast.success("Skill deleted");
    },
    onError: (err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["skills"], context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Failed to delete skill");
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  // ── Derived data ──────────────────────────────────────────

  // TODO: Switch the active tab to per-user visibility once viewer identity is available
  // by using `isSkillActiveForUser` and `getSkillSourcesForUser`.
  const activeSkills = useMemo(() => {
    let result = skills.filter((s) => isSkillEnabled(s.status));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    }
    return result;
  }, [skills, searchQuery]);

  const selectedSkill = useMemo(() => skills.find((s) => s.id === selectedSkillId) ?? null, [skills, selectedSkillId]);

  // ── Handlers ──────────────────────────────────────────────

  const handleCardClick = useCallback((skillId: string) => {
    setSelectedSkillId(skillId);
    setMode("view");
  }, []);

  const handleEditClick = useCallback(() => {
    setMode("edit");
  }, []);

  const handleCreateClick = useCallback(() => {
    setSelectedSkillId(null);
    setMode("create");
  }, []);

  const handleBackToListing = useCallback(() => {
    setSelectedSkillId(null);
    setMode("listing");
  }, []);

  const handleSave = useCallback(
    async (draft: SkillDraft) => {
      if (mode === "create") {
        await createSkillMutation.mutateAsync(draft);
      } else {
        if (!selectedSkillId) return;
        await updateSkillMutation.mutateAsync({ id: selectedSkillId, draft });
      }
    },
    [mode, selectedSkillId, createSkillMutation, updateSkillMutation],
  );

  const handleCancelEdit = useCallback(() => {
    setDiscardDialogOpen(true);
  }, []);

  const handleDiscardConfirm = useCallback(() => {
    if (mode === "create") {
      setSelectedSkillId(null);
      setMode("listing");
    } else {
      setMode("view");
    }
  }, [mode]);

  const handleDuplicate = useCallback(
    (skill: Skill) => {
      void createSkillMutation.mutateAsync({
        name: `${skill.name} (copy)`,
        description: skill.description,
        body: skill.body,
        category: skill.category,
        status: skill.status,
      });
    },
    [createSkillMutation],
  );

  const handleDeleteClick = useCallback((skill: Skill) => {
    setSkillToDelete(skill);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!skillToDelete) return;
    const id = skillToDelete.id;
    deleteSkillMutation.mutate(id);
    setSkillToDelete(null);
    setSelectedSkillId(null);
    setMode("listing");
  }, [skillToDelete, deleteSkillMutation]);

  // ── Loading skeleton ───────────────────────────────────────
  if (skillsQuery.isLoading && skills.length === 0) {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <div className="flex items-start justify-between">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="mt-4 flex gap-4">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
        <div className="mt-6 grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (skillsQuery.isError && skills.length === 0) {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <div>
          <h1 className="text-[22px] font-medium text-foreground">Skills</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Discover and manage your bot&apos;s capabilities.</p>
        </div>
        <div className="mt-6 rounded-xl border border-destructive/20 bg-destructive/5 p-6">
          <h2 className="text-sm font-semibold text-destructive">Couldn&apos;t load skills</h2>
          <p className="mt-2 text-sm text-muted-foreground">{skillsErrorMessage}</p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => void skillsQuery.refetch()}
            disabled={skillsQuery.isFetching}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // ── View mode ──────────────────────────────────────────────
  if (mode === "view" && selectedSkill) {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <SkillDetailView
          skill={selectedSkill}
          onBack={handleBackToListing}
          onEdit={handleEditClick}
          onDuplicate={handleDuplicate}
          onDelete={handleDeleteClick}
        />
        <DeleteSkillDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          skillName={skillToDelete?.name ?? null}
          onConfirm={handleDeleteConfirm}
        />
      </div>
    );
  }

  // ── Edit / Create mode ─────────────────────────────────────
  if (mode === "edit" || mode === "create") {
    return (
      <div className="mx-auto box-content max-w-4xl px-10 py-8">
        <SkillDetailEdit
          skill={mode === "edit" && selectedSkill ? selectedSkill : null}
          onBack={handleCancelEdit}
          onSave={handleSave}
          onCancel={handleCancelEdit}
        />
        <DiscardChangesDialog
          open={discardDialogOpen}
          onOpenChange={setDiscardDialogOpen}
          onConfirm={handleDiscardConfirm}
          isNewSkill={mode === "create"}
        />
      </div>
    );
  }

  // ── Listing mode ───────────────────────────────────────────
  const showEmptyState = activeSkills.length === 0;
  const emptyVariant: "no-skills" | "no-results" =
    skills.length === 0 ? "no-skills" : searchQuery.trim() ? "no-results" : "no-skills";

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-medium text-foreground">Skills</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Discover and manage your bot&apos;s capabilities.</p>
        </div>
        <QuietAddButton onClick={handleCreateClick}>Create Skill</QuietAddButton>
      </div>

      {/* Search */}
      <SkillsFilterBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search active skills..."
      />

      {/* Grid or empty state */}
      <div className="mt-6">
        {showEmptyState ? (
          <SkillsEmptyState
            variant={emptyVariant}
            searchQuery={searchQuery}
            onCreateClick={handleCreateClick}
            onClearSearch={searchQuery.trim() ? () => setSearchQuery("") : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onCardClick={handleCardClick}
                onDuplicate={handleDuplicate}
                onDelete={handleDeleteClick}
              />
            ))}
          </div>
        )}
      </div>

      <DeleteSkillDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        skillName={skillToDelete?.name ?? null}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
