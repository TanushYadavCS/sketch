/**
 * EntityDrawer — the universal provenance/audit surface for one entity.
 *
 * Layout:
 *   1. Header — name + type badge + identity chips (domains / email+role /
 *      aliases) inline; last seen right-aligned.
 *   2. Summary block — Gemini narrative + up to 3 top learned-fact bullets.
 *      Falls back to the deterministic WHAT line when the brief is cold and
 *      there are no facts yet.
 *   3. Tabs — Timeline (default) | Relationships | Tasks (projects only) | Scope (projects only).
 *
 * Driven by EntityUiProvider's stack. Each level renders independently —
 * pushing a related entity pushes a new id onto the stack; Back chip pops.
 */
import { EntityMergeDialog } from "@/components/entity-merge-dialog";
import { EntityShareDialog } from "@/components/entity-share-dialog";
import type {
  EntityContactPoint,
  EntityContactPointKind,
  EntityDetail,
  EntityRelationEvidenceRow,
  EntityRelationView,
  EntityRelationsResponse,
  EntityTask,
  TaskStatus,
} from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar, EntityChip, entityAccent, useEntityUi } from "@/lib/entity-ui";
import {
  ArrowLeftIcon,
  ArrowsLeftRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  GlobeIcon,
  PencilSimpleIcon,
  PlusIcon,
  ShareNetworkIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard, SectionLabel } from "./drawer-kit";
import { ScopePanel } from "./scope-panel";
import { TimelineStrip } from "./timeline-strip";

const CONFIDENCE_LABEL: Record<string, string> = {
  EXTRACTED: "EXTRACTED",
  INFERRED: "INFERRED",
  AMBIGUOUS: "AMBIGUOUS",
};

const TASK_STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];

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
          Provenance and audit view for the selected entity, with identity flags, summary, timeline, and relationships.
        </SheetDescription>
        {currentId ? (
          <EntityDrawerBody
            key={currentId}
            entityId={currentId}
            stackDepth={ui.stack.length}
            previousName={previousName}
            onBack={ui.popEntity}
            onOpenEntity={ui.openEntity}
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
  onOpenEntity: (id: string) => void;
}

function EntityDrawerBody({ entityId, stackDepth, previousName, onBack, onOpenEntity }: EntityDrawerBodyProps) {
  const sessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => api.auth.session(),
    staleTime: 60_000,
  });
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

  const { entity } = profileQuery.data;
  const isAdmin = sessionQuery.data?.role === "admin";
  const accent = entityAccent({ id: entity.id, name: entity.name, sourceType: entity.sourceType });

  return (
    <>
      <DrawerHeader
        entity={entity}
        stackDepth={stackDepth}
        previousName={previousName}
        onBack={onBack}
        accent={accent}
        onOpenEntity={onOpenEntity}
        isAdmin={isAdmin}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {entity.sourceType === "person" ? <IdentityStrip entity={entity} isAdmin={isAdmin} /> : null}
        <SummaryBlock entity={entity} accent={accent} />
        <DrawerTabs
          entityId={entity.id}
          sourceType={entity.sourceType}
          relations={relationsQuery.data}
          relationsLoading={relationsQuery.isLoading}
        />
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
  onOpenEntity: (id: string) => void;
  isAdmin: boolean;
}

