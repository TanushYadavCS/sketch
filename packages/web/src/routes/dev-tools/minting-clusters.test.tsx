/**
 * Every one of these guards money. Stage 3 calls a reasoning model per cluster,
 * so the failures worth testing are the ones that cause a paid call nobody
 * asked for, or a paid call whose result is invisible.
 */
import type { ProjectMintingCluster } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { MintingClusters } from "./minting-clusters";

function cluster(overrides: Partial<ProjectMintingCluster> = {}): ProjectMintingCluster {
  return {
    companyEntityId: "company-1",
    companyName: "Oliver Wyman",
    fileCount: 47,
    triggered: true,
    shardNames: ["Oliver Wyman"],
    channels: ["ow-delivery"],
    signals: ["domain", "channel"],
    pendingVerdictId: null,
    ...overrides,
  };
}

function serveClusters(clusters: ProjectMintingCluster[]) {
  server.use(http.get("/api/project-minting/clusters", () => HttpResponse.json({ clusters, passesEnabled: true })));
}

function rowFor(name: string) {
  return screen.getByText(name).closest("div") as HTMLElement;
}

describe("project minting cluster runner", () => {
  /**
   * The pass is scoped to one company per click. A runner that posted an
   * unscoped request, or the wrong row's id, would spend a model call per
   * cluster on a single button press.
   */
  it("runs only the company whose row was clicked, and blocks a second click while it runs", async () => {
    const posted: unknown[] = [];
    serveClusters([cluster(), cluster({ companyEntityId: "company-2", companyName: "Praevorium" })]);
    server.use(
      http.post("/api/project-minting/passes", async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ run: { id: "run-1", status: "running", companyName: "Praevorium", model: "m" } });
      }),
      http.get("/api/project-minting/passes/:id", () =>
        HttpResponse.json({
          run: {
            id: "run-1",
            status: "running",
            startedAt: "2026-08-13T09:00:00.000Z",
            finishedAt: null,
            errorMessage: null,
            snapshot: { kind: "project_minting", companyName: "Praevorium" },
          },
        }),
      ),
    );

    renderWithProviders(<MintingClusters />);
    await screen.findByText("Praevorium");
    await userEvent.click(within(rowFor("Praevorium")).getByRole("button", { name: "Run" }));

    await waitFor(() => expect(posted).toEqual([{ companyEntityId: "company-2" }]));
    await waitFor(() => expect(within(rowFor("Oliver Wyman")).getByRole("button", { name: "Run" })).toBeDisabled());
  });

  /**
   * A cluster that already produced a verdict must not offer a second run —
   * the verdict is sitting in the queue below, unreviewed, and re-running it
   * pays for the same answer twice.
   */
  it("offers no run on a cluster that already has a verdict waiting", async () => {
    serveClusters([cluster({ pendingVerdictId: "verdict-1" })]);
    renderWithProviders(<MintingClusters />);

    await screen.findByText("Oliver Wyman");
    expect(within(rowFor("Oliver Wyman")).queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  /**
   * The pass runs in the background, so a failure has no other way to reach the
   * reviewer. Staying silent looks identical to a cluster the model found
   * nothing in.
   */
  it("surfaces the reason a pass failed rather than looking finished", async () => {
    serveClusters([cluster()]);
    server.use(
      http.post("/api/project-minting/passes", () =>
        HttpResponse.json({ run: { id: "run-1", status: "running", companyName: "Oliver Wyman", model: "m" } }),
      ),
      http.get("/api/project-minting/passes/:id", () =>
        HttpResponse.json({
          run: {
            id: "run-1",
            status: "failed",
            startedAt: "2026-08-13T09:00:00.000Z",
            finishedAt: "2026-08-13T09:01:00.000Z",
            errorMessage: "model returned invalid JSON",
            snapshot: { kind: "project_minting", companyName: "Oliver Wyman" },
          },
        }),
      ),
    );

    renderWithProviders(<MintingClusters />);
    await screen.findByText("Oliver Wyman");
    await userEvent.click(within(rowFor("Oliver Wyman")).getByRole("button", { name: "Run" }));

    expect(await screen.findByText(/model returned invalid JSON/)).toBeInTheDocument();
  });
});
