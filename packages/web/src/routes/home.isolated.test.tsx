import type { WorkspaceSummary } from "@/lib/api";
import { api } from "@/lib/api";
import { router } from "@/router";
import { describe, expect, it, vi } from "vitest";
import { buildSummaryTiles, buildWebChatRecents, chatTargetFromPrompt } from "./home";
import { indexRoute } from "./index";

vi.mock("@/lib/api", () => ({
  api: {
    setup: {
      status: vi.fn(),
    },
  },
}));

describe("Home route", () => {
  it("registers Home as a dashboard route and removes standalone Sketch routes", () => {
    const routesByPath = router.routesByPath as Record<string, unknown>;

    expect(routesByPath["/home"]).toBeDefined();
    expect(routesByPath["/chat"]).toBeDefined();
    expect(routesByPath["/chat/$conversationId"]).toBeDefined();
    expect(routesByPath["/home/setup"]).toBeUndefined();
    expect(routesByPath["/chat/automation-sidecar"]).toBeUndefined();
    expect(routesByPath["/scheduled-tasks/builder-sidecar"]).toBeUndefined();
    expect(routesByPath["/conversations"]).toBeUndefined();
  });

  it("sends authenticated users to Home from the root route", async () => {
    vi.mocked(api.setup.status).mockResolvedValue({
      completed: true,
      currentStep: 5,
      adminEmail: "admin@example.com",
      orgName: "Acme",
      botName: "Sketch",
      slackConnected: true,
      llmConnected: true,
      llmProvider: "anthropic",
    });

    await expect(indexRoute.options.beforeLoad?.({} as never)).rejects.toMatchObject({
      options: { to: "/home" },
    });
  });
});

describe("buildSummaryTiles", () => {
  it("maps live workspace summary data to Home workspace tiles", () => {
    const nextRunAt = "2026-05-26T08:00:00.000Z";
    const formattedNextRun = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(nextRunAt));
    const summary: WorkspaceSummary = {
      automations: {
        total: 5,
        active: 3,
        paused: 1,
        completed: 1,
        running: 2,
        nextRunAt,
      },
      skills: {
        total: 12,
        yours: 4,
        shared: 8,
      },
      integrations: {
        connected: 8,
        appNames: ["Gmail", "Slack", "Linear", "Notion"],
      },
      team: {
        total: 7,
        humans: 6,
        agents: 1,
      },
    };

    const tiles = buildSummaryTiles(summary);

    expect(tiles[0]).toMatchObject({
      title: "Automations",
      primary: "2 running",
      secondary: `5 total · next ${formattedNextRun}`,
    });
    expect(tiles[1]).toMatchObject({
      title: "Skills",
      primary: "12 in library",
      secondary: "4 yours · 8 shared",
    });
    expect(tiles[2]).toMatchObject({
      title: "Integrations",
      primary: "8 connected",
      secondary: "Gmail, Slack, Linear +1",
    });
    expect(tiles[3]).toMatchObject({
      title: "Team",
      primary: "7 members",
      secondary: "6 people · 1 agent",
    });
  });
});

describe("buildWebChatRecents", () => {
  it("maps persisted web chat conversation summaries to design-style recent conversations", () => {
    expect(
      buildWebChatRecents([
        {
          id: "chat-alpha",
          title: "Create a PDF for my skills",
          channel: "web",
          updatedAt: "2026-05-26T06:30:00.000Z",
        },
      ]),
    ).toEqual([
      {
        id: "chat-alpha",
        title: "Create a PDF for my skills",
        channel: "web",
        occurredAt: "2026-05-26T06:30:00.000Z",
      },
    ]);
  });

  it("caps Home recents to the five most recent conversations", () => {
    expect(
      buildWebChatRecents([
        {
          id: "chat-1",
          title: "First",
          channel: "web",
          updatedAt: "2026-05-26T06:30:00.000Z",
        },
        {
          id: "chat-2",
          title: "Second",
          channel: "web",
          updatedAt: "2026-05-26T06:29:00.000Z",
        },
        {
          id: "chat-3",
          title: "Third",
          channel: "web",
          updatedAt: "2026-05-26T06:28:00.000Z",
        },
        {
          id: "chat-4",
          title: "Fourth",
          channel: "web",
          updatedAt: "2026-05-26T06:27:00.000Z",
        },
        {
          id: "chat-5",
          title: "Fifth",
          channel: "web",
          updatedAt: "2026-05-26T06:26:00.000Z",
        },
        {
          id: "chat-6",
          title: "Sixth",
          channel: "web",
          updatedAt: "2026-05-26T06:25:00.000Z",
        },
      ]).map((recent) => recent.id),
    ).toEqual(["chat-1", "chat-2", "chat-3", "chat-4", "chat-5"]);
  });

  it("keeps Recents empty when there are no conversations", () => {
    expect(buildWebChatRecents([])).toEqual([]);
  });
});

describe("chatTargetFromPrompt", () => {
  it("creates a unique chat route target for a new Home prompt", () => {
    const target = chatTargetFromPrompt("  Hi Sketch  ", () => "chat-alpha");

    expect(target).toEqual({
      to: "/chat/$conversationId",
      params: { conversationId: "chat-alpha" },
      search: { message: "Hi Sketch" },
    });
  });
});
