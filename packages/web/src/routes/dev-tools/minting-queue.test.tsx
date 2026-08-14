import type { ProjectMintingVerdict } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { MintingQueue } from "./minting-queue";

function verdict(overrides: Partial<ProjectMintingVerdict> = {}): ProjectMintingVerdict {
  return {
    id: "verdict-1",
    companyEntityId: "company-1",
    companyName: "Oliver Wyman",
    fileCount: 47,
    counterpartyKind: "client",
    clientStage: "active",
    declaredCounterpartyKind: null,
    declaredClientStage: null,
    flags: [],
    voteStats: null,
    verdict: {
      counterpartyKind: "client",
      clientStage: "active",
      engagement: { name: "Oliver Wyman" },
      projects: [
        {
          name: "OW risk platform",
          status: "active",
          confidence: "high",
          evidenceTitleFamilies: ["Risk platform sync"],
          evidenceRepos: [],
          evidencePeople: [],
        },
      ],
      existingEntities: [],
      trackerFit: "no_containers",
      notes: [],
    },
    dossier: "# Oliver Wyman\n\nfiles…",
    promptVersion: "project-minting-verdict-v2",
    schemaV2: false,
    status: "pending",
    supersededAt: null,
    decidedAt: null,
    struckProjects: [],
    createdAt: "2026-08-13T09:00:00.000Z",
    updatedAt: "2026-08-13T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * The sheet now previews via a server dry run (POST acceptance with
 * dryRun: true), so every scenario needs an acceptance handler; `onDryRun`
 * shapes what the preview shows, and `onAccept` observes only real accepts.
 */
function serve(
  row: ProjectMintingVerdict,
  opts: {
    onAccept?: (body: Record<string, unknown>) => void;
    dryRunAcceptance?: (body: Record<string, unknown>) => Record<string, unknown> | Response;
  } = {},
) {
  server.use(
    http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: [row] })),
    http.get("/api/project-minting/verdicts/:id", () => HttpResponse.json({ verdict: row })),
    http.post("/api/project-minting/verdicts/:id/acceptance", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.dryRun === true) {
        const acceptance = opts.dryRunAcceptance?.(body) ?? emptyAcceptance(row.id);
        if (acceptance instanceof HttpResponse) return acceptance;
        return HttpResponse.json({ acceptance });
      }
      opts.onAccept?.(body);
      return HttpResponse.json({ acceptance: { verdictId: row.id } });
    }),
  );
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

