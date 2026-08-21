/**
 * Lightweight peek surface for an entity. Centered modal, ~360px wide, transparent
 * backdrop, dismissed on outside click. Five-row contract per the plan:
 *   1. Avatar + name + type badge
 *   2. WHAT row (deterministic — no LLM dependency)
 *   3. Top-3 relationships as pills
 *   4. Last-seen line
 *   5. "Open in drawer →" button
 *
 * Mounted globally by EntityUiProvider; opened via openEntity(id, { mode: "popover" }).
 */
import { type EntityRelationView, api } from "@/lib/api";
import { EntityAvatar, entityAccent, entityDisplayLabel, useEntityUi } from "@/lib/entity-ui";
import { Badge } from "@sketch/ui/components/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@sketch/ui/components/dialog";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { formatRelative } from "./drawer-kit";

const CONFIDENCE_ORDER: Record<string, number> = { CONFIRMED: -1, AMBIGUOUS: 0, EXTRACTED: 1, INFERRED: 2 };

function topRelationships(outgoing: EntityRelationView[], incoming: EntityRelationView[]): EntityRelationView[] {
  return [...outgoing, ...incoming]
    .sort((a, b) => {
      const ca = CONFIDENCE_ORDER[a.confidence] ?? 3;
      const cb = CONFIDENCE_ORDER[b.confidence] ?? 3;
      if (ca !== cb) return ca - cb;
      return b.evidenceCount - a.evidenceCount;
    })
    .slice(0, 3);
}

export function EntityPopover() {
  const ui = useEntityUi();
  const open = ui.mode === "popover" && ui.stack.length > 0;
  const entityId = ui.stack[ui.stack.length - 1] ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) ui.closeAll();
      }}
    >
      <DialogContent className="max-w-[360px] gap-3 p-4">
        <DialogTitle className="sr-only">Entity preview</DialogTitle>
        <DialogDescription className="sr-only">
          Quick preview of the entity with top relationships. Click open to see full drawer.
        </DialogDescription>
        {entityId ? <PopoverBody entityId={entityId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PopoverBody({ entityId }: { entityId: string }) {
  const ui = useEntityUi();
  const profileQuery = useQuery({
    queryKey: ["entity-drawer", "profile", entityId],
    queryFn: () => api.entities.get(entityId),
  });
  const relationsQuery = useQuery({
    queryKey: ["entity-drawer", "relations", entityId],
    queryFn: () => api.entities.relations(entityId),
    enabled: !!profileQuery.data,
  });

  if (profileQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (!profileQuery.data) {
    return <p className="text-sm text-muted-foreground">Entity not found.</p>;
  }

  const { entity } = profileQuery.data;
  const accent = entityAccent({ id: entity.id, name: entity.name, sourceType: entity.sourceType });
  const tops = relationsQuery.data ? topRelationships(relationsQuery.data.outgoing, relationsQuery.data.incoming) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <EntityAvatar entity={entity} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-base">{entityDisplayLabel(entity)}</p>
          <Badge variant="outline" className="mt-0.5 text-[10px] uppercase tracking-wider">
            {entity.profile.entityType}
          </Badge>
        </div>
      </div>
      <p className="text-xs text-foreground">{entity.profile.summary.identity || entity.profile.summary.activity}</p>
      {tops.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tops.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => ui.openEntity(r.other.id, { mode: "drawer" })}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] hover:bg-muted"
              style={{ borderColor: `${accent}40` }}
            >
              <span className="lowercase text-muted-foreground">{r.relationshipType.replace(/_/g, " ")}</span>
              <span className="font-medium">{r.other.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">Last seen {formatRelative(entity.profile.lastSeenAt)}</p>
      <button
        type="button"
        onClick={() => ui.openEntity(entity.id, { mode: "drawer" })}
        className="w-full rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
      >
        Open in drawer →
      </button>
    </div>
  );
}
