/**
 * Projects — a first-class destination for the project entities the graph
 * tracks. The index lists every confirmed project and groups it on the one axis
 * that earns its place at a glance: **does it have data flowing in yet?**
 *
 * - **Needs sources** — born (derived from a connector container or defined by
 *   hand) but no data sources resolved up its spine. The wiring backlog.
 * - **Active** — at least one effective data source; the graph is feeding it.
 *
 * A row opens the shared {@link EntityDrawer} (its Scope tab is where data
 * sources, members, and sub-projects get wired, and the header carries Merge) —
 * the same side sheet every entity uses, so projects reuse all of it. Real data
 * via {@link api.projects.list}.
 */
import { type ProjectSummary, api } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { CaretRightIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";

export const projectsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/projects",
  component: ProjectsPage,
});

export function ProjectsPage() {
  const { data, isLoading } = useQuery({ queryKey: ["projects", "index"], queryFn: () => api.projects.list() });
  const projects = data?.projects ?? [];
  const needsSources = projects.filter((p) => p.sourceCount === 0);
  const active = projects.filter((p) => p.sourceCount > 0);

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div className="mb-7">
        <h1 className="text-xl font-semibold text-foreground">Projects</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Each project is a slice of the graph. Born from a connector or defined by you, then wired to the data sources
          that feed it.
        </p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : projects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-12 text-center text-[12.5px] text-muted-foreground">
          No projects yet — they appear here as the graph derives them from your connectors, or when you define one.
        </p>
      ) : (
        <>
          {needsSources.length > 0 ? (
            <section>
              <GroupLabel label="Needs sources" note={`${needsSources.length} born · not wired yet`} accent />
              <div className="flex flex-col gap-1">
                {needsSources.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <GroupLabel label="Active" note={`${active.length} fed by the graph`} />
            {active.length > 0 ? (
              <div className="flex flex-col gap-1">
                {active.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-border py-8 text-center text-[12.5px] text-muted-foreground">
                Nothing fed yet — open a project above to wire its data sources.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const ui = useEntityUi();
  const needsSources = project.sourceCount === 0;
  const facts = [
    project.sourceCount > 0
      ? `${project.sourceCount} ${project.sourceCount === 1 ? "source" : "sources"}`
      : "no sources",
    project.subProjectCount > 0
      ? `${project.subProjectCount} ${project.subProjectCount === 1 ? "sub-project" : "sub-projects"}`
      : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={() => ui.openEntity(project.id)}
      className="group flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted/40"
    >
      {needsSources ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand-accent" />
      ) : (
        <FolderSimpleIcon size={16} aria-hidden className="shrink-0 text-muted-foreground/60" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-[14px] font-medium text-foreground">{project.name}</span>
          <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
            {project.origin}
          </Badge>
        </div>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground/60">
          {facts.join("  ·  ")}
        </p>
      </div>
      {needsSources ? (
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground/60 group-hover:text-foreground">
          Wire up
        </span>
      ) : null}
      <CaretRightIcon
        size={14}
        aria-hidden
        className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
      />
    </button>
  );
}

function GroupLabel({ label, note, accent }: { label: string; note: string; accent?: boolean }) {
  return (
    <div className="mb-3 mt-9 flex items-baseline justify-between border-b border-border/60 pb-2 first:mt-0">
      <span
        className={[
          "font-mono text-[11px] uppercase tracking-[0.12em]",
          accent ? "text-[#8B7A00] dark:text-brand-accent" : "text-muted-foreground",
        ].join(" ")}
      >
        {label}
      </span>
      <span className="font-mono text-[10px] tracking-[0.04em] text-muted-foreground/70">{note}</span>
    </div>
  );
}