describe("project minting review", () => {
  beforeEach(() => {
    server.use(http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: [] })));
  });

  it("states the disagreement between the nomination and the registry on each row", async () => {
    serve(verdict({ declaredCounterpartyKind: "client", declaredClientStage: "dormant" }));
    renderWithProviders(<MintingQueue />);

    const row = await screen.findByTestId("minting-row-verdict-1");
    expect(row).toHaveTextContent("client · active");
    expect(row).toHaveTextContent("client · dormant");
  });

  /**
   * The failure the accept gate was rewritten to prevent, one layer up: the
   * picker starts on the nomination, so a UI that posted the nomination rather
   * than the reviewer's pick would look correct until someone disagreed.
   */
  it("accepts with the axes the reviewer picked, not the ones the model nominated", async () => {
    let accepted: Record<string, unknown> | null = null;
    serve(verdict(), {
      onAccept: (body) => {
        accepted = body;
      },
    });
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));
    await userEvent.click(await screen.findByRole("button", { name: "vendor" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept as vendor" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Accept as vendor" }));

    await waitFor(() => expect(accepted).not.toBeNull());
    expect(accepted).toEqual({ confirmedCounterpartyKind: "vendor" });
  });

  /**
   * Correcting down to prospect discards the account container. The panel has
   * to say so — that consequence is the reason this surface exists.
   */
  it("shows the container being dropped when the stage is corrected down to prospect", async () => {
    const row = verdict();
    serve(row, {
      dryRunAcceptance: (body) =>
        body.confirmedClientStage === "active"
          ? {
              ...emptyAcceptance(row.id),
              entities: [
                { id: "", name: "Oliver Wyman", kind: "engagement", parentId: null, fileIds: [] },
                { id: "", name: "OW risk platform", kind: "project", parentId: null, fileIds: ["f1", "f2"] },
              ],
              residualTarget: "Oliver Wyman",
            }
          : {
              ...emptyAcceptance(row.id),
              entities: [{ id: "", name: "OW risk platform", kind: "project", parentId: null, fileIds: ["f1"] }],
              droppedByGate: { engagement: "Oliver Wyman", projects: [], unmergedFragments: [] },
              residualTarget: "OW risk platform",
            },
    });
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));
    expect(await screen.findByText(/Create “Oliver Wyman” as the account container/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "prospect" }));

    expect(await screen.findByText(/“Oliver Wyman” will not be created/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept as client · prospect" })).toBeEnabled();
  });

  /**
   * A partial accept succeeds, so the sheet closes and takes its own state with
   * it. Without this the reviewer gets no signal at all that the evidence was
   * thinner than the verdict claimed — it looks like a clean accept.
   */
  it("reports anchors that matched nothing after a partial accept", async () => {
    const row = verdict();
    server.use(
      http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: [row] })),
      http.get("/api/project-minting/verdicts/:id", () => HttpResponse.json({ verdict: row })),
      http.post("/api/project-minting/verdicts/:id/acceptance", () =>
        HttpResponse.json({
          acceptance: {
            verdictId: row.id,
            unresolvedAnchors: ['title family "Mobile App Redesign" on project "Mobile App Redesign"'],
          },
        }),
      ),
    );
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));
    const acceptButton = await screen.findByRole("button", { name: "Accept as client · active" });
    await waitFor(() => expect(acceptButton).toBeEnabled());
    await userEvent.click(acceptButton);

    expect(await screen.findByText(/1 anchor matched nothing/)).toBeInTheDocument();
    expect(screen.getByText('title family "Mobile App Redesign" on project "Mobile App Redesign"')).toBeInTheDocument();
  });

  it("shows the server's refusal and disables accept when the dry run is rejected", async () => {
    const row = verdict();
    serve(
      { ...row, verdict: { ...row.verdict, engagement: null } },
      {
        dryRunAcceptance: () =>
          HttpResponse.json(
            {
              error: {
                code: "INVALID_ACCEPTANCE_SHAPE",
                message: "An active client needs an account container, and this verdict proposes none.",
              },
            },
            { status: 422 },
          ),
      },
    );
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));

    expect(await screen.findByText(/An active client needs an account container/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept as client · active" })).toBeDisabled();
  });

  it("renders v2 verdicts as a tree, children indented under their parents", async () => {
    const row = verdict({
      promptVersion: "project-minting-verdict-v3",
      schemaV2: true,
      verdict: {
        counterpartyKind: "client",
        clientStage: "active",
        engagement: null,
        projects: [
          {
            name: "Habuild Sketch deployment",
            status: "active",
            confidence: "high",
            parentName: "Habuild",
            evidenceTitleFamilies: [],
            evidenceRepos: [],
            evidencePeople: [],
            evidenceFragments: ["frag-1"],
          },
          {
            name: "Habuild",
            status: "active",
            confidence: "high",
            parentName: null,
            evidenceTitleFamilies: ["Habuild standup"],
            evidenceRepos: [],
            evidencePeople: [],
          },
        ],
        existingEntities: [],
        trackerFit: "no_containers",
        notes: [],
      },
    });
    serve(row, {
      dryRunAcceptance: () => ({
        ...emptyAcceptance(row.id),
        entities: [
          { id: "", name: "Habuild", kind: "project", parentId: null, fileIds: ["f1"] },
          { id: "", name: "Habuild Sketch deployment", kind: "project", parentId: null, fileIds: ["f2"] },
        ],
        residualTarget: "Habuild",
      }),
    });
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));

    const parentRow = (await screen.findByText("Habuild", { selector: "label span span" })).closest("div[style]");
    const childRow = screen.getByText("Habuild Sketch deployment").closest("div[style]");
    expect(parentRow).toHaveStyle({ paddingLeft: "12px" });
    expect(childRow).toHaveStyle({ paddingLeft: "32px" });
    expect(await screen.findByText(/Create “Habuild Sketch deployment” under “Habuild”/)).toBeInTheDocument();
    expect(screen.getByText(/1 fragments/)).toBeInTheDocument();
  });
});
