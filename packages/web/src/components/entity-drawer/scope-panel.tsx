import { EntityPicker } from "@/components/entity-picker";
/**
 * ScopePanel — the data-scope surface for a project entity.
 *
 * Shows a project's effective connector bindings (the containers feeding it),
 * resolved up the part_of spine: its own origin + direct bindings plus the
 * bindings inherited from grouped sub-projects, each badged by provenance.
 * Admins can attach/detach data sources and group/ungroup sub-projects; the
 * underlying routes are admin-only, so non-admins see a read-only view.
 */
import { type BindableContainer, type EntityBinding, type EntityMember, api } from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

function bindingsKey(entityId: string): unknown[] {
  return ["entity-drawer", "bindings", entityId];
}

function membersKey(entityId: string): unknown[] {
  return ["entity-drawer", "members", entityId];
}

function invalidateScopeQueries(queryClient: ReturnType<typeof useQueryClient>, entityId: string): void {
  queryClient.invalidateQueries({ queryKey: bindingsKey(entityId) });
  queryClient.invalidateQueries({ queryKey: membersKey(entityId) });
  queryClient.invalidateQueries({ queryKey: ["projects"] });
}

function bindableContainersKey(): unknown[] {
  return ["projects", "bindable-containers"];
}

function containerValue(c: BindableContainer): string {
  return `${c.source}:${c.containerId}`;
}

const CONTAINER_KIND_LABEL: Record<string, string> = {
  linear_project: "Linear project",
  clickup_space: "ClickUp space",
  clickup_folder: "ClickUp folder",
};

function containerKindLabel(kind: string): string {
  return CONTAINER_KIND_LABEL[kind] ?? kind;
}

export function ScopePanel({ entityId }: { entityId: string }) {
  const sessionQuery = useQuery({
    queryKey: ["auth-session"],
    queryFn: () => api.auth.session(),
    staleTime: 60_000,
  });
  const isAdmin = sessionQuery.data?.role === "admin";

  const bindingsQuery = useQuery({
    queryKey: bindingsKey(entityId),
    queryFn: () => api.entities.listBindings(entityId, true),
  });

  if (bindingsQuery.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }

  const bindings = bindingsQuery.data?.bindings ?? [];
  const direct = bindings.filter((b) => b.viaProjectId === entityId);
  const inherited = bindings.filter((b) => b.viaProjectId !== entityId);
  const children = bindingsQuery.data?.children ?? [];

  return (
    <div className="space-y-5">
      <section>
        <SectionLabel>Data sources</SectionLabel>
        {bindings.length === 0 ? (
          <p className="text-xs text-muted-foreground">No connector containers bound to this project yet.</p>
        ) : (
          <div className="flex flex-col">
            {direct.map((b) => (
              <BindingRow key={b.id} binding={b} entityId={entityId} isAdmin={isAdmin} />
            ))}
            {inherited.map((b) => (
              <BindingRow key={b.id} binding={b} entityId={entityId} isAdmin={isAdmin} />
            ))}
          </div>
        )}
      </section>

      {isAdmin ? <AddBindingForm entityId={entityId} /> : null}

      <section>
        <SectionLabel>Sub-projects</SectionLabel>
        {children.length === 0 ? (
          <p className="mb-2 text-xs text-muted-foreground">No projects grouped under this one.</p>
        ) : (
          <div className="mb-2 flex flex-col">
            {children.map((child) => (
              <ChildProjectRow key={child.id} parentId={entityId} child={child} isAdmin={isAdmin} />
            ))}
          </div>
        )}
        {isAdmin ? <GroupChildControl entityId={entityId} /> : null}
      </section>

      <MembersSection entityId={entityId} isAdmin={isAdmin} />
    </div>
  );
}

