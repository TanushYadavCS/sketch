/**
 * Agents — the prebuilt agent catalog (experimental). `/agents` lists the catalog
 * (roster); `/agents/$agentKey` reads output history and tunes one agent.
 */
import { AgentDetail } from "@/components/agents/agent-detail";
import { AgentRoster } from "@/components/agents/agent-roster";
import { createRoute, useParams } from "@tanstack/react-router";
import { dashboardRoute } from "../dashboard";

export const agentsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/agents",
  component: AgentRoster,
});

export const agentDetailRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/agents/$agentKey",
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { agentKey } = useParams({ from: agentDetailRoute.id });
  return <AgentDetail agentKey={agentKey} />;
}
