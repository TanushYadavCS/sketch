/**
 * The weekly panel is now the only mint trigger in dev-tools: the Run button
 * must hit the shared POST /runs latch (not the retired v1 /passes route), a
 * run must expand into its per-company decision feed, and the v1 clusters
 * runner must be gone — two triggers meant two ways to spend model money.
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { MintingQueue } from "./minting-queue";

describe("weekly pass panel", () => {
  it("runs the weekly pass, expands a run into its event feed, and has no v1 cluster runner", async () => {
    const posted: string[] = [];
    server.use(
      http.get("/api/project-minting/runs", () =>
        HttpResponse.json({
          runs: [
            {
              id: "wr-1",
              runKey: "weekly-mint:2026-08-17",
              status: "completed",
              stage: "completed",
              clockWeek: "2026-08-17",
              candidatesGrouped: 12,
              verdictsRequested: 2,
              verdictsStored: 1,
              agedOut: 0,
              heartbeatAt: null,
              startedAt: "2026-08-17T00:00:00.000Z",
              completedAt: "2026-08-17T00:05:00.000Z",
              error: null,
              eventCount: 3,
            },
          ],
        }),
      ),
      http.post("/api/project-minting/runs", ({ request }) => {
        posted.push(request.url);
        return HttpResponse.json({ run: { status: "started" } }, { status: 202 });
      }),
      http.get("/api/project-minting/runs/wr-1/events", () =>
        HttpResponse.json({
          events: [
            {
              id: "ev-1",
              containerKey: "company-1",
              companyEntityId: "company-1",
              companyName: "Oliver Wyman",
              kind: "claimed",
              detail: { claimed: 4 },
              createdAt: "2026-08-17T00:01:00.000Z",
            },
            {
              id: "ev-2",
              containerKey: "company-1",
              companyEntityId: "company-1",
              companyName: "Oliver Wyman",
              kind: "judged",
              detail: { groups: 2, stored: 1, aliases: 0, skipped: 1 },
              createdAt: "2026-08-17T00:02:00.000Z",
            },
            {
              id: "ev-3",
              containerKey: "company-2",
              companyEntityId: "company-2",
              companyName: "Acme Vendor",
              kind: "vendor_skip",
              detail: null,
              createdAt: "2026-08-17T00:03:00.000Z",
            },
          ],
        }),
      ),
    );

    renderWithProviders(<MintingQueue />);

    await screen.findByText("weekly-mint:2026-08-17");
    expect(screen.queryByText(/Run a pass/)).toBeNull();

    await userEvent.click(screen.getByTestId("weekly-pass-run"));
    await waitFor(() => expect(posted).toHaveLength(1));

    await userEvent.click(screen.getByTestId("weekly-run-row"));
    await screen.findByText("Oliver Wyman");
    expect(screen.getByText("claimed → judged")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "view trace" })).toBeInTheDocument();
    expect(screen.getByText("Acme Vendor")).toBeInTheDocument();
  });
});
