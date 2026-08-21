/**
 * Container-classification UI on the hierarchy mapping panel. Three failure modes:
 * the section leaking when the connector flag is off, the accept-all save not
 * writing the v2 {levels, containers} shape in one PATCH, and running
 * classification not surfacing the returned proposals.
 */
import type { ContainerClassificationProposal, HierarchyLevel } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { HierarchyMappingPanel } from "./hierarchy-mapping-panel";

const LEVELS: HierarchyLevel[] = [
  { key: "space", label: "Space", allowedTargets: ["team", "project", "ignore"], default: "team" },
  { key: "list", label: "List", allowedTargets: ["project", "sprint", "ignore"], default: "project" },
];

function proposal(overrides: Partial<ContainerClassificationProposal>): ContainerClassificationProposal {
  return {
    containerId: "list-1",
    containerName: "Sprint 12",
    level: "list",
    proposedTarget: "cycle",
    confidence: "high",
    reasoning: "Dated name and short-lived tasks",
    digestHash: "hash-1",
    status: "proposed",
    ...overrides,
  };
}

describe("HierarchyMappingPanel container classification", () => {
  it("shows no container section when classification is not enabled for the connector", () => {
    renderWithProviders(<HierarchyMappingPanel connectorId="conn-1" levels={LEVELS} scopeConfig={{}} />);

    expect(screen.getByText("Hierarchy")).toBeInTheDocument();
    expect(screen.queryByText("Containers")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /classify/i })).not.toBeInTheDocument();
  });

  it("renders proposals grouped by level and saves all container targets in one v2 PATCH", async () => {
    const proposals = [
      proposal({}),
      proposal({
        containerId: "list-2",
        containerName: "Bug intake",
        proposedTarget: "register",
        confidence: "medium",
        reasoning: "Rolling defect reports",
      }),
    ];
    const patched: { scope: Record<string, unknown> | null } = { scope: null };
    server.use(
      http.get("/api/connectors/conn-1/container-classification", () => HttpResponse.json({ proposals })),
      http.patch("/api/connectors/conn-1/scope", async ({ request }) => {
        const body = (await request.json()) as { scopeConfig: Record<string, unknown> };
        patched.scope = body.scopeConfig;
        return HttpResponse.json({
          connector: { id: "conn-1", connectorType: "clickup", scopeConfig: body.scopeConfig, syncStatus: "syncing" },
        });
      }),
    );

    renderWithProviders(
      <HierarchyMappingPanel
        connectorId="conn-1"
        levels={LEVELS}
        scopeConfig={{ hierarchyMapping: { space: "team", list: "project" } }}
        containerClassificationEnabled
      />,
    );

    expect(await screen.findByText("Sprint 12")).toBeInTheDocument();
    expect(screen.getByText("Bug intake")).toBeInTheDocument();
    expect(screen.getByText(/high confidence — Dated name/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save & re-sync" }));

    await waitFor(() => expect(patched.scope).not.toBeNull());
    expect(patched.scope?.hierarchyMapping).toEqual({
      levels: { space: "team", list: "project" },
      containers: { "list-1": "cycle", "list-2": "register" },
    });
  });

  it("runs classification on demand and surfaces the returned proposals", async () => {
    server.use(
      http.get("/api/connectors/conn-1/container-classification", () => HttpResponse.json({ proposals: [] })),
      http.post("/api/connectors/conn-1/container-classification", () =>
        HttpResponse.json({
          run: { status: "completed", digestHash: "hash-2" },
          proposals: [proposal({ containerName: "Team backlog", proposedTarget: "project" })],
        }),
      ),
    );

    renderWithProviders(
      <HierarchyMappingPanel connectorId="conn-1" levels={LEVELS} scopeConfig={{}} containerClassificationEnabled />,
    );

    expect(await screen.findByText(/No container proposals yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Classify containers" }));

    expect(await screen.findByText("Team backlog")).toBeInTheDocument();
    expect(screen.queryByText(/No container proposals yet/)).not.toBeInTheDocument();
  });
});