function DrawerHeader({ entity, stackDepth, previousName, onBack, accent, onOpenEntity, isAdmin }: DrawerHeaderProps) {
  const lastSeen = entity.profile.lastSeenAt;
  const [shareOpen, setShareOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 flex-1 truncate font-serif text-[20px] leading-tight">{entity.name}</h2>
            <div className="flex shrink-0 items-center gap-2">
              {entity.shareWithEveryone ? (
                <Badge variant="outline" className="gap-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <GlobeIcon size={10} />
                  Anyone in org
                </Badge>
              ) : null}
              {lastSeen ? (
                <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Last seen {formatRelative(lastSeen)}
                </span>
              ) : null}
              {isAdmin ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px]"
                    onClick={() => setMergeOpen(true)}
                  >
                    <ArrowsLeftRightIcon size={12} />
                    Merge
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px]"
                    onClick={() => setShareOpen(true)}
                  >
                    <ShareNetworkIcon size={12} />
                    Share
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-[11px] text-destructive hover:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <TrashIcon size={12} />
                    Delete
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {entity.profile.entityType}
            </Badge>
            <IdentityChips entity={entity} />
            {entity.status !== "confirmed" ? (
              <Badge variant="secondary" className="text-[10px]">
                {entity.status}
              </Badge>
            ) : null}
            {(entity.manualShares?.length ?? 0) > 0 ? (
              <Badge variant="secondary" className="text-[10px]">
                Shared with {entity.manualShares?.length ?? 0}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      {isAdmin ? (
        <>
          <EntityShareDialog
            entityId={entity.id}
            entityName={entity.name}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
          <EntityMergeDialog
            entityId={entity.id}
            entityName={entity.name}
            sourceType={entity.sourceType}
            open={mergeOpen}
            onOpenChange={setMergeOpen}
            onMerged={(survivorId) => {
              if (survivorId !== entity.id) onOpenEntity(survivorId);
            }}
          />
          <DeleteEntityDialog
            entityId={entity.id}
            entityName={entity.name}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Admin-only soft delete. The entity is tombstoned server-side (hidden from the
 * graph, recoverable by an admin) and its name is suppressed so the LLM
 * enrichment paths don't re-mint it. On success the drawer closes and every
 * surface that could still show the entity is invalidated.
 */
function DeleteEntityDialog({
  entityId,
  entityName,
  open,
  onOpenChange,
}: {
  entityId: string;
  entityName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = useEntityUi();
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => api.entities.remove(entityId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-drawer"] });
      queryClient.invalidateQueries({ queryKey: ["entities"] });
      queryClient.invalidateQueries({ queryKey: ["entity-graph"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${entityName} deleted`);
      onOpenChange(false);
      ui.closeAll();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityName}?</AlertDialogTitle>
          <AlertDialogDescription>
            It will be hidden from the graph and won't be recreated automatically. An admin can restore it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              deleteMutation.mutate();
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Identity flags rendered inline in the header. Person → email + role.
 * Company/product → domains (primary first). All types → aliases as a muted
 * trailing line.
 */
function IdentityChips({ entity }: { entity: EntityDetail }) {
  const meta = entity.metadata ?? {};
  const role = typeof meta.role === "string" ? meta.role : null;
  const domains = entity.profile.domainsForCompany;
  const aliases = entity.aliases;

  return (
    <>
      {role ? (
        <Badge variant="outline" className="text-[10px]">
          {role}
        </Badge>
      ) : null}
      {domains.map((d) => (
        <Badge
          key={d.domain}
          variant={d.isPrimary ? "secondary" : "outline"}
          className="font-mono text-[10px] normal-case tracking-normal"
        >
          {d.domain}
          {d.isPrimary ? " · primary" : null}
        </Badge>
      ))}
      {aliases.length > 0 ? (
        <span className="text-[11px] text-muted-foreground">Also: {aliases.join(", ")}</span>
      ) : null}
    </>
  );
}

const EDITABLE_CONTACT_KINDS: Array<{ kind: EntityContactPointKind; label: string }> = [
  { kind: "email", label: "Email" },
  { kind: "phone", label: "Phone" },
];

function localContactValue(kind: EntityContactPointKind, value: string): string {
  const trimmed = value.trim();
  return kind === "email" ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, "");
}

function IdentityStrip({ entity, isAdmin }: { entity: EntityDetail; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const points = (entity.contactPoints ?? []).filter((point) => point.kind === "email" || point.kind === "phone");
  const [expanded, setExpanded] = useState(points.length === 0);
  const [editing, setEditing] = useState<EntityContactPoint | null>(null);
  const [addingKind, setAddingKind] = useState<EntityContactPointKind | null>(null);
  const [value, setValue] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["entity-drawer", "profile", entity.id] });
    void queryClient.invalidateQueries({ queryKey: ["entities"] });
    setEditing(null);
    setAddingKind(null);
    setValue("");
    setIsPrimary(false);
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      const kind = editing?.kind ?? addingKind;
      if (!kind) throw new Error("Choose a contact type");
      const normalized = localContactValue(kind, value);
      const duplicate = points.some(
        (point) =>
          point.id !== editing?.id && point.kind === kind && localContactValue(kind, point.value) === normalized,
      );
      if (duplicate) throw new Error("This contact point already exists on this person");
      return editing
        ? api.entities.updateContactPoint(entity.id, editing.id, { value, isPrimary })
        : api.entities.createContactPoint(entity.id, {
            kind: kind as "email" | "phone",
            value,
            makePrimary: isPrimary,
          });
    },
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  });
  const deleteMutation = useMutation({
    mutationFn: (contactPointId: string) => api.entities.deleteContactPoint(entity.id, contactPointId),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  });

  const primaryEmail =
    points.find((point) => point.kind === "email" && point.isPrimary) ?? points.find((point) => point.kind === "email");
  const primaryPhone =
    points.find((point) => point.kind === "phone" && point.isPrimary) ?? points.find((point) => point.kind === "phone");
  const primaryIds = new Set([primaryEmail?.id, primaryPhone?.id]);
  const additional = points.filter((point) => !primaryIds.has(point.id)).length;

  return (
    <div className="mb-4 rounded-lg border bg-muted/20">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Identity</div>
            {!expanded ? (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
                {primaryEmail ? <span>{primaryEmail.value}</span> : null}
                {primaryPhone ? <span>{primaryPhone.value}</span> : null}
                {!primaryEmail && !primaryPhone ? (
                  <span className="text-muted-foreground">No email or phone</span>
                ) : null}
                {additional > 0 ? <span className="text-muted-foreground">+{additional}</span> : null}
              </div>
            ) : null}
          </div>
          {expanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
        </button>
        {isAdmin && !expanded ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px]"
            onClick={() => {
              setExpanded(true);
              setAddingKind("email");
              setValue("");
              setIsPrimary(!points.some((point) => point.kind === "email"));
            }}
          >
            <PlusIcon size={12} /> Add
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <div className="space-y-2 border-t px-4 py-3">
          {points.map((point) => (
            <div key={point.id} className="flex items-center gap-2 rounded-md bg-background px-3 py-2">
              <span className="w-12 shrink-0 text-[10px] font-semibold uppercase text-muted-foreground">
                {point.kind}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{point.value}</span>
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{point.provenance}</span>
              {point.isPrimary ? (
                <Badge variant="secondary" className="text-[9px]">
                  Primary
                </Badge>
              ) : null}
              {isAdmin ? (
                <>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Edit ${point.value}`}
                    onClick={() => {
                      setEditing(point);
                      setAddingKind(null);
                      setValue(point.value);
                      setIsPrimary(point.isPrimary);
                    }}
                  >
                    <PencilSimpleIcon size={13} />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    aria-label={`Delete ${point.value}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(point.id)}
                  >
                    <TrashIcon size={13} />
                  </Button>
                </>
              ) : null}
            </div>
          ))}

          {isAdmin && (editing || addingKind) ? (
            <form
              className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2"
              onSubmit={(event) => {
                event.preventDefault();
                saveMutation.mutate();
              }}
            >
              <span className="w-12 text-[10px] font-semibold uppercase text-muted-foreground">
                {editing?.kind ?? addingKind}
              </span>
              <Input
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className="h-8 min-w-48 flex-1 font-mono text-xs"
                placeholder={addingKind === "phone" ? "+14155550123" : "name@example.com"}
                required
              />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
                Primary
              </label>
              <Button type="submit" size="sm" className="h-8" disabled={saveMutation.isPending}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8"
                onClick={() => {
                  setEditing(null);
                  setAddingKind(null);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : null}

          {isAdmin && !editing && !addingKind ? (
            <div className="flex gap-2 pt-1">
              {EDITABLE_CONTACT_KINDS.map(({ kind, label }) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => {
                    setAddingKind(kind);
                    setValue("");
                    setIsPrimary(!points.some((point) => point.kind === kind));
                  }}
                >
                  <PlusIcon size={12} /> Add {label.toLowerCase()}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatTaskStatus(status: string): string {
  return TASK_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status.replace(/_/g, " ");
}

function formatTaskCount(status: TaskStatus, count: number): string {
  return `${count} ${formatTaskStatus(status).toLowerCase()}`;
}

function formatTasksSummaryLine(tasks: EntityTask[]): string {
  if (tasks.length === 0) return "No tasks";
  const counts = new Map<TaskStatus, number>(TASK_STATUS_OPTIONS.map((option) => [option.value, 0]));
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const editableCount = tasks.filter((task) => task.canEditStatus).length;
  const parts = [
    `${tasks.length} total`,
    ...TASK_STATUS_OPTIONS.flatMap((option) => {
      const count = counts.get(option.value) ?? 0;
      return count > 0 ? [formatTaskCount(option.value, count)] : [];
    }),
  ];
  parts.push(editableCount > 0 ? `${editableCount} editable` : "monitoring only");
  return parts.join(" · ");
}

function taskStatusTone(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "border-amber-500/40 text-amber-600 dark:border-amber-500/30 dark:text-amber-400";
    case "done":
      return "border-emerald-500/40 text-emerald-600 dark:border-emerald-500/30 dark:text-emerald-400";
    case "dropped":
      return "text-muted-foreground line-through";
    default:
      return "text-muted-foreground";
  }
}

function taskPriorityTone(priority: string): string {
  switch (priority) {
    case "high":
      return "border-amber-500/40 text-amber-600 dark:border-amber-500/30 dark:text-amber-400";
    case "medium":
      return "border-sky-500/40 text-sky-600 dark:border-sky-500/30 dark:text-sky-400";
    case "low":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wider", taskPriorityTone(priority))}>
      {formatTitleCase(priority)}
    </Badge>
  );
}

function TaskStatusPill({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="outline" className={cn("max-w-full truncate text-[10px] sm:max-w-40", taskStatusTone(status))}>
      {formatTaskStatus(status)}
    </Badge>
  );
}

function MetaSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

function formatTitleCase(value: string): string {
  return value
    .replace(/[_-]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatProviderName(source: string): string {
  if (source === "clickup") return "ClickUp";
  if (source === "linear") return "Linear";
  return formatTitleCase(source);
}

function formatTaskSource(task: EntityTask): string {
  if (task.provenance === "summary") return "From Summarizer";
  if (task.provenance === "brief") return "From Daily Brief";
  if (task.externalRef) return `${formatProviderName(task.source)} ${task.externalRef}`;
  return formatProviderName(task.source);
}

function taskAssigneeMeta(
  task: EntityTask,
): { kind: "assigned"; label: string } | { kind: "proposed"; label: string } | null {
  if (task.assigneeName) return { kind: "assigned", label: `Assigned to ${task.assigneeName}` };
  if (task.assigneeEntityId) return { kind: "assigned", label: "Assigned" };
  if (task.proposedAssigneeName) return { kind: "proposed", label: `Mentioned: ${task.proposedAssigneeName}` };
  return null;
}

function taskCreatorLabel(task: EntityTask): string | null {
  if (task.isOwnedByViewer) return "Created by you";
  if (task.createdByUserName) return `Created by ${task.createdByUserName}`;
  if (task.createdByUserEmail) return `Created by ${task.createdByUserEmail}`;
  if (task.createdByUserId) return "Created by another user";
  return null;
}

function externalStatusValue(task: EntityTask): string | null {
  if (task.statusRaw && task.statusAuthority === "external") return task.statusRaw;
  return null;
}

interface TasksPanelProps {
  entityId: string;
  tasksQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.entities.tasks>>>>;
}

/**
 * TasksPanel — the project-only Tasks tab body. Renders a compact,
 * hairline-divided list of project tasks with inline status controls for
 * editable (local/owned) tasks and a passive status pill for read-only /
 * external-authority tasks. No big read-only instruction block — the source
 * line and external status already carry that context.
 */
function TasksPanel({ entityId, tasksQuery }: TasksPanelProps) {
  const queryClient = useQueryClient();
  const updateMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      api.entities.updateTaskStatus(entityId, taskId, status),
    onSuccess: ({ task }) => {
      queryClient.setQueryData<{ tasks: EntityTask[] }>(tasksKey(entityId), (current) => ({
        tasks: (current?.tasks ?? []).map((item) => (item.id === task.id ? task : item)),
      }));
      toast.success("Task status updated");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (tasksQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (tasksQuery.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
        <p className="text-xs text-muted-foreground">Couldn’t load project tasks.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void tasksQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const tasks = tasksQuery.data?.tasks ?? [];
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-3">
        <p className="text-xs font-medium">No project tasks yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Summarizer action items will appear here when they are linked to this project.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        {formatTasksSummaryLine(tasks)}
      </p>
      <div>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            disabled={updateMutation.isPending}
            onStatusChange={(status) => updateMutation.mutate({ taskId: task.id, status })}
          />
        ))}
      </div>
    </div>
  );
}

interface TaskRowProps {
  task: EntityTask;
  disabled: boolean;
  onStatusChange: (status: TaskStatus) => void;
}

function TaskRow({ task, disabled, onStatusChange }: TaskRowProps) {
  const assignee = taskAssigneeMeta(task);
  const creator = taskCreatorLabel(task);
  const externalStatus = externalStatusValue(task);
  return (
    <fieldset
      aria-label={`${task.title} task`}
      className="grid min-w-0 grid-cols-1 gap-1.5 border-0 border-b p-0 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-start sm:gap-3"
    >
      <div className="min-w-0">
        <div className="break-words text-sm font-medium leading-snug">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
          <span className="font-mono uppercase tracking-wider">{formatTaskSource(task)}</span>
          {task.priority ? (
            <>
              <MetaSeparator />
              <PriorityBadge priority={task.priority} />
            </>
          ) : null}
          {assignee ? (
            <>
              <MetaSeparator />
              <span>{assignee.label}</span>
            </>
          ) : null}
          {creator ? (
            <>
              <MetaSeparator />
              <span>{creator}</span>
            </>
          ) : null}
          {externalStatus ? (
            <>
              <MetaSeparator />
              <span>{externalStatus}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-start">
        {task.canEditStatus ? (
          <Select
            value={task.status}
            onValueChange={(value) => onStatusChange(value as TaskStatus)}
            disabled={disabled}
          >
            <SelectTrigger aria-label={`${task.title} status`} className="h-8 w-full text-xs sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <TaskStatusPill status={task.status} />
        )}
      </div>
    </fieldset>
  );
}

/**
 * Summary block — deterministic prose built server-side from relationships +
 * activity aggregates. No LLM, no shimmer. Two short paragraphs: identity
 * (type / role / employer / engagements) and activity (file count, mention
 * count, distinct days active, most-frequent collaborators).
 */
function SummaryBlock({ entity, accent }: { entity: EntityDetail; accent: string }) {
  const { identity, activity } = entity.profile.summary;
  const crmBrief = entity.profile.crmActivityBrief;
  const hasContent = identity.length > 0 || activity.length > 0 || Boolean(crmBrief);
  return (
    <SectionCard accent={accent} label="Summary">
      {hasContent ? (
        <div className="space-y-2 text-sm leading-snug">
          {identity ? <p>{identity}</p> : null}
          {activity ? <p className="text-muted-foreground">{activity}</p> : null}
          {crmBrief ? (
            <div className="border-t pt-2">
              <SectionLabel className="mb-1">CRM Activity</SectionLabel>
              <p>{crmBrief.summary}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {crmBrief.activityCount} {crmBrief.activityCount === 1 ? "activity" : "activities"} · updated{" "}
                {formatShortDate(crmBrief.updatedAt)}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No summary yet.</p>
      )}
    </SectionCard>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface DrawerTabsProps {
  entityId: string;
  sourceType: string;
  relations: EntityRelationsResponse | undefined;
  relationsLoading: boolean;
}

function tasksKey(entityId: string): unknown[] {
  return ["entity-drawer", "tasks", entityId];
}

function DrawerTabs({ entityId, sourceType, relations, relationsLoading }: DrawerTabsProps) {
  const isProject = sourceType === "project";
  const [tab, setTab] = useState<"timeline" | "relationships" | "tasks" | "scope">("timeline");
  const timelineQuery = useQuery({
    queryKey: ["entity-drawer", "timeline", entityId],
    queryFn: () => api.entities.timeline(entityId),
  });
  const tasksQuery = useQuery({
    queryKey: tasksKey(entityId),
    queryFn: () => api.entities.tasks(entityId),
    enabled: isProject,
  });

  const timelineCount = timelineQuery.data?.totalCount ?? 0;
  const timelineHint = timelineQuery.data?.truncated
    ? `${timelineCount}+`
    : timelineCount > 0
      ? `${timelineCount}`
      : null;
  const relationsCount = relations?.totalCount ?? 0;
  const relationsHint = relations?.truncated ? `${relationsCount}+` : relationsCount > 0 ? `${relationsCount}` : null;
  const tasksCount = tasksQuery.data?.tasks.length ?? 0;
  const tasksHint = tasksCount > 0 ? `${tasksCount}` : null;

  return (
    <div className="mt-5">
      <div className="mb-3 inline-flex rounded-lg border-[0.5px] border-border bg-card p-0.5 dark:bg-[#111110]">
        <TabButton
          active={tab === "timeline"}
          onClick={() => setTab("timeline")}
          label="Timeline"
          hint={timelineHint}
        />
        <TabButton
          active={tab === "relationships"}
          onClick={() => setTab("relationships")}
          label="Relationships"
          hint={relationsHint}
        />
        {isProject ? (
          <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} label="Tasks" hint={tasksHint} />
        ) : null}
        {isProject ? (
          <TabButton active={tab === "scope"} onClick={() => setTab("scope")} label="Scope" hint={null} />
        ) : null}
      </div>
      {tab === "scope" && isProject ? (
        <ScopePanel entityId={entityId} />
      ) : tab === "tasks" && isProject ? (
        <TasksPanel entityId={entityId} tasksQuery={tasksQuery} />
      ) : tab === "timeline" ? (
        <TimelinePanel timelineQuery={timelineQuery} />
      ) : (
        <RelationshipsPanel relations={relations} isLoading={relationsLoading} entityId={entityId} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1 text-xs transition-colors",
        active
          ? "bg-accent font-medium text-foreground dark:bg-[#1C1C1A]"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {hint ? <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

interface TimelinePanelProps {
  timelineQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof api.entities.timeline>>>>;
}

function TimelinePanel({ timelineQuery }: TimelinePanelProps) {
  if (timelineQuery.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  const groups = timelineQuery.data?.groups ?? [];
  if (groups.length === 0) {
    return <p className="text-xs text-muted-foreground">No file mentions yet.</p>;
  }
  return <TimelineStrip groups={groups} />;
}

interface RelationshipsPanelProps {
  relations: EntityRelationsResponse | undefined;
  isLoading: boolean;
  entityId: string;
}

function RelationshipsPanel({ relations, isLoading, entityId }: RelationshipsPanelProps) {
  if (isLoading) {
    return <Skeleton className="h-20 w-full" />;
  }
  if (!relations || (relations.outgoing.length === 0 && relations.incoming.length === 0)) {
    return <p className="text-xs text-muted-foreground">No relationships yet.</p>;
  }

  // AMBIGUOUS pinned across both directions
  const all: Array<EntityRelationView & { direction: "outgoing" | "incoming" }> = [
    ...relations.outgoing.map((r) => ({ ...r, direction: "outgoing" as const })),
    ...relations.incoming.map((r) => ({ ...r, direction: "incoming" as const })),
  ];
  const ambiguous = all.filter((r) => r.confidence === "AMBIGUOUS");
  const rest = all.filter((r) => r.confidence !== "AMBIGUOUS");

  return (
    <>
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
    </>
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
        <ConfidenceChip confidence={relation.confidence} score={relation.confidenceScore} />
        <span className="ml-auto text-[10px] text-muted-foreground">
          {relation.evidenceCount} {relation.evidenceCount === 1 ? "file" : "files"}
        </span>
      </div>
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
