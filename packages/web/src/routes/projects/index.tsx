/**
 * Your Org — the curation home for what the org is made of: the products,
 * projects, and teams the graph tracks, plus the review band where the LLM's
 * proposals get confirmed or merged before they join the curated set.
 *
 * Sections:
 * - **Review band** — pending product/project/team rows, split into confirm-new
 *   vs possible-duplicates. The org-taxonomy spine only; person/company review
 *   stays in Files → Entities.
 * - **Products** — the declared closed list (declared + human_confirmed) that
 *   calibrates extraction. `+ Add` declares one.
 * - **Projects** — the lifecycle spine: needs-sources vs active.
 * - **Teams** — structural teams seeded from connectors.
 *
 * Rows open the shared {@link EntityDrawer}. The page is built edit-ready: each
 * type will grow user-editable per-type fields, and a user edit is a `declared`
 * assertion.
 */
import { AddEntityDialog } from "@/components/entity-review/add-entity-dialog";
import { ReviewBand } from "@/components/entity-review/review-band";
import { type CuratedProduct, type EntityListItem, type ProjectSummary, api } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { CaretRightIcon, CubeIcon, FolderSimpleIcon, PlusIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "../dashboard";

const SPINE_TYPES = ["product", "project", "team"];

export const projectsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/projects",
  component: ProjectsPage,
});

export function ProjectsPage() {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium text-foreground">Your org</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The products, projects, and teams the graph is made of — confirm what the system proposes, and declare what
            it should already know.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={() => setShowAdd(true)}>
          <PlusIcon size={12} />
          Add
        </Button>
      </div>

      <ReviewBand types={SPINE_TYPES} />
      <ProductsSection />
      <ProjectsSection />
      <TeamsSection />
      <AddEntityDialog open={showAdd} onOpenChange={setShowAdd} defaultType="product" />
    </div>
  );
}

function ProductsSection() {
  const { data, isLoading } = useQuery({ queryKey: ["products"], queryFn: () => api.products.list() });
  const products = data?.products ?? [];
  return (
    <section>
      <GroupLabel label="Products" note={`${products.length} declared`} accent />
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : products.length === 0 ? (
        <EmptyHint>No products yet — declare one with “Add”, or confirm a proposal above.</EmptyHint>
      ) : (
        <div className="flex flex-col gap-1">
          {products.map((p) => (
            <ProductRow key={p.id} product={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProductRow({ product }: { product: CuratedProduct }) {
  const ui = useEntityUi();
  const cold = product.hotness <= 0;
  return (
    <button
      type="button"
      onClick={() => ui.openEntity(product.id)}
      className="group flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted/40"
    >
      <CubeIcon size={16} aria-hidden className="shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-[14px] font-medium text-foreground">{product.name}</span>
          <TierBadge tier={product.provenance_tier} />
        </div>
        {cold ? (
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.05em] text-muted-foreground/60">
            not seen in any source yet
          </p>
        ) : null}
      </div>
      <CaretRightIcon
        size={14}
        aria-hidden
        className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
      />
    </button>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const label = tier === "human_confirmed" ? "confirmed" : tier;
  const tone =
    tier === "declared"
      ? "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
      : tier === "human_confirmed"
        ? "border-sky-300 text-sky-700 dark:border-sky-700 dark:text-sky-400"
        : "text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${tone}`}>
      {label}
    </Badge>
  );
}

function ProjectsSection() {
  const { data, isLoading } = useQuery({ queryKey: ["projects", "index"], queryFn: () => api.projects.list() });
  const projects = data?.projects ?? [];
  const needsSources = projects.filter((p) => p.sourceCount === 0);
  const active = projects.filter((p) => p.sourceCount > 0);
  if (!isLoading && projects.length === 0) {
    return (
      <section>
        <GroupLabel label="Projects" note="0 tracked" />
        <EmptyHint>
          No projects yet — they appear here as the graph derives them from your connectors, or when you define one.
        </EmptyHint>
      </section>
    );
  }
  return (
    <>
      {needsSources.length > 0 ? (
        <section>
          <GroupLabel label="Projects · needs sources" note={`${needsSources.length} born · not wired yet`} />
          <div className="flex flex-col gap-1">
            {needsSources.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </div>
        </section>
      ) : null}
      <section>
        <GroupLabel label="Projects · active" note={`${active.length} fed by the graph`} />
        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : active.length > 0 ? (
          <div className="flex flex-col gap-1">
            {active.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </div>
        ) : (
          <EmptyHint>Nothing fed yet — open a project to wire its data sources.</EmptyHint>
        )}
      </section>
    </>
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

function TeamsSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["entities", "team"],
    queryFn: () => api.entities.list({ type: "team", limit: 100 }),
  });
  const teams = data?.entities ?? [];
  if (!isLoading && teams.length === 0) return null;
  return (
    <section>
      <GroupLabel label="Teams" note={`${teams.length} structural`} />
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : (
        <div className="flex flex-col gap-1">
          {teams.map((team) => (
            <TeamRow key={team.id} team={team} />
          ))}
        </div>
      )}
    </section>
  );
}

function TeamRow({ team }: { team: EntityListItem }) {
  const ui = useEntityUi();
  return (
    <button
      type="button"
      onClick={() => ui.openEntity(team.id)}
      className="group flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted/40"
    >
      <UsersThreeIcon size={16} aria-hidden className="shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-[14px] font-medium text-foreground">{team.name}</span>
          <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-muted-foreground">
            structural
          </Badge>
        </div>
      </div>
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

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border py-8 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}
