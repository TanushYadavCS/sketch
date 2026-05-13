import { TabButton } from "@sketch/ui/components/tab-button";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "../dashboard";
import { PersonalView } from "./personal-view";
import type { AdminTab, TimePeriod } from "./shared";
import { TeamView } from "./team-view";

export const usageRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/usage",
  component: UsagePage,
});

function UsagePage() {
  const [activeTab, setActiveTab] = useState<AdminTab>("team");
  const [timePeriod, setTimePeriod] = useState<TimePeriod>("Month");

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-[22px] font-medium">Usage</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Monitor your workspace activity and team adoption.</p>
      </div>

      <div className="mt-6 flex items-center gap-6 border-b border-border">
        <TabButton label="Team" isActive={activeTab === "team"} onClick={() => setActiveTab("team")} />
        <TabButton label="My usage" isActive={activeTab === "my-usage"} onClick={() => setActiveTab("my-usage")} />
      </div>

      <TabContentContainer>
        {activeTab === "team" ? (
          <TeamView timePeriod={timePeriod} onTimePeriodChange={setTimePeriod} />
        ) : (
          <PersonalView timePeriod={timePeriod} onTimePeriodChange={setTimePeriod} />
        )}
      </TabContentContainer>
    </div>
  );
}
