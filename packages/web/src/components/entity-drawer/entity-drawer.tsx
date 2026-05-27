/**
 * EntityDrawer — the universal provenance/audit surface for one entity.
 *
 * Phase 1: brief (WHAT only), Identity, Relationships sections + stacked
 * navigation. Timeline + AI brief Signal/SoWhat rows + global popover land
 * in Phase 2.
 *
 * Driven by EntityUiProvider's stack. Each level renders independently —
 * pushing a related entity pushes a new id onto the stack; Back chip pops.
 */
import type {
  EntityDetail,
  EntityRelationEvidenceRow,
  EntityRelationView,
  EntityRelationsResponse,
  EntitySourceRef,
} from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar, EntityChip, entityAccent, useEntityUi } from "@/lib/entity-ui";
import { ArrowLeftIcon, CaretDownIcon, CaretRightIcon, WarningIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

const CONFIDENCE_LABEL: Record<string, string> = {
  EXTRACTED: "EXTRACTED",
  INFERRED: "INFERRED",
  AMBIGUOUS: "AMBIGUOUS",
};

function formatRelationVerb(type: string): string {
  return type.replace(/_/g, " ");
}

function formatRelative(iso: string | null): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function EntityDrawer() {
  const ui = useEntityUi();
  const open = ui.stack.length > 0 && ui.mode === "drawer";
  const currentId = ui.stack[ui.stack.length - 1];
  const previousName = useDrawerPreviousName(ui.stack);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) ui.closeAll();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
        <SheetTitle className="sr-only">Entity drawer</SheetTitle>
        <SheetDescription className="sr-only">
          Provenance and audit view for the selected entity, with identity, relationships, and timeline sections.
        </SheetDescription>
        {currentId ? (
          <EntityDrawerBody
            key={currentId}
            entityId={currentId}
            stackDepth={ui.stack.length}
            previousName={previousName}
            onBack={ui.popEntity}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function useDrawerPreviousName(stack: string[]): string | null {
  const prevId = stack.length > 1 ? stack[stack.length - 2] : null;
  const { data } = useQuery({
    queryKey: ["entity-drawer", "header-name", prevId],
    queryFn: () => api.entities.get(prevId as string),
    enabled: !!prevId,
  });
  return data?.entity.name ?? null;
}

interface EntityDrawerBodyProps {
  entityId: string;
  stackDepth: number;
  previousName: string | null;
  onBack: () => void;
}

function EntityDrawerBody({ entityId, stackDepth, previousName, onBack }: EntityDrawerBodyProps) {
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
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!profileQuery.data) {
    return <div className="p-6 text-sm text-muted-foreground">Entity not found.</div>;
  }

  const { entity, sourceRefs } = profileQuery.data;
  const accent = entityAccent({ id: entity.id, name: entity.name, sourceType: entity.sourceType });

  return (
    <>
      <DrawerHeader
        entity={entity}
        stackDepth={stackDepth}
        previousName={previousName}
        onBack={onBack}
        accent={accent}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <AiBriefBlock entity={entity} accent={accent} />
        <SectionDivider />
        <IdentityPanel entity={entity} sourceRefs={sourceRefs} accent={accent} />
        <SectionDivider />
        <RelationshipsPanel relations={relationsQuery.data} isLoading={relationsQuery.isLoading} entityId={entity.id} />
      </div>
    </>
  );
}

interface DrawerHeaderProps {
  entity: EntityDetail;
  stackDepth: number;
  previousName: string | null;
  onBack: () => void;
  accent: string;
}

function DrawerHeader({ entity, stackDepth, previousName, onBack, accent }: DrawerHeaderProps) {
  return (
    <div
      className="sticky top-0 z-10 border-b bg-background px-6 pb-4 pt-5"
      style={{ borderTopColor: accent, borderTopWidth: 3 }}
    >
      {stackDepth > 1 && previousName ? (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          <span>Back to {previousName}</span>
        </button>
      ) : null}
      <div className="flex items-start gap-3">
        <EntityAvatar entity={entity} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[20px] leading-tight">{entity.name}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {entity.profile.entityType}
            </Badge>
            <span className="font-mono">{entity.id.slice(0, 8)}</span>
            {entity.status !== "confirmed" ? (
              <Badge variant="secondary" className="text-[10px]">
                {entity.status}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionDivider() {
  return <div className="my-5 h-px bg-border" />;
}

function AiBriefBlock({ entity, accent }: { entity: EntityDetail; accent: string }) {
  const { aiBrief } = entity.profile;
  return (
    <section aria-label="AI brief" className="rounded-lg border p-4" style={{ borderColor: `${accent}33` }}>
      <BriefRow label="What" value={aiBrief.what} />
      {/* Signal / So what land in Phase 2; render placeholders until generator wires up. */}
      <BriefRow label="Signal" value={aiBrief.signal} placeholder="—" muted />
      <BriefRow label="So what" value={aiBrief.soWhat} placeholder="—" muted />
    </section>
  );
}

function BriefRow({
  label,
  value,
  placeholder,
  muted,
}: {
  label: string;
  value: string | null;
  placeholder?: string;
  muted?: boolean;
}) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-3 py-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("text-sm leading-snug", muted && "text-muted-foreground")}>
        {value ?? placeholder ?? "—"}
      </span>
    </div>
  );
}

interface IdentityPanelProps {
  entity: EntityDetail;
  sourceRefs: EntitySourceRef[];
  accent: string;
}

function IdentityPanel({ entity, sourceRefs, accent: _accent }: IdentityPanelProps) {
  const meta = entity.metadata ?? {};
  const role = typeof meta.role === "string" ? meta.role : null;
  const email = typeof meta.email === "string" ? meta.email : null;

  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  if (email) rows.push({ label: "Email", value: <span className="font-mono text-xs">{email}</span> });
  if (role) rows.push({ label: "Role", value: role });
  if (entity.profile.domainsForCompany.length > 0) {
    rows.push({
      label: "Domains",
      value: (
        <div className="flex flex-wrap gap-1.5">
          {entity.profile.domainsForCompany.map((d) => (
            <Badge key={d.domain} variant={d.isPrimary ? "secondary" : "outline"} className="text-[10px]">
              {d.domain}
              {d.isPrimary ? " · primary" : null}
            </Badge>
          ))}
        </div>
      ),
    });
  }
  if (entity.aliases.length > 0) {
    rows.push({ label: "Aliases", value: <span className="text-xs">{entity.aliases.join(", ")}</span> });
  }
  if (Object.keys(entity.profile.sourceCounts).length > 0) {
    rows.push({
      label: "Sources",
      value: (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(entity.profile.sourceCounts).map(([source, count]) => (
            <Badge key={source} variant="secondary" className="text-[10px]">
              {source} · {count}
            </Badge>
          ))}
        </div>
      ),
    });
  }
  if (entity.profile.lastSeenAt) {
    rows.push({
      label: "Last seen",
      value: <span className="text-xs">{formatRelative(entity.profile.lastSeenAt)}</span>,
    });
  }
  if (sourceRefs.length > 0) {
    rows.push({
      label: "Source IDs",
      value: (
        <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
          {sourceRefs.slice(0, 4).map((r) => (
            <span key={r.id} className="truncate">
              {r.source}:{r.sourceId}
            </span>
          ))}
        </div>
      ),
    });
  }

  return (
    <section aria-label="Identity">
      <SectionHeader title="Identity" />
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No identity facts yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <DrawerRow key={r.label} label={r.label}>
              {r.value}
            </DrawerRow>
          ))}
        </div>
      )}
    </section>
  );
}

function DrawerRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-3">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
      {hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

interface RelationshipsPanelProps {
  relations: EntityRelationsResponse | undefined;
  isLoading: boolean;
  entityId: string;
}

function RelationshipsPanel({ relations, isLoading, entityId }: RelationshipsPanelProps) {
  if (isLoading) {
    return (
      <section aria-label="Relationships">
        <SectionHeader title="Relationships" />
        <Skeleton className="h-20 w-full" />
      </section>
    );
  }
  if (!relations || (relations.outgoing.length === 0 && relations.incoming.length === 0)) {
    return (
      <section aria-label="Relationships">
        <SectionHeader title="Relationships" />
        <p className="text-xs text-muted-foreground">No relationships yet.</p>
      </section>
    );
  }

  // AMBIGUOUS pinned across both directions
  const all: Array<EntityRelationView & { direction: "outgoing" | "incoming" }> = [
    ...relations.outgoing.map((r) => ({ ...r, direction: "outgoing" as const })),
    ...relations.incoming.map((r) => ({ ...r, direction: "incoming" as const })),
  ];
  const ambiguous = all.filter((r) => r.confidence === "AMBIGUOUS");
  const rest = all.filter((r) => r.confidence !== "AMBIGUOUS");

  return (
    <section aria-label="Relationships">
      <SectionHeader
        title="Relationships"
        hint={relations.truncated ? `${relations.totalCount}+ shown · capped` : `${relations.totalCount}`}
      />
      {ambiguous.length > 0 ? (
        <div className="mb-3 rounded-lg border border-amber-300/50 bg-amber-50/40 p-2 dark:bg-amber-950/20">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-500">
            <WarningIcon className="h-3 w-3" />
            <span>Needs review</span>
          </div>
          <div className="flex flex-col">
            {ambiguous.map((r) => (
              <RelationshipRow key={r.id} relation={r} entityId={entityId} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col">
        {rest.map((r) => (
          <RelationshipRow key={r.id} relation={r} entityId={entityId} />
        ))}
      </div>
    </section>
  );
}

interface RelationshipRowProps {
  relation: EntityRelationView & { direction: "outgoing" | "incoming" };
  entityId: string;
}

function RelationshipRow({ relation, entityId }: RelationshipRowProps) {
  const [expanded, setExpanded] = useState(false);
  const ui = useEntityUi();
  const otherAccent = entityAccent({
    id: relation.other.id,
    name: relation.other.name,
    sourceType: relation.other.sourceType,
  });
  return (
    <div className="border-b py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left hover:bg-muted/50"
      >
        {expanded ? <CaretDownIcon className="h-3 w-3 shrink-0" /> : <CaretRightIcon className="h-3 w-3 shrink-0" />}
        <span className="text-xs lowercase text-muted-foreground">
          {relation.direction === "outgoing"
            ? formatRelationVerb(relation.relationshipType)
            : `← ${formatRelationVerb(relation.relationshipType)}`}
        </span>
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
        <ConfidenceChip confidence={relation.confidence} score={relation.confidenceScore} />
        <span className="ml-auto text-[10px] text-muted-foreground">
          {relation.evidenceCount} {relation.evidenceCount === 1 ? "file" : "files"}
        </span>
      </button>
      {expanded ? <RelationshipExpanded relation={relation} entityId={entityId} /> : null}
    </div>
  );
}

function ConfidenceChip({ confidence, score }: { confidence: string; score: number }) {
  const className =
    confidence === "EXTRACTED"
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
          {evidenceQuery.data.truncated && evidenceQuery.data.visibleCount > evidenceQuery.data.rows.length ? (
            <p className="text-[10px] text-muted-foreground">
              +{evidenceQuery.data.visibleCount - evidenceQuery.data.rows.length} more visible evidence rows
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

/** Convenience re-export so callers can pull both the provider mount and the drawer from one place. */
export { EntityChip };
