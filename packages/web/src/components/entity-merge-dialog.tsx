/**
 * EntityMergeDialog — the generic dedup surface. Combine two same-type entities:
 * pick the other side, preview what moves onto the survivor and what collapses,
 * choose which side survives, confirm. Past merges are listed with an unmerge
 * (reversible) control. Admin-only (the routes enforce it); works for every
 * entity type and carries no project-specific concepts.
 */
import { type EntityMergePreview, type EntityMergeRecord, api } from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sketch/ui/components/dialog";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EntityPicker } from "./entity-picker";

interface EntityMergeDialogProps {
  entityId: string;
  entityName: string;
  sourceType: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged?: (survivorId: string) => void;
}

function mergesKey(entityId: string): unknown[] {
  return ["entity-merge", "history", entityId];
}

function invalidateEntitySurfaces(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ["entity-drawer"] });
  queryClient.invalidateQueries({ queryKey: ["entities"] });
  queryClient.invalidateQueries({ queryKey: ["entity-graph"] });
}

export function EntityMergeDialog({
  entityId,
  entityName,
  sourceType,
  open,
  onOpenChange,
  onMerged,
}: EntityMergeDialogProps) {
  const [otherId, setOtherId] = useState<string | null>(null);
  const [survivorId, setSurvivorId] = useState(entityId);

  function reset() {
    setOtherId(null);
    setSurvivorId(entityId);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Merge {entityName}</DialogTitle>
          <DialogDescription>
            Combine two {sourceType}s that are the same. Everything from the merged-in side moves onto the survivor; you
            can undo it afterward.
          </DialogDescription>
        </DialogHeader>

        {otherId ? (
          <MergePreviewPane
            entityId={entityId}
            entityName={entityName}
            otherId={otherId}
            survivorId={survivorId}
            onSurvivorChange={setSurvivorId}
            onBack={reset}
            onMerged={() => {
              reset();
              onOpenChange(false);
              onMerged?.(survivorId);
            }}
          />
        ) : (
          <div className="py-1">
            <EntityPicker
              entityType={sourceType}
              excludeEntityId={entityId}
              placeholder={`Find the other ${sourceType}…`}
              onPick={(id) => {
                setSurvivorId(entityId);
                setOtherId(id);
              }}
            />
          </div>
        )}

        <MergeHistory entityId={entityId} />
      </DialogContent>
    </Dialog>
  );
}

function movesTotal(counts: EntityMergePreview["counts"]): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function collisionsTotal(collisions: EntityMergePreview["collisions"]): number {
  return Object.values(collisions).reduce((a, b) => a + b, 0);
}

