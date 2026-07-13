import type { AgentDetailResponse } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AgentDetail } from "./agent-detail";
import { SummariserConfigPage } from "./summariser-config";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const detailResponse: AgentDetailResponse = {
  agent: {
    agentKey: "conversation_summary",
    title: "Summarizer",
    tagline: "Summarizes conversations",
    description: "Turns selected conversations into summaries and action items.",
    enabled: true,
    scheduleHour: 9,
    scheduleMinute: 0,
    timezone: "Asia/Kolkata",
    maxItemsPerSection: 5,
    itemsPerSectionRange: { min: 1, max: 10 },
    focus: null,
    delivery: null,
    sourceConfig: { maxSources: 3, supportsSlackChannels: true, supportsWhatsAppGroups: true },
    sources: [{ platform: "slack", targetType: "channel", targetId: "C123", label: "#sketch-testing" }],
    routes: [
      {
        id: "route-1",
        sources: ["slack:channel:C123"],
        focus: null,
        sections: null,
        maxItemsPerSection: null,
        schedule: null,
        destination: { kind: "self" },
        enabled: true,
        owner: { userId: "u1", name: "Tanush Yadav", email: "tanush@canvasx.ai", authRole: "admin" },
      },
    ],
    sections: [{ key: "action_items", title: "Action items", enabled: true }],
    createTasks: true,
  },
  output: null,
  running: false,
  outputDate: "2026-07-08",
  timezone: "Asia/Kolkata",
};

function useAgentHandlers() {
  server.use(
    http.get("/api/agents/conversation_summary", () => HttpResponse.json(detailResponse)),
    http.get("/api/agents/conversation_summary/outputs", () => HttpResponse.json({ outputs: [], nextCursor: null })),
  );
}

describe("Summarizer task creation copy", () => {
  it("uses product copy on the global Summarizer config row", async () => {
    const user = userEvent.setup();
    useAgentHandlers();

    renderWithProviders(<AgentDetail agentKey="conversation_summary" />);

    await user.click(await screen.findByRole("button", { name: "Config" }));

    expect(screen.getByText("Create project tasks from action items")).toBeInTheDocument();
    expect(
      screen.getByText("Tasks appear on linked projects. Task owners can update status; admins can monitor progress."),
    ).toBeInTheDocument();
  });

  it("uses the same product copy on the individual summarizer config row", async () => {
    useAgentHandlers();

    renderWithProviders(<SummariserConfigPage agentKey="conversation_summary" routeId="route-1" />);

    expect(await screen.findByText("Create project tasks from action items")).toBeInTheDocument();
    expect(
      screen.getByText("Tasks appear on linked projects. Task owners can update status; admins can monitor progress."),
    ).toBeInTheDocument();
  });
});