function MembersSection({ entityId, isAdmin }: { entityId: string; isAdmin: boolean }) {
  const membersQuery = useQuery({
    queryKey: membersKey(entityId),
    queryFn: () => api.entities.listMembers(entityId),
  });

  return (
    <section>
      <SectionLabel>Members</SectionLabel>
      {membersQuery.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !membersQuery.data || membersQuery.data.members.length === 0 ? (
        <p className="text-xs text-muted-foreground">No items in this project's bound containers yet.</p>
      ) : (
        <>
          <div className="flex flex-col">
            {membersQuery.data.members.map((m) => (
              <MemberRow key={m.indexedFileId} member={m} entityId={entityId} isAdmin={isAdmin} />
            ))}
          </div>
          {membersQuery.data.truncated ? (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Showing the first {membersQuery.data.members.length} items.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function memberProvenanceBadge(member: EntityMember, entityId: string) {
  if (member.manual) {
    return (
      <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">
        Manual
      </Badge>
    );
  }
  if (member.viaProjectId && member.viaProjectId !== entityId) {
    return (
      <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
        Inherited
      </Badge>
    );
  }
  return null;
}

function MemberRow({
  member,
  entityId,
  isAdmin,
}: {
  member: EntityMember;
  entityId: string;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const excludeMutation = useMutation({
    mutationFn: () => api.entities.setMembership(entityId, member.indexedFileId, "exclude"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membersKey(entityId) }),
  });

  return (
    <div className="flex items-center gap-2 border-b py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{member.fileName}</span>
          {memberProvenanceBadge(member, entityId)}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {member.source}
          {member.fileType ? ` · ${member.fileType}` : null}
        </div>
      </div>
      {isAdmin ? (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Exclude ${member.fileName}`}
          disabled={excludeMutation.isPending}
          onClick={() => excludeMutation.mutate()}
        >
          <XIcon size={12} />
        </Button>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{children}</div>;
}

function provenanceBadge(binding: EntityBinding, entityId: string) {
  if (binding.origin) {
    return (
      <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">
        Origin
      </Badge>
    );
  }
  if (binding.viaProjectId && binding.viaProjectId !== entityId) {
    return (
      <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
        Inherited
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[9px] uppercase tracking-wider">
      Direct
    </Badge>
  );
}

function BindingRow({
  binding,
  entityId,
  isAdmin,
}: {
  binding: EntityBinding;
  entityId: string;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const removable = isAdmin && !binding.origin && binding.viaProjectId === entityId;
  const removeMutation = useMutation({
    mutationFn: () => api.entities.removeBinding(entityId, binding.id),
    onSuccess: () => invalidateScopeQueries(queryClient, entityId),
  });

  return (
    <div className="flex items-center gap-2 border-b py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{binding.label ?? binding.containerId}</span>
          {provenanceBadge(binding, entityId)}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {binding.source} · {binding.containerKind}
        </div>
      </div>
      {removable ? (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${binding.label ?? binding.containerId}`}
          disabled={removeMutation.isPending}
          onClick={() => removeMutation.mutate()}
        >
          <XIcon size={12} />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Wire a project to the connectors that feed it. The Tracking board picker lists
 * the structural containers the graph already knows (Linear projects, ClickUp
 * spaces/folders) that aren't bound yet, so an admin attaches one without
 * hand-typing connector ids. Repo and Folders are placeholders for the
 * cofounders' GitHub / local-workdir tracks — shown disabled so the shape of the
 * surface is visible.
 */
function AddBindingForm({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");

  const containersQuery = useQuery({
    queryKey: bindableContainersKey(),
    queryFn: () => api.projects.bindableContainers(),
  });
  const containers = containersQuery.data?.containers ?? [];
  const chosen = containers.find((c) => containerValue(c) === selected) ?? null;

  const addMutation = useMutation({
    mutationFn: (container: BindableContainer) =>
      api.entities.addBinding(entityId, {
        source: container.source,
        containerKind: container.containerKind,
        containerId: container.containerId,
        label: container.label,
      }),
    onSuccess: () => {
      setSelected("");
      invalidateScopeQueries(queryClient, entityId);
      queryClient.invalidateQueries({ queryKey: bindableContainersKey() });
    },
  });

  const canSubmit = Boolean(chosen) && !addMutation.isPending;

  return (
    <form
      className="rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen && !addMutation.isPending) addMutation.mutate(chosen);
      }}
    >
      <SectionLabel>Add data source</SectionLabel>
      <div className="space-y-2">
        <WireField label="Tracking board">
          <Select value={selected} onValueChange={setSelected} disabled={containers.length === 0}>
            <SelectTrigger aria-label="Tracking board" className="h-8 text-xs">
              <SelectValue
                placeholder={containers.length === 0 ? "No connector boards detected yet" : "Choose a board…"}
              />
            </SelectTrigger>
            <SelectContent>
              {containers.map((c) => (
                <SelectItem key={containerValue(c)} value={containerValue(c)} className="text-xs">
                  {c.label}
                  <span className="ml-1.5 text-muted-foreground">· {containerKindLabel(c.containerKind)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WireField>
        <WireField label="Repo" comingSoon>
          <div className="flex h-8 items-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground">
            GitHub repository
          </div>
        </WireField>
        <WireField label="Folders" comingSoon>
          <div className="flex h-8 items-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground">
            Local folders
          </div>
        </WireField>
      </div>
      {addMutation.isError ? (
        <p className="mt-2 text-[11px] text-destructive">{errorMessage(addMutation.error)}</p>
      ) : null}
      <div className="mt-2 flex justify-end">
        <Button type="submit" size="sm" className="h-7 gap-1 text-[11px]" disabled={!canSubmit}>
          <PlusIcon size={12} />
          Add
        </Button>
      </div>
    </form>
  );
}

function WireField({
  label,
  comingSoon,
  children,
}: {
  label: string;
  comingSoon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
        {comingSoon ? (
          <Badge variant="outline" className="text-[8px] uppercase tracking-wider text-muted-foreground/70">
            Soon
          </Badge>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ChildProjectRow({
  parentId,
  child,
  isAdmin,
}: {
  parentId: string;
  child: { id: string; name: string };
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const ungroupMutation = useMutation({
    mutationFn: () => api.entities.ungroupProject(parentId, child.id),
    onSuccess: () => invalidateScopeQueries(queryClient, parentId),
  });

  return (
    <div className="flex items-center gap-2 border-b py-2 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{child.name}</span>
      {isAdmin ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
          disabled={ungroupMutation.isPending}
          onClick={() => ungroupMutation.mutate()}
        >
          Ungroup
        </Button>
      ) : null}
    </div>
  );
}

function GroupChildControl({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const groupMutation = useMutation({
    mutationFn: (childId: string) => api.entities.groupProject(entityId, childId),
    onSuccess: () => invalidateScopeQueries(queryClient, entityId),
  });

  return (
    <div>
      <EntityPicker
        entityType="project"
        excludeEntityId={entityId}
        placeholder="Group a sub-project…"
        onPick={(childId) => groupMutation.mutate(childId)}
      />
      {groupMutation.isError ? (
        <p className="mt-1.5 text-[11px] text-destructive">{errorMessage(groupMutation.error)}</p>
      ) : null}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === "ALREADY_GROUPED") return "That project is already grouped under another project.";
    if (err.code === "WOULD_CYCLE") return "That grouping would create a cycle.";
    if (err.code === "NOT_A_PROJECT") return "Bindings can only be attached to projects.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
