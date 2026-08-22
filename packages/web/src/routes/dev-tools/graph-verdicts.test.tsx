/**
 * The approval surface must never let a human apply blind: Apply stays locked
 * until the server's dry run succeeds, a stale proposal renders as a banner
 * instead of a success state, and decisions go through the resource-noun
 * endpoints the backend CAS-guards.
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { GraphVerdicts } from "./graph-verdicts";

function verdictFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "gv-1",
    runId: "run-1",
    action: "merge_into",
    subjectEntityId: "ent-falcon",
    subjectName: "Project Falcon",
    subjectEntityType: "project",
    targetEntityId: "ent-dash",
    resolvedTargetEntityId: "ent-dash",
    targetName: "Falcon Dashboard",
    reason: "Same initiative discussed across both names",
    evidence: { fileIds: ["f-1", "f-2"], reviewIds: [], notes: ["Both names in the same standup"] },
    evidenceFingerprint: "abc123",
    validationStatus: "ok",
    validationReason: null,
    wouldChange: { entities: 2, entity_merges: 1 },
    status: "awaiting_human",
    supersededAt: null,
    decidedAt: null,
    decidedByUserId: null,
    appliedLedgerRef: null,
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

const runFixture = {
  id: "run-1234abcd",
  source: "curation_mcp",
  proposedByUserId: "user-1",
  tokenId: null,
  note: "weekly cleanup",
  verdictsProposed: 3,
  verdictsStored: 2,
  verdictsBounced: 1,
  createdAt: "2026-08-22T10:00:00.000Z",
  rollups: { awaiting_human: 1, bounced: 1, approved: 0, rejected: 0, applied: 1, reverted: 0 },
};

describe("graph verdicts panel", () => {
  it("lists runs with rollups and lazily fetches verdicts on expand", async () => {
    let verdictFetches = 0;
    server.use(
      http.get("/api/graph-verdicts/runs", () => HttpResponse.json({ runs: [runFixture] })),
      http.get("/api/graph-verdicts/runs/run-1234abcd/verdicts", () => {
        verdictFetches += 1;
        return HttpResponse.json({
          verdicts: [
            verdictFixture(),
            verdictFixture({
              id: "gv-2",
              action: "archive",
              subjectName: "Old Sales Sync",
              targetEntityId: null,
              targetName: null,
              status: "applied",
              appliedLedgerRef: "archived-at:2026-08-22T10:05:00.000Z",
            }),
          ],
        });
      }),
    );

    renderWithProviders(<GraphVerdicts />);

    await screen.findByText(/weekly cleanup/);
    expect(screen.getByText(/1 awaiting · 1 applied · 1 bounced/)).toBeInTheDocument();
    expect(verdictFetches).toBe(0);

    await userEvent.click(screen.getByTestId("graph-verdict-run-row"));
    await screen.findByText(/Project Falcon → Falcon Dashboard/);
    expect(screen.getByText("Old Sales Sync")).toBeInTheDocument();
    expect(verdictFetches).toBe(1);
  });

  it("walks a verdict from approval to preview-gated apply", async () => {
    const decisions: string[] = [];
    let status = "awaiting_human";
    server.use(
      http.get("/api/graph-verdicts/runs", () => HttpResponse.json({ runs: [runFixture] })),
      http.get("/api/graph-verdicts/runs/run-1234abcd/verdicts", () =>
        HttpResponse.json({ verdicts: [verdictFixture({ status })] }),
      ),
      http.post("/api/graph-verdicts/gv-1/approval", () => {
        decisions.push("approval");
        status = "approved";
        return HttpResponse.json({ verdict: verdictFixture({ status }) });
      }),
      http.post("/api/graph-verdicts/gv-1/application", async ({ request }) => {
        const body = (await request.json()) as { dryRun?: boolean };
        decisions.push(body.dryRun ? "dry-run" : "apply");
        if (body.dryRun) {
          return HttpResponse.json({
            application: {
              verdictId: "gv-1",
              dryRun: true,
              status,
              ledgerRef: null,
              wouldChange: { entities: 2, entity_merges: 1 },
              plan: null,
            },
          });
        }
        status = "applied";
        return HttpResponse.json({
          application: {
            verdictId: "gv-1",
            dryRun: false,
            status: "applied",
            ledgerRef: "merge-group:graph-verdict:gv-1",
            wouldChange: { entities: 2, entity_merges: 1 },
            plan: null,
          },
        });
      }),
    );

    renderWithProviders(<GraphVerdicts />);
    await userEvent.click(await screen.findByTestId("graph-verdict-run-row"));
    await userEvent.click(await screen.findByTestId("graph-verdict-row"));

    expect(screen.queryByTestId("graph-verdict-apply")).toBeNull();
    await userEvent.click(await screen.findByTestId("graph-verdict-approve"));
    await waitFor(() => expect(decisions).toContain("approval"));

    await userEvent.click(await screen.findByTestId("graph-verdict-row"));
    const applyButton = await screen.findByTestId("graph-verdict-apply");
    await waitFor(() => expect(decisions).toContain("dry-run"));
    await screen.findByText("entity_merges");
    await waitFor(() => expect(applyButton).toBeEnabled());

    await userEvent.click(applyButton);
    await waitFor(() => expect(decisions).toContain("apply"));
  });

  it("renders a stale banner when the dry run 409s instead of a success state", async () => {
    server.use(
      http.get("/api/graph-verdicts/runs", () => HttpResponse.json({ runs: [runFixture] })),
      http.get("/api/graph-verdicts/runs/run-1234abcd/verdicts", () =>
        HttpResponse.json({ verdicts: [verdictFixture({ status: "approved" })] }),
      ),
      http.post("/api/graph-verdicts/gv-1/application", () =>
        HttpResponse.json(
          { error: { code: "STALE_VERDICT", message: "Evidence changed since proposal", details: null } },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<GraphVerdicts />);
    await userEvent.click(await screen.findByTestId("graph-verdict-run-row"));
    await userEvent.click(await screen.findByTestId("graph-verdict-row"));

    await screen.findByTestId("graph-verdict-stale");
    expect(screen.queryByText("entity_merges")).toBeNull();
    expect(screen.getByTestId("graph-verdict-apply")).toBeDisabled();
  });
});
