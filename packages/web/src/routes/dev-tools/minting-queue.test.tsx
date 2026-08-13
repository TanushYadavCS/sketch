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
    status: "pending",
    supersededAt: null,
    decidedAt: null,
    struckProjects: [],
    createdAt: "2026-08-13T09:00:00.000Z",
    updatedAt: "2026-08-13T09:00:00.000Z",
    ...overrides,
  };
}

function serve(row: ProjectMintingVerdict, onAccept?: (body: Record<string, unknown>) => void) {
  server.use(
    http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: [row] })),
    http.get("/api/project-minting/verdicts/:id", () => HttpResponse.json({ verdict: row })),
    http.post("/api/project-minting/verdicts/:id/acceptance", async ({ request }) => {
      onAccept?.((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ acceptance: { verdictId: row.id } });
    }),
  );
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
    serve(verdict(), (body) => {
      accepted = body;
    });
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));
    await userEvent.click(await screen.findByRole("button", { name: "vendor" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept as vendor" }));

    await waitFor(() => expect(accepted).not.toBeNull());
    expect(accepted).toEqual({ confirmedCounterpartyKind: "vendor" });
  });

  /**
   * Correcting down to prospect discards the account container. The panel has
   * to say so — that consequence is the reason this surface exists.
   */
  it("shows the container being dropped when the stage is corrected down to prospect", async () => {
    serve(verdict());
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));
    expect(await screen.findByText(/Create “Oliver Wyman” as the account container/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "prospect" }));

    expect(await screen.findByText(/“Oliver Wyman” will not be created/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept as client · prospect" })).toBeEnabled();
  });

  it("refuses to offer accept when an active client has no container to mint", async () => {
    const row = verdict();
    serve({ ...row, verdict: { ...row.verdict, engagement: null } });
    renderWithProviders(<MintingQueue />);

    await userEvent.click(await screen.findByTestId("minting-row-verdict-1"));

    expect(await screen.findByText(/An active client needs an account container/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept as client · active" })).toBeDisabled();
  });
});
