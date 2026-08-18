/**
 * The Projects review band's action policy — the part that keeps file-evidence
 * project births out of one-click reach: Link only when a single suggested
 * entity exists, no inline dismiss (terminal — it starves sub-project
 * minting), candidate-less rows pooling as a summary instead of actionable
 * rows. Person rows must keep the standard confirm + dismiss so the policy
 * stays scoped to projects.
 */
import type { EntityReviewQueueRow } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ReviewBandCapped } from "./org-review";

function queueRow(
  overrides: Partial<EntityReviewQueueRow> & Pick<EntityReviewQueueRow, "id" | "proposed_name" | "entity_type">,
): EntityReviewQueueRow {
  return {
    normalized_name: overrides.proposed_name.toLowerCase(),
    proposed_email: null,
    candidate_entity_id: null,
    candidate_score: null,
    candidate_reason: null,
    candidate_generated_at: "2026-08-14T09:00:00.000Z",
    source: "llm_extraction",
    source_id: "file-1",
    seed_source: null,
    seed_source_id: null,
    first_seen_at: "2026-08-10T09:00:00.000Z",
    last_seen_at: "2026-08-14T09:00:00.000Z",
    occurrence_count: 4,
    status: "pending",
    triggered_by_user_id: "user-1",
    review_started_at: null,
    review_started_by: null,
    backfill_cursor: null,
    resolved_by: null,
    resolved_at: null,
    resolved_entity_id: null,
    evidenceCount: 4,
    sourceBreakdown: [{ source: "fireflies", count: 4 }],
    candidate: null,
    ...overrides,
  };
}

const LINKED = queueRow({
  id: "row-linked",
  proposed_name: "OW Rec Portal",
  entity_type: "project",
  candidate_entity_id: "project-1",
  candidate: { id: "project-1", name: "Recruitment Portal", email: null },
});

const MULTI = queueRow({
  id: "row-multi",
  proposed_name: "Segmentation Phase 2",
  entity_type: "project",
  candidates: [
    { id: "project-2", name: "Segmentation", email: null },
    { id: "project-3", name: "Segmentation Rollout", email: null },
  ],
});

const POOLING = queueRow({ id: "row-pooling", proposed_name: "Falcon Dashboard", entity_type: "project" });

describe("projects review band action policy", () => {
  it("links single-candidate rows, pools candidate-less rows, and keeps person rows fully actionable", async () => {
    const person = queueRow({ id: "row-person", proposed_name: "Nadia Rahman", entity_type: "person" });
    server.use(
      http.get("/api/entity-review", ({ request }) => {
        const types = new URL(request.url).searchParams.get("types");
        if (types === "person") return HttpResponse.json({ rows: [person], total: 1 });
        return HttpResponse.json({ rows: [LINKED, MULTI, POOLING], total: 3 });
      }),
      http.get("/api/project-minting/verdicts", () => HttpResponse.json({ verdicts: [] })),
      http.get("/api/entities/whatsapp/identities", () =>
        HttpResponse.json({ items: [], viewerHasWhatsAppIdentity: false }),
      ),
    );

    const projects = renderWithProviders(<ReviewBandCapped types={["project"]} isAdmin />);

    const linkedRow = await screen.findByTestId("org-review-row-row-linked");
    expect(within(linkedRow).getByRole("button", { name: "Link" })).toBeInTheDocument();
    expect(within(linkedRow).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();

    const multiRow = screen.getByTestId("org-review-row-row-multi");
    expect(within(multiRow).getByText(/Segmentation, Segmentation Rollout/)).toBeInTheDocument();
    expect(within(multiRow).queryByRole("button", { name: /Link|Confirm|Add|Dismiss/ })).not.toBeInTheDocument();

    const pooling = screen.getByTestId("review-band-pooling");
    expect(pooling).toHaveTextContent("1 new name pooling for the weekly pass");
    expect(screen.queryByTestId("org-review-row-row-pooling")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-band-run-now")).toBeInTheDocument();
    projects.unmount();

    renderWithProviders(<ReviewBandCapped types={["person"]} />);
    const personRow = await screen.findByTestId("org-review-row-row-person");
    expect(within(personRow).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(personRow).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});
