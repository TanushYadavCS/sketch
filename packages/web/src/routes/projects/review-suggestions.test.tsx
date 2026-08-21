/**
 * The two review-tab failure modes for project suggestions: a member seeing
 * (or fetching) an admin-only surface, and the accept payload not carrying
 * what the reviewer actually did — the strike cascade, the rename, and the
 * move all ride on that payload.
 */
import type { ProjectMintingVerdict } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ReviewTab } from "./review-tab";

function verdict(): ProjectMintingVerdict {
  return {
    id: "verdict-1",
    companyEntityId: "company-1",
    companyName: "Capmobfinance",
    fileCount: 31,
    counterpartyKind: "client",
    clientStage: "pilot",
    declaredCounterpartyKind: null,
    declaredClientStage: null,
    flags: [],
    voteStats: null,
    verdict: {
      counterpartyKind: "client",
      clientStage: "pilot",
      engagement: null,
      projects: [
        {
          name: "MiMo Automation",
          status: "active",
          confidence: "high",
          parentName: null,
          evidenceTitleFamilies: ["MiMo weekly sync"],
          evidenceRepos: [],
          evidencePeople: [],
        },
        {
          name: "Ops Reporting",
          status: "active",
          confidence: "medium",
          parentName: null,
          evidenceTitleFamilies: [],
          evidenceRepos: [],
          evidencePeople: [],
        },
        {
          name: "Ops Dashboard",
          status: "active",
          confidence: "medium",
          parentName: "Ops Reporting",
          evidenceTitleFamilies: [],
          evidenceRepos: [],
          evidencePeople: [],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: [],
    },
    promptVersion: "project-minting-verdict-weekly-v1",
    schemaV2: true,
    status: "pending",
    supersededAt: null,
    decidedAt: null,
    struckProjects: [],
    createdAt: "2026-08-14T09:00:00.000Z",
    updatedAt: "2026-08-14T09:00:00.000Z",
  };
}

function emptyAcceptance(verdictId: string): Record<string, unknown> {
  return {
    verdictId,
    entityIds: { engagementId: null, projectIds: [] },
    entities: [],
    mergeIds: [],
    struckProjects: [],
    droppedByGate: { engagement: null, projects: [], unmergedFragments: [] },
    unresolvedAnchors: [],
    residualTarget: null,
    taskParentUpdates: 0,
    dryRun: true,
  };
}

describe("review tab project suggestions", () => {
  it("shows the suggestions section to an admin and never fetches it for a member", async () => {
    let verdictCalls = 0;
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 0 })),
      http.get("/api/project-minting/verdicts", () => {
        verdictCalls += 1;
        return HttpResponse.json({ verdicts: [verdict()] });
      }),
    );

    const member = renderWithProviders(<ReviewTab />);
    await screen.findByPlaceholderText("Search the review queue…");
    expect(screen.queryByTestId("review-band-project-suggestions")).not.toBeInTheDocument();
    expect(verdictCalls).toBe(0);
    member.unmount();

    renderWithProviders(<ReviewTab isAdmin />);
    expect(await screen.findByTestId("review-band-project-suggestions")).toHaveTextContent("Capmobfinance");
    expect(verdictCalls).toBeGreaterThan(0);
  });

  it("accepts with the reviewer's strikes cascaded, the rename, and the move", async () => {
    let accepted: Record<string, unknown> | null = null;
    const row = verdict();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 0 })),
      http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: accepted ? [] : [row] })),
      http.get("/api/project-minting/verdicts/:id", () => HttpResponse.json({ verdict: row })),
      http.post("/api/project-minting/verdicts/:id/acceptance", async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.dryRun === true) return HttpResponse.json({ acceptance: emptyAcceptance(row.id) });
        accepted = body;
        return HttpResponse.json({ acceptance: { verdictId: row.id } });
      }),
    );

    renderWithProviders(<ReviewTab isAdmin />);
    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));

    const rename = await screen.findByLabelText("name for MiMo Automation");
    await userEvent.clear(rename);
    await userEvent.type(rename, "MiMo Finance Automation");

    fireEvent.dragStart(screen.getByTestId("minting-project-Ops Dashboard"));
    fireEvent.drop(screen.getByTestId("minting-project-MiMo Automation"));

    await userEvent.click(screen.getByLabelText("keep Ops Reporting"));
    const dashboardCheckbox = screen.getByLabelText("keep Ops Dashboard");
    expect(dashboardCheckbox).toBeChecked();

    const acceptButton = screen.getByRole("button", { name: "Accept as client · pilot" });
    await waitFor(() => expect(acceptButton).toBeEnabled());
    await userEvent.click(acceptButton);

    await waitFor(() => expect(accepted).not.toBeNull());
    expect(accepted).toEqual({
      confirmedCounterpartyKind: "client",
      confirmedClientStage: "pilot",
      struckProjectNames: ["Ops Reporting"],
      renameMap: { "MiMo Automation": "MiMo Finance Automation" },
      reparentMap: { "Ops Dashboard": "MiMo Automation" },
    });
    await waitFor(() => {
      const section = screen.queryByTestId("review-band-project-suggestions");
      if (section) expect(within(section).queryByTestId("minting-row-verdict-1")).not.toBeInTheDocument();
    });
  });

  it("opens the dry run's claimed files for a project", async () => {
    const row = verdict();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 0 })),
      http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: [row] })),
      http.get("/api/project-minting/verdicts/:id", () => HttpResponse.json({ verdict: row })),
      http.post("/api/project-minting/verdicts/:id/acceptance", () =>
        HttpResponse.json({
          acceptance: {
            ...emptyAcceptance(row.id),
            entities: [
              {
                id: "",
                name: "MiMo Automation",
                kind: "project",
                parentId: null,
                parentOriginalName: null,
                fileIds: ["file-1", "file-2"],
                files: [
                  { id: "file-1", name: "MiMo weekly sync", source: "fireflies", date: "2026-08-01T09:00:00Z" },
                  { id: "file-2", name: "MiMo rollout plan", source: "gmail", date: null },
                ],
              },
            ],
          },
        }),
      ),
    );

    renderWithProviders(<ReviewTab isAdmin />);
    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));
    await userEvent.click(await screen.findByLabelText("files for MiMo Automation"));

    const panel = await screen.findByTestId("minting-files-panel");
    expect(within(panel).getByText("MiMo weekly sync")).toBeInTheDocument();
    expect(within(panel).getByText("2026-08-01")).toBeInTheDocument();
    expect(within(panel).getByText("MiMo rollout plan")).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("minting-files-panel")).not.toBeInTheDocument();
  });
});
