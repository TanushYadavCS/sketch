/**
 * Relationships tab of the entity drawer. Read-only provenance list, plus the
 * one manual write this surface allows: an admin can declare a person→company
 * link (works_at or engaged_with) and unlink declared rows. Inferred rows stay
 * pipeline-owned — no edit or delete on them.
 */
import type { EntityRelationEvidenceRow, EntityRelationView, EntityRelationsResponse } from "@/lib/api";
import { api } from "@/lib/api";
import { entityAccent, useEntityUi } from "@/lib/entity-ui";
import { CaretDownIcon, CaretRightIcon, PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@sketch/ui/components/dialog";
import { Input } from "@sketch/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "./drawer-kit";

const CONFIDENCE_LABEL: Record<string, string> = {
  CONFIRMED: "CONFIRMED",
  EXTRACTED: "EXTRACTED",
  INFERRED: "INFERRED",
  AMBIGUOUS: "AMBIGUOUS",
};

function formatRelationVerb(type: string): string {
  return type.replace(/_/g, " ");
}

export interface RelationshipsPanelProps {
  relations: EntityRelationsResponse | undefined;
  isLoading: boolean;
  entityId: string;
  sourceType: string;
  isAdmin: boolean;
}

export function RelationshipsPanel({ relations, isLoading, entityId, sourceType, isAdmin }: RelationshipsPanelProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const canDeclare = isAdmin && sourceType === "person";

  if (isLoading) {
    return <Skeleton className="h-20 w-full" />;
  }

  const all: Array<EntityRelationView & { direction: "outgoing" | "incoming" }> = [
    ...(relations?.outgoing ?? []).map((r) => ({ ...r, direction: "outgoing" as const })),
    ...(relations?.incoming ?? []).map((r) => ({ ...r, direction: "incoming" as const })),
  ];
  // AMBIGUOUS pinned across both directions
  const ambiguous = all.filter((r) => r.confidence === "AMBIGUOUS");
  const rest = all.filter((r) => r.confidence !== "AMBIGUOUS");

  return (
    <>
      {canDeclare ? (
        <div className="mb-3">
          <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
            <PlusIcon className="mr-1 h-3 w-3" />
            Link to company
          </Button>
          <LinkCompanyDialog open={linkOpen} onOpenChange={setLinkOpen} entityId={entityId} />
        </div>
      ) : null}
      {all.length === 0 ? (
        <p className="text-xs text-muted-foreground">No relationships yet.</p>
      ) : (
        <>
          {ambiguous.length > 0 ? (
            <div className="mb-3 rounded-lg border border-amber-300/50 bg-amber-50/40 p-2 dark:bg-amber-950/20">
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-500">
                <WarningIcon className="h-3 w-3" />
                <span>Needs review</span>
              </div>
              <div className="flex flex-col">
                {ambiguous.map((r) => (
                  <RelationshipRow key={r.id} relation={r} entityId={entityId} isAdmin={isAdmin} />
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-col">
            {rest.map((r) => (
              <RelationshipRow key={r.id} relation={r} entityId={entityId} isAdmin={isAdmin} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function LinkCompanyDialog({
  open,
  onOpenChange,
  entityId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [relationshipType, setRelationshipType] = useState<"works_at" | "engaged_with">("works_at");
  const queryClient = useQueryClient();

  const companiesQuery = useQuery({
    queryKey: ["entity-drawer", "company-search", search],
    queryFn: () => api.entities.list({ type: "company", search, limit: 8 }),
    enabled: open,
  });

  const declareMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("no company selected");
      return api.entities.declareRelationship(entityId, { targetEntityId: selected.id, relationshipType });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-drawer", "relations", entityId] });
      toast.success("Company linked");
      setSearch("");
      setSelected(null);
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to link company"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Link to company</DialogTitle>
          <DialogDescription>
            Declare where this person belongs. Declared links outrank inferred ones.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Search companies"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(null);
            }}
          />
          <div className="flex max-h-40 flex-col overflow-y-auto rounded-md border">
            {(companiesQuery.data?.entities ?? []).map((company) => (
              <button
                key={company.id}
                type="button"
                onClick={() => setSelected({ id: company.id, name: company.name })}
                className={cn(
                  "px-2 py-1.5 text-left text-xs hover:bg-muted",
                  selected?.id === company.id && "bg-muted font-medium",
                )}
              >
                {company.name}
              </button>
            ))}
            {companiesQuery.data && companiesQuery.data.entities.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No companies match.</p>
            ) : null}
          </div>
          <Select
            value={relationshipType}
            onValueChange={(value) => setRelationshipType(value as "works_at" | "engaged_with")}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="works_at">Works at</SelectItem>
              <SelectItem value="engaged_with">Engaged with</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!selected || declareMutation.isPending} onClick={() => declareMutation.mutate()}>
            {selected ? `Link ${selected.name}` : "Link company"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface RelationshipRowProps {
  relation: EntityRelationView & { direction: "outgoing" | "incoming" };
  entityId: string;
  isAdmin: boolean;
}

function RelationshipRow({ relation, entityId, isAdmin }: RelationshipRowProps) {
  const [expanded, setExpanded] = useState(false);
  const ui = useEntityUi();
  const queryClient = useQueryClient();
  const otherAccent = entityAccent({
    id: relation.other.id,
    name: relation.other.name,
    sourceType: relation.other.sourceType,
  });
  const isDeclared = relation.source === "declared";
  const unlinkMutation = useMutation({
    mutationFn: () => api.entities.removeDeclaredRelationship(entityId, relation.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-drawer", "relations", entityId] });
      toast.success("Link removed");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove link"),
  });
  return (
    <div className="border-b py-2 last:border-b-0">
      <div className="flex w-full items-center gap-2 hover:bg-muted/50">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 text-left">
          {expanded ? <CaretDownIcon className="h-3 w-3 shrink-0" /> : <CaretRightIcon className="h-3 w-3 shrink-0" />}
          <span className="text-xs lowercase text-muted-foreground">
            {relation.direction === "outgoing"
              ? formatRelationVerb(relation.relationshipType)
              : `← ${formatRelationVerb(relation.relationshipType)}`}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            ui.pushEntity(relation.other.id);
          }}
          className="inline-flex items-center gap-1 truncate rounded px-1 py-0.5 text-xs font-medium hover:bg-muted"
          style={{ color: otherAccent }}
        >
          {relation.other.name}
        </button>
        {isDeclared ? (
          <span className="inline-flex items-center rounded bg-violet-50 px-1.5 py-0.5 text-[9px] font-medium text-violet-700 dark:bg-violet-950/40 dark:text-violet-400">
            declared
          </span>
        ) : (
          <ConfidenceChip confidence={relation.confidence} score={relation.confidenceScore} />
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {relation.evidenceCount} {relation.evidenceCount === 1 ? "file" : "files"}
        </span>
        {isDeclared && isAdmin && relation.direction === "outgoing" ? (
          <button
            type="button"
            aria-label="Remove declared link"
            onClick={() => unlinkMutation.mutate()}
            disabled={unlinkMutation.isPending}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <TrashIcon className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      {expanded ? <RelationshipExpanded relation={relation} entityId={entityId} /> : null}
    </div>
  );
}

function ConfidenceChip({ confidence, score }: { confidence: string; score: number }) {
  const className =
    confidence === "CONFIRMED"
      ? "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400"
      : confidence === "EXTRACTED"
        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
        : confidence === "INFERRED"
          ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-500";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium", className)}>
      <span>{CONFIDENCE_LABEL[confidence] ?? confidence}</span>
      {confidence !== "AMBIGUOUS" ? <span className="font-mono opacity-70">{score.toFixed(2)}</span> : null}
    </span>
  );
}

function RelationshipExpanded({
  relation,
  entityId,
}: {
  relation: EntityRelationView;
  entityId: string;
}) {
  const evidenceQuery = useQuery({
    queryKey: ["entity-drawer", "relation-evidence", entityId, relation.id],
    queryFn: () => api.entities.relationEvidence(entityId, relation.id),
  });
  return (
    <div className="ml-5 mt-1 space-y-2 rounded-md bg-muted/40 p-2 text-xs">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Evidence</div>
      {evidenceQuery.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : !evidenceQuery.data || evidenceQuery.data.rows.length === 0 ? (
        evidenceQuery.data && evidenceQuery.data.totalCount > 0 ? (
          <p className="text-muted-foreground">
            {evidenceQuery.data.totalCount} {evidenceQuery.data.totalCount === 1 ? "file" : "files"} not visible to you.
          </p>
        ) : (
          <p className="text-muted-foreground">No evidence rows.</p>
        )
      ) : (
        <>
          <ul className="space-y-1">
            {evidenceQuery.data.rows.map((row) => (
              <EvidenceItem key={`${row.fileId}:${row.chunkIndex ?? "n"}`} row={row} />
            ))}
          </ul>
          {evidenceQuery.data.visibleCount < evidenceQuery.data.totalCount ? (
            <p className="text-[10px] text-muted-foreground">
              +{evidenceQuery.data.totalCount - evidenceQuery.data.visibleCount} not visible to you
            </p>
          ) : null}
        </>
      )}
      {relation.reviewId ? (
        <a
          className="text-[11px] text-primary underline-offset-2 hover:underline"
          href={`/files?review=${relation.reviewId}`}
        >
          Review this →
        </a>
      ) : null}
    </div>
  );
}

function EvidenceItem({ row }: { row: EntityRelationEvidenceRow }) {
  return (
    <li className="flex flex-col gap-0.5 rounded border bg-background p-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{row.fileName}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelative(row.occurredAt)}</span>
      </div>
      {row.contextSnippet ? (
        <p className="line-clamp-2 text-[11px] text-muted-foreground">{row.contextSnippet}</p>
      ) : null}
    </li>
  );
}
