/**
 * Your Org — the single home for the entity graph. Five type tabs (People,
 * Companies, Teams, Projects, Products) plus a divider-separated Graph tab:
 * the full knowledge graph as its own lens, not a per-tab view toggle.
 * (A List/Graph toggle was tried and rejected — switching type tabs while in
 * graph view read as incoherent, and the graph endpoint's hotness/component
 * filtering breaks the toggle's same-content promise.)
 *
 * There is no Review tab: each type tab's "Needs your review" band expands in
 * place to the full type-scoped candidate list, so triage keeps its type
 * context. Legacy `?tab=review` links fall back to People.
 *
 * Entity rows open the shared {@link EntityDrawer} via `openEntity`. The drawer
 * stays read-only in this run — the teach layer (contact-point CRUD, company
 * placement, internal/external) lands in run 2.
 */
import { AddEntityDialog } from "@/components/entity-review/add-entity-dialog";
import { QuietAddButton } from "@/components/quiet-add-button";
import { api } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { EntityTable } from "@/routes/files/entity-explorer";
import { type CoarseType, KnowledgeGraphView, NODE_COLOR } from "@/routes/files/knowledge-graph";
import { TabButton } from "@sketch/ui/components/tab-button";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useQuery } from "@tanstack/react-query";
import { createRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute, useDashboardAuth } from "../dashboard";
import { OrgEntityTab, ProductsTab, TeamsEmpty } from "./entity-tab";
import { PeopleTab } from "./people-tab";
import { ProjectsTree } from "./projects-tree";

export type OrgTab = "people" | "companies" | "teams" | "projects" | "products" | "graph";

const ORG_TABS: OrgTab[] = ["people", "companies", "teams", "projects", "products", "graph"];

const TAB_TYPE: Record<Exclude<OrgTab, "graph">, CoarseType> = {
  people: "person",
  companies: "company",
  teams: "team",
  projects: "project",
  products: "product",
};

export function validateOrgTabSearch(search: Record<string, unknown>): { tab: OrgTab } {
  return {
    tab: typeof search.tab === "string" && ORG_TABS.includes(search.tab as OrgTab) ? (search.tab as OrgTab) : "people",
  };
}

export const projectsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/projects",
  validateSearch: validateOrgTabSearch,
  component: RoutedProjectsPage,
});

function RoutedProjectsPage() {
  const { tab } = useSearch({ from: projectsRoute.id });
  const navigate = useNavigate();
  const auth = useDashboardAuth();
  return (
    <ProjectsPage
      activeTab={tab}
      role={auth.role}
      onActiveTabChange={(nextTab) => {
        void navigate({ to: "/projects", search: { tab: nextTab }, replace: true });
      }}
    />
  );
}

function useEntityCount(type: string) {
  const { data } = useQuery({
    queryKey: ["entities", "count", type],
    queryFn: () => api.entities.list({ type, limit: 1 }),
    refetchInterval: 60000,
  });
  return data?.total ?? null;
}

export function ProjectsPage({
  activeTab,
  onActiveTabChange,
  role,
}: {
  activeTab?: OrgTab;
  onActiveTabChange?: (tab: OrgTab) => void;
  role?: "admin" | "member";
} = {}) {
  const isAdmin = role === "admin";
  const { openEntity } = useEntityUi();
  const [localTab, setLocalTab] = useState<OrgTab>("people");
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState("person");
  const tab = activeTab ?? localTab;
  const setTab = onActiveTabChange ?? setLocalTab;

  const peopleCount = useEntityCount("person");
  const companiesCount = useEntityCount("company");
  const teamsCount = useEntityCount("team");
  const projectsCount = useEntityCount("project");
  const productsCount = useEntityCount("product");
  const teamReviewQuery = useQuery({
    queryKey: ["entity-review", "count", "team"],
    queryFn: () => api.entityReview.list({ limit: 0, types: ["team"] }),
    refetchInterval: 30000,
  });

  const openAdd = (type: string) => {
    setAddType(type);
    setAddOpen(true);
  };

  const tabs: { key: Exclude<OrgTab, "graph">; label: string; count: number | null }[] = [
    { key: "people", label: "People", count: peopleCount },
    { key: "companies", label: "Companies", count: companiesCount },
    { key: "teams", label: "Teams", count: teamsCount },
    { key: "projects", label: "Projects", count: projectsCount },
    { key: "products", label: "Products", count: productsCount },
  ];

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium text-foreground">Your Org</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Everyone and everything the graph tracks — confirm what the system proposes, and declare what it should
            already know.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <QuietAddButton onClick={() => openAdd(tab === "graph" ? "person" : TAB_TYPE[tab])}>Add</QuietAddButton>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border">
        {tabs.map((t) => (
          <TabButton
            key={t.key}
            label={t.count !== null ? `${t.label} · ${t.count}` : t.label}
            isActive={tab === t.key}
            onClick={() => setTab(t.key)}
            dot={tab === "graph" ? NODE_COLOR[TAB_TYPE[t.key]] : undefined}
          />
        ))}
        <div aria-hidden className="h-4 w-px self-center bg-border" />
        <TabButton label="⬡ Graph" isActive={tab === "graph"} onClick={() => setTab("graph")} />
      </div>

      <TabContentContainer className="mt-5">
        {tab === "graph" ? (
          <KnowledgeGraphView />
        ) : tab === "people" ? (
          <PeopleTab />
        ) : tab === "companies" ? (
          <OrgEntityTab type="company" typeLabel="Companies" isAdmin={isAdmin} />
        ) : tab === "teams" ? (
          <OrgEntityTab
            type="team"
            typeLabel="Teams"
            isAdmin={isAdmin}
            renderEmpty={(_search, expandReview) => (
              <TeamsEmpty pendingCount={teamReviewQuery.data?.total ?? 0} onExpandReview={expandReview} />
            )}
          />
        ) : tab === "projects" ? (
          <OrgEntityTab
            type="project"
            typeLabel="Projects"
            isAdmin={isAdmin}
            renderList={(entities, search) =>
              search ? (
                <EntityTable entities={entities} onSelect={openEntity} />
              ) : (
                <ProjectsTree entities={entities} onSelect={openEntity} isAdmin={isAdmin} />
              )
            }
          />
        ) : (
          <ProductsTab onDeclare={() => openAdd("product")} />
        )}
      </TabContentContainer>

      <AddEntityDialog key={addType} open={addOpen} onOpenChange={setAddOpen} defaultType={addType} />
    </div>
  );
}