function MergePreviewPane({
  entityId,
  entityName,
  otherId,
  survivorId,
  onSurvivorChange,
  onBack,
  onMerged,
}: {
  entityId: string;
  entityName: string;
  otherId: string;
  survivorId: string;
  onSurvivorChange: (id: string) => void;
  onBack: () => void;
  onMerged: () => void;
}) {
  const queryClient = useQueryClient();
  const loserId = survivorId === entityId ? otherId : entityId;
  const otherQuery = useQuery({
    queryKey: ["entity-drawer", "header-name", otherId],
    queryFn: () => api.entities.get(otherId),
    staleTime: 60_000,
  });
  const otherName = otherQuery.data?.entity.name ?? otherId;

  const previewQuery = useQuery({
    queryKey: ["entity-merge", "preview", survivorId, loserId],
    queryFn: () => api.entities.previewMerge(survivorId, loserId),
  });

  const mergeMutation = useMutation({
    mutationFn: () => api.entities.merge(survivorId, loserId),
    onSuccess: () => {
      invalidateEntitySurfaces(queryClient);
      queryClient.invalidateQueries({ queryKey: mergesKey(entityId) });
      onMerged();
    },
  });

  const sides: { id: string; name: string }[] = [
    { id: entityId, name: entityName },
    { id: otherId, name: otherName },
  ];

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          Keep as survivor
        </div>
        <div className="inline-flex w-full rounded-lg border-[0.5px] border-border bg-card p-0.5">
          {sides.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSurvivorChange(s.id)}
              className={cn(
                "flex-1 truncate rounded-md px-3 py-1.5 text-xs transition-colors",
                survivorId === s.id
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="merge-direction">
          <ArrowsLeftRightIcon className="mr-1 inline h-3 w-3" />
          Merging <span className="font-medium">{sides.find((s) => s.id === loserId)?.name}</span> into{" "}
          <span className="font-medium">{sides.find((s) => s.id === survivorId)?.name}</span>.
        </p>
      </div>

      {previewQuery.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : previewQuery.data?.blocked ? (
        <p className="rounded-md border border-amber-300/50 bg-amber-50/40 p-2 text-xs text-amber-700 dark:bg-amber-950/20 dark:text-amber-500">
          These can't be merged ({previewQuery.data.blocked.toLowerCase().replace(/_/g, " ")}).
        </p>
      ) : previewQuery.data ? (
        <div className="rounded-lg border p-3 text-xs">
          <p className="mb-2" data-testid="merge-summary">
            <span className="font-medium">{movesTotal(previewQuery.data.counts)}</span> records move onto the survivor
            {collisionsTotal(previewQuery.data.collisions) > 0 ? (
              <>
                {" · "}
                <span className="text-muted-foreground">
                  {collisionsTotal(previewQuery.data.collisions)} duplicates will be combined
                </span>
              </>
            ) : null}
            {previewQuery.data.selfLoopsDropped > 0 ? (
              <span className="text-muted-foreground"> · {previewQuery.data.selfLoopsDropped} self-links dropped</span>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-1">
            <CountBadge label="mentions" n={previewQuery.data.counts.mentions} />
            <CountBadge label="relationships" n={previewQuery.data.counts.relationships} />
            <CountBadge label="sources" n={previewQuery.data.counts.sourceRefs} />
            <CountBadge label="contacts" n={previewQuery.data.counts.contactPoints} />
            <CountBadge label="domains" n={previewQuery.data.counts.domains} />
          </div>
        </div>
      ) : null}

      {mergeMutation.isError ? (
        <p className="text-[11px] text-destructive">{mergeErrorMessage(mergeMutation.error)}</p>
      ) : null}

      <DialogFooter className="gap-2 sm:gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={mergeMutation.isPending || previewQuery.isLoading || Boolean(previewQuery.data?.blocked)}
          onClick={() => mergeMutation.mutate()}
        >
          Confirm merge
        </Button>
      </DialogFooter>
    </div>
  );
}

function CountBadge({ label, n }: { label: string; n: number }) {
  if (n === 0) return null;
  return (
    <Badge variant="outline" className="text-[10px] tabular-nums">
      {n} {label}
    </Badge>
  );
}

function MergeHistory({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: mergesKey(entityId),
    queryFn: () => api.entities.listMerges(entityId),
  });
  const unmergeMutation = useMutation({
    mutationFn: (mergeId: string) => api.entities.unmerge(mergeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mergesKey(entityId) });
      invalidateEntitySurfaces(queryClient);
    },
  });

  const merges = historyQuery.data?.merges ?? [];
  if (merges.length === 0) return null;

  return (
    <div className="border-t pt-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Merge history</div>
      <div className="flex flex-col">
        {merges.map((m) => (
          <MergeHistoryRow
            key={m.id}
            record={m}
            pending={unmergeMutation.isPending}
            onUnmerge={() => unmergeMutation.mutate(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MergeHistoryRow({
  record,
  pending,
  onUnmerge,
}: {
  record: EntityMergeRecord;
  pending: boolean;
  onUnmerge: () => void;
}) {
  const undone = Boolean(record.unmerged_at);
  return (
    <div className="flex items-center justify-between gap-2 border-b py-2 text-xs last:border-b-0">
      <span className={cn("min-w-0 flex-1 truncate", undone && "text-muted-foreground line-through")}>
        Merged {record.merged_entity_id.slice(0, 8)} → {record.survivor_entity_id.slice(0, 8)}
      </span>
      {undone ? (
        <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">
          Unmerged
        </Badge>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
          disabled={pending}
          onClick={onUnmerge}
        >
          Unmerge
        </Button>
      )}
    </div>
  );
}

function mergeErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "TYPE_MISMATCH") return "Those two entities are different types.";
    if (err.code === "SELF_MERGE") return "Pick a different entity to merge.";
    if (err.code === "ALREADY_MERGED") return "One of these has already been merged.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
