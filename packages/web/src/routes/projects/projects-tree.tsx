/**
 * ProjectsTree — the Your Org → Projects tab rendered as a part_of tree,
 * grouped into client sections plus Internal.
 *
 * A section comes from the ROOT ancestor's engagement_for company: acceptance
 * writes engagement_for only on top-level projects (nested children get
 * part_of instead), so a child inherits its root's section. Admins drag a row
 * onto another project to nest it, or onto the section's "top level" strip to
 * un-nest; the server re-anchors an un-nested child's section company. The
 * strip only accepts rows from its own section — a cross-section top-level
 * move would need an engagement_for write the PATCH doesn't do.
 *
 * Rows whose parent is off-page (the list caps at 200) render top-level.
 */
import { type EntityListItem, api } from "@/lib/api";
import { EntityRow } from "@/routes/files/entity-explorer";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { SectionLabel } from "./entity-tab";

const INTERNAL_KEY = "__internal__";

type Section = { key: string; label: string; roots: EntityListItem[] };
type FlatRow = { entity: EntityListItem; depth: number; hasChildren: boolean };

function buildIndex(entities: EntityListItem[]) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const childrenByParent = new Map<string, EntityListItem[]>();
  const roots: EntityListItem[] = [];
  for (const entity of entities) {
    const parentId = entity.parentEntityId ?? null;
    if (parentId !== null && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(entity);
      childrenByParent.set(parentId, siblings);
    } else {
      roots.push(entity);
    }
  }
  return { byId, childrenByParent, roots };
}

function buildSections(roots: EntityListItem[]): Section[] {
  const byKey = new Map<string, Section>();
  for (const root of roots) {
    const key = root.companyEntityId ?? INTERNAL_KEY;
    const section = byKey.get(key) ?? {
      key,
      label: root.companyEntityId ? (root.companyName ?? "Unknown client") : "Internal",
      roots: [],
    };
    section.roots.push(root);
    byKey.set(key, section);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.key === INTERNAL_KEY) return 1;
    if (b.key === INTERNAL_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

export function ProjectsTree({
  entities,
  onSelect,
  isAdmin,
}: {
  entities: EntityListItem[];
  onSelect: (id: string) => void;
  isAdmin: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { byId, childrenByParent, roots } = buildIndex(entities);
  const sections = buildSections(roots);

  const reparent = useMutation({
    mutationFn: ({ id, parentEntityId }: { id: string; parentEntityId: string | null }) =>
      api.entities.update(id, { parentEntityId }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["entities"] }),
  });

  const descendantsOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const frontier = [id];
    while (frontier.length > 0) {
      const current = frontier.pop();
      if (current === undefined) break;
      for (const child of childrenByParent.get(current) ?? []) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          frontier.push(child.id);
        }
      }
    }
    return seen;
  };

  const rootOf = (id: string): EntityListItem => {
    let current = byId.get(id);
    let hops = 0;
    while (current && hops < 32) {
      const parentId = current.parentEntityId ?? null;
      const parent = parentId !== null ? byId.get(parentId) : undefined;
      if (!parent) return current;
      current = parent;
      hops += 1;
    }
    return current ?? (byId.get(id) as EntityListItem);
  };

  const sectionKeyOf = (id: string): string => rootOf(id).companyEntityId ?? INTERNAL_KEY;

  const isValidDropTarget = (targetId: string): boolean => {
    if (!draggedId || targetId === draggedId) return false;
    return !descendantsOf(draggedId).has(targetId);
  };

  const dropOnProject = (targetId: string) => {
    if (!draggedId || !isValidDropTarget(targetId)) return;
    if (byId.get(draggedId)?.parentEntityId !== targetId) {
      reparent.mutate({ id: draggedId, parentEntityId: targetId });
    }
    setDraggedId(null);
    setDropTargetId(null);
  };

  const dropOnTopLevel = (sectionKey: string) => {
    if (!draggedId) return;
    if (sectionKeyOf(draggedId) === sectionKey && byId.get(draggedId)?.parentEntityId != null) {
      reparent.mutate({ id: draggedId, parentEntityId: null });
    }
    setDraggedId(null);
    setDropTargetId(null);
  };

  const flatten = (items: EntityListItem[], depth: number, out: FlatRow[]) => {
    for (const entity of items) {
      const children = childrenByParent.get(entity.id) ?? [];
      out.push({ entity, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && !collapsed.has(entity.id)) {
        flatten(children, depth + 1, out);
      }
    }
  };

  return (
    <div className="space-y-5">
      {sections.map((section) => {
        const rows: FlatRow[] = [];
        flatten(section.roots, 0, rows);
        const showTopLevelStrip =
          draggedId !== null && sectionKeyOf(draggedId) === section.key && byId.get(draggedId)?.parentEntityId != null;
        return (
          <section key={section.key}>
            <SectionLabel
              label={section.label}
              note={`${rows.length} ${rows.length === 1 ? "project" : "projects"}`}
              accent={section.key !== INTERNAL_KEY}
            />
            <div
              className="overflow-hidden rounded-lg border border-border"
              data-testid={`tree-section-${section.key}`}
            >
              {showTopLevelStrip ? (
                <div
                  data-testid={`tree-drop-top-level-${section.key}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dropOnTopLevel(section.key)}
                  className="border-b border-dashed border-border px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
                >
                  drop here for top level
                </div>
              ) : null}
              {rows.map(({ entity, depth, hasChildren }) => (
                <EntityRow
                  key={entity.id}
                  entity={entity}
                  onSelect={onSelect}
                  depth={depth}
                  highlighted={dropTargetId === entity.id}
                  dimmed={draggedId === entity.id}
                  leading={
                    <span className="flex shrink-0 items-center gap-1 pl-3">
                      {isAdmin ? (
                        <span aria-hidden className="cursor-grab select-none text-[13px] text-muted-foreground/70">
                          ⠿
                        </span>
                      ) : null}
                      {hasChildren ? (
                        <button
                          type="button"
                          aria-label={collapsed.has(entity.id) ? `expand ${entity.name}` : `collapse ${entity.name}`}
                          onClick={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(entity.id)) next.delete(entity.id);
                              else next.add(entity.id);
                              return next;
                            })
                          }
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {collapsed.has(entity.id) ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
                        </button>
                      ) : (
                        <span aria-hidden className="w-3" />
                      )}
                    </span>
                  }
                  containerProps={{
                    draggable: isAdmin,
                    onDragStart: (e) => {
                      setDraggedId(entity.id);
                      e.dataTransfer?.setData("text/plain", entity.id);
                    },
                    onDragEnd: () => {
                      setDraggedId(null);
                      setDropTargetId(null);
                    },
                    onDragOver: (e) => {
                      if (!isValidDropTarget(entity.id)) return;
                      e.preventDefault();
                      setDropTargetId(entity.id);
                    },
                    onDragLeave: () => setDropTargetId((current) => (current === entity.id ? null : current)),
                    onDrop: () => dropOnProject(entity.id),
                  }}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
