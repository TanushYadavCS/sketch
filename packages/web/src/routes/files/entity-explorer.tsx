/**
 * EntityExplorer — basic entity list for verifying entity seeding.
 * Simple table: name, type, source, aliases, created_at.
 * Filter by type, search by name.
 */
import type { EntityListItem } from "@/lib/api";
import { api } from "@/lib/api";
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatRelativeTime } from "./file-list";

const TYPE_GROUPS: { label: string; types: string[] }[] = [
  { label: "Projects", types: ["clickup_space", "clickup_folder", "linear_project"] },
  { label: "People", types: ["person"] },
  { label: "Databases", types: ["notion_database"] },
];

function humanSourceType(sourceType: string): string {
  const map: Record<string, string> = {
    clickup_space: "ClickUp Space",
    clickup_folder: "ClickUp Folder",
    linear_project: "Linear Project",
    notion_database: "Notion Database",
    person: "Person",
  };
  return map[sourceType] ?? sourceType;
}

export function EntityExplorer() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("company");

  const createMutation = useMutation({
    mutationFn: () => api.entities.create({ name: newName.trim(), sourceType: newType }),
    onSuccess: () => {
      toast.success(`Entity "${newName.trim()}" created.`);
      setShowAddDialog(false);
      setNewName("");
      setNewType("company");
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const cleanupMutation = useMutation({
    mutationFn: () => api.entities.deleteTentative(),
    onSuccess: (result) => {
      toast.success(`Removed ${result.count} tentative entities.`);
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ["entities", typeFilter, debouncedSearch],
    queryFn: () =>
      api.entities.list({
        type: typeFilter ?? undefined,
        search: debouncedSearch || undefined,
        sort: "hotness",
        limit: 200,
      }),
    refetchInterval: 30000,
  });

  const entities = data?.entities ?? [];
  const total = data?.total ?? 0;
  const tentativeCount = entities.filter((e) => e.status === "tentative").length;

  const typeLabel = TYPE_GROUPS.find((g) => g.types.join(",") === typeFilter)?.label ?? null;

  return (
    <div>
      {/* Toolbar */}
      <div className="mt-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            placeholder="Search entities..."
            className="pl-9 text-sm"
          />
        </div>

        {typeLabel ? (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setTypeFilter(null)}>
            {typeLabel}
            <XIcon size={10} className="text-muted-foreground" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                Type
                <CaretDownIcon size={12} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {TYPE_GROUPS.map((group) => (
                <DropdownMenuItem key={group.label} onClick={() => setTypeFilter(group.types.join(","))}>
                  {group.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setShowAddDialog(true)}>
          <PlusIcon size={12} />
          Add Entity
        </Button>

        {tentativeCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs text-destructive"
            onClick={() => cleanupMutation.mutate()}
            disabled={cleanupMutation.isPending}
          >
            {cleanupMutation.isPending ? "Cleaning..." : `Clear ${tentativeCount} tentative`}
          </Button>
        )}
      </div>

      {/* Stats */}
      {!isLoading && (
        <p className="mt-3 text-xs text-muted-foreground">
          {total} entit{total === 1 ? "y" : "ies"}
        </p>
      )}

      {/* Table */}
      <div className="mt-2">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((key) => (
              <Skeleton key={key} className="h-10 rounded-lg" />
            ))}
          </div>
        ) : entities.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <CubeIcon size={32} className="text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">
              {debouncedSearch || typeFilter ? "No entities match your filters" : "No entities yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {debouncedSearch || typeFilter
                ? "Try adjusting your search or filters"
                : "Entities are created during sync from connected sources"}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border">
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <span className="min-w-0 flex-1">Name</span>
              <span className="w-28 text-center">Type</span>
              <span className="w-16 text-center">Mentions</span>
              <span className="w-20 text-center">Status</span>
              <span className="w-24 text-right">Last Active</span>
            </div>

            {/* Rows */}
            {entities.map((entity) => (
              <EntityRow key={entity.id} entity={entity} onSelect={setSelectedEntityId} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Entity</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</p>
              <Input
                value={newName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
                className="mt-1 text-sm"
                placeholder="e.g. CanvasX, Epik, Product Alpha"
              />
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Type</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {["company", "product", "client", "project", "team", "person"].map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={newType === t ? "default" : "outline"}
                    className="h-7 text-xs"
                    onClick={() => setNewType(t)}
                  >
                    {t}
                  </Button>
                ))}
              </div>
            </div>
            <Button
              className="w-full text-xs"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !newName.trim()}
            >
              {createMutation.isPending ? "Creating..." : "Create Entity"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <EntityDetailSheet entityId={selectedEntityId} onClose={() => setSelectedEntityId(null)} />
    </div>
  );
}

function EntityRow({ entity, onSelect }: { entity: EntityListItem; onSelect: (id: string) => void }) {
  const isPerson = entity.sourceType === "person";

  return (
    <button
      type="button"
      onClick={() => onSelect(entity.id)}
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-sm last:border-b-0 hover:bg-muted/30 text-left"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isPerson ? (
          <UserIcon size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <CubeIcon size={14} className="shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{entity.name}</p>
          {entity.aliases.length > 0 && (
            <p className="truncate text-[11px] text-muted-foreground">aka {entity.aliases.join(", ")}</p>
          )}
        </div>
      </div>

      <Badge variant="outline" className="w-28 justify-center text-[10px]">
        {humanSourceType(entity.sourceType)}
        {isPerson && entity.subtype && (
          <span className="ml-1 text-muted-foreground">({entity.subtype === "internal" ? "int" : "ext"})</span>
        )}
      </Badge>

      <span className="w-16 text-center text-xs font-mono text-muted-foreground">
        {entity.mentionCount > 0 ? entity.mentionCount : "-"}
      </span>

      <div className="w-20 text-center">
        <Badge
          variant={
            entity.status === "confirmed" ? "secondary" : entity.status === "tentative" ? "outline" : "destructive"
          }
          className="text-[10px]"
        >
          {entity.status}
        </Badge>
      </div>

      <span className="w-24 text-right text-xs text-muted-foreground">
        {entity.lastMentionAt ? formatRelativeTime(entity.lastMentionAt) : "-"}
      </span>
    </button>
  );
}

function EntityDetailSheet({ entityId, onClose }: { entityId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");

  const { data: entityData, isLoading: isLoadingEntity } = useQuery({
    queryKey: ["entity-detail", entityId],
    queryFn: () => api.entities.get(entityId as string),
    enabled: !!entityId,
  });

  const { data: mentionsData, isLoading: isLoadingMentions } = useQuery({
    queryKey: ["entity-mentions", entityId],
    queryFn: () => api.entities.mentions(entityId as string, { limit: 50 }),
    enabled: !!entityData,
  });

  const entity = entityData?.entity;
  const mentions = mentionsData?.mentions ?? [];
  const totalMentions = mentionsData?.total ?? 0;

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; sourceType?: string }) => api.entities.update(entityId as string, data),
    onSuccess: () => {
      toast.success("Entity updated.");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ["entity-detail", entityId] });
      queryClient.invalidateQueries({ queryKey: ["entities"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.entities.remove(entityId as string),
    onSuccess: () => {
      toast.success("Entity deleted.");
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const startEditing = () => {
    if (entity) {
      setEditName(entity.name);
      setEditType(entity.sourceType);
      setIsEditing(true);
    }
  };

  const sourceCounts = mentions.reduce(
    (acc, m) => {
      const src = m.file.source;
      acc[src] = (acc[src] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <Sheet open={!!entityId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-base">{isLoadingEntity ? "Loading..." : (entity?.name ?? "Entity")}</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {isLoadingEntity ? (
            <div className="space-y-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-24 rounded-lg" />
            </div>
          ) : entity ? (
            <div className="space-y-4">
              {/* Edit mode */}
              {isEditing ? (
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Name</p>
                    <Input
                      value={editName}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Type</p>
                    <Input
                      value={editType}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditType(e.target.value)}
                      className="mt-1 text-sm"
                      placeholder="e.g. person, clickup_space, company, product"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="text-xs"
                      onClick={() => updateMutation.mutate({ name: editName, sourceType: editType })}
                      disabled={updateMutation.isPending || !editName.trim()}
                    >
                      {updateMutation.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => setIsEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Meta badges */}
                  <div className="flex items-center justify-between">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {humanSourceType(entity.sourceType)}
                      </Badge>
                      <Badge variant={entity.status === "confirmed" ? "secondary" : "outline"} className="text-[10px]">
                        {entity.status}
                      </Badge>
                      {entity.subtype && (
                        <Badge variant="secondary" className="text-[10px]">
                          {entity.subtype}
                        </Badge>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={startEditing}>
                      Edit
                    </Button>
                  </div>
                </>
              )}

              {/* Aliases */}
              {entity.aliases.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Aliases</p>
                  <p className="mt-1 text-xs text-muted-foreground">{entity.aliases.join(", ")}</p>
                </div>
              )}

              {/* Source breakdown */}
              {Object.keys(sourceCounts).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Sources ({totalMentions} mentions)
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {Object.entries(sourceCounts).map(([source, count]) => (
                      <Badge key={source} variant="secondary" className="text-[10px]">
                        {source} ({count})
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Mention timeline */}
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Mention Timeline
                </p>

                {isLoadingMentions ? (
                  <div className="mt-2 space-y-2">
                    {[1, 2, 3].map((k) => (
                      <Skeleton key={k} className="h-16 rounded-lg" />
                    ))}
                  </div>
                ) : mentions.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No mentions yet. Run enrichment or backfill to populate.
                  </p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {mentions.map((mention) => (
                      <div key={mention.id} className="rounded-lg border border-border p-3 text-xs hover:bg-muted/30">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Badge variant="outline" className="shrink-0 text-[9px]">
                              {mention.file.source}
                            </Badge>
                            <span className="truncate font-medium">{mention.file.fileName}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <span className="text-muted-foreground">{formatRelativeTime(mention.mentionedAt)}</span>
                            {mention.file.providerUrl && (
                              <a
                                href={mention.file.providerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <ArrowSquareOutIcon size={12} />
                              </a>
                            )}
                          </div>
                        </div>
                        {mention.contextSnippet && (
                          <p className="mt-1.5 text-muted-foreground line-clamp-2">{mention.contextSnippet}</p>
                        )}
                        {mention.file.sourcePath && (
                          <p className="mt-1 text-[10px] text-muted-foreground/60">{mention.file.sourcePath}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Entity not found.</p>
          )}
        </div>

        {entity && (
          <div className="border-t border-border px-4 py-3">
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 text-xs text-destructive hover:bg-destructive/10"
              onClick={() => {
                if (window.confirm(`Delete "${entity.name}" and all its mentions?`)) {
                  deleteMutation.mutate();
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Entity"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
