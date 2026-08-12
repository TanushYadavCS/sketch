import { createRouter } from "@tanstack/react-router";
import { agentDetailRoute, agentsRoute, summariserConfigRoute } from "./routes/agents";
import { automationBuilderRoute } from "./routes/automation-builder";
import { channelsRoute } from "./routes/channels";
import { chatIndexRoute, chatRoute } from "./routes/chat";
import { connectionsCallbackRoute, connectionsRoute } from "./routes/connections";
import { dashboardRoute } from "./routes/dashboard";
import { devToolsRoute } from "./routes/dev-tools";
import { filesRoute } from "./routes/files";
import { homeRoute } from "./routes/home";
import { indexRoute } from "./routes/index";
import { loginRoute } from "./routes/login";
import { onboardingRoute } from "./routes/onboarding";
import { projectsRoute } from "./routes/projects";
import { reviewEntitiesRoute } from "./routes/review-entities";
import { rootRoute } from "./routes/root";
import { scheduledTasksRoute } from "./routes/scheduled-tasks";
import { settingsRoute } from "./routes/settings";
import { skillsRoute } from "./routes/skills";
import { teamRoute } from "./routes/team";
import { usageRoute } from "./routes/usage";

const routeTree = rootRoute.addChildren([
  loginRoute,
  onboardingRoute,
  indexRoute,
  dashboardRoute.addChildren([
    homeRoute,
    agentsRoute,
    agentDetailRoute,
    summariserConfigRoute,
    chatIndexRoute,
    chatRoute,
    channelsRoute,
    teamRoute,
    scheduledTasksRoute,
    automationBuilderRoute,
    skillsRoute,
    filesRoute,
    projectsRoute,
    reviewEntitiesRoute,
    connectionsRoute.addChildren([connectionsCallbackRoute]),
    usageRoute,
    settingsRoute,
    devToolsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
