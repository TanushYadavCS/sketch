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
import { type EntityBinding, api } from "@/lib/api";
import { ApiRequestError } from "@/lib/api";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Input } from "@sketch/ui/components/input";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

function bindingsKey(entityId: string): unknown[] {
  return ["entity-drawer", "bindings", entityId];
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bindingsKey(entityId) }),
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

function AddBindingForm({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState("");
  const [containerKind, setContainerKind] = useState("");
  const [containerId, setContainerId] = useState("");
  const [label, setLabel] = useState("");

  const addMutation = useMutation({
    mutationFn: () =>
      api.entities.addBinding(entityId, {
        source: source.trim(),
        containerKind: containerKind.trim(),
        containerId: containerId.trim(),
        label: label.trim() || null,
      }),
    onSuccess: () => {
      setSource("");
      setContainerKind("");
      setContainerId("");
      setLabel("");
      queryClient.invalidateQueries({ queryKey: bindingsKey(entityId) });
    },
  });

  const canSubmit = source.trim() && containerKind.trim() && containerId.trim() && !addMutation.isPending;

  return (
    <form
      className="rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) addMutation.mutate();
      }}
    >
      <SectionLabel>Add data source</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <Input
          aria-label="Source connector"
          placeholder="Connector (e.g. clickup)"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="h-8 text-xs"
        />
        <Input
          aria-label="Container kind"
          placeholder="Kind (e.g. clickup_space)"
          value={containerKind}
          onChange={(e) => setContainerKind(e.target.value)}
          className="h-8 text-xs"
        />
        <Input
          aria-label="Container id"
          placeholder="Container id"
          value={containerId}
          onChange={(e) => setContainerId(e.target.value)}
          className="h-8 text-xs"
        />
        <Input
          aria-label="Label"
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-8 text-xs"
        />
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bindingsKey(parentId) }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: bindingsKey(entityId) }),
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
