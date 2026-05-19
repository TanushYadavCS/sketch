/**
 * Isolated tests for <ReviewActions>.
 *
 * End-to-end behaviour is also covered by the page tests in
 * routes/review-entities/index.test.tsx (the page mounts this component).
 * These tests pin the extracted component's own surface — the resolve
 * mutations and the new onResolved callback — so refactors inside the
 * component can't silently regress without breaking a colocated test.
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ReviewActions } from "./review-actions";

function rowFactory(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    proposed_name: "Simran Suri Neeli",
    normalized_name: "simran suri neeli",
    entity_type: "person",
    proposed_email: null,
    candidate_entity_id: "cand-1",
    candidate_score: 0.9,
    candidate_reason: "token-superset",
    candidate_generated_at: "2026-01-01T00:00:00.000Z",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z",
    occurrence_count: 1,
    status: "pending",
    triggered_by_user_id: "u1",
    review_started_at: null,
    review_started_by: null,
    backfill_cursor: null,
    resolved_by: null,
    resolved_at: null,
    resolved_entity_id: null,
    evidenceCount: 3,
    sourceBreakdown: [{ source: "fireflies", count: 3 }],
    ...over,
  };
}

describe("ReviewActions", () => {
  it("Confirm sends candidateGeneratedAt and fires onResolved with kind=confirmed", async () => {
    const user = userEvent.setup();
    const confirmCalls: unknown[] = [];
    const onResolved = vi.fn();
    server.use(
      http.post("/api/entity-review/:id/confirm", async ({ request }) => {
        confirmCalls.push(await request.json());
        return HttpResponse.json({
          row: rowFactory({ status: "confirmed" }),
          targetEntityId: "cand-1",
          shortCircuited: false,
          mergedStaleEntityId: null,
          idempotent: false,
        });
      }),
    );

    renderWithProviders(<ReviewActions row={rowFactory() as never} onResolved={onResolved} />);
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(confirmCalls).toHaveLength(1));
    expect(confirmCalls[0]).toEqual({ candidateGeneratedAt: "2026-01-01T00:00:00.000Z" });
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({ kind: "confirmed", targetEntityId: "cand-1" }),
    );
  });

  it("Reject fires onResolved with kind=rejected and the created entity id", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    server.use(
      http.post("/api/entity-review/:id/reject", () =>
        HttpResponse.json({
          row: rowFactory({ status: "rejected", candidate_entity_id: null }),
          targetEntityId: "new-1",
          reResolvedToExisting: false,
          createdEntityId: "new-1",
          idempotent: false,
        }),
      ),
    );

    renderWithProviders(<ReviewActions row={rowFactory() as never} onResolved={onResolved} />);
    await user.click(await screen.findByTestId("reject-button"));

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({ kind: "rejected", targetEntityId: "new-1" }),
    );
  });

  it("Confirm 409 CANDIDATE_DRIFT shows refresh-prompt copy and does not fire onResolved", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    server.use(
      http.post("/api/entity-review/:id/confirm", () =>
        HttpResponse.json(
          { error: { code: "CANDIDATE_DRIFT", message: "drift" } },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<ReviewActions row={rowFactory() as never} onResolved={onResolved} />);
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText(/suggestion changed/i)).toBeInTheDocument());
    expect(onResolved).not.toHaveBeenCalled();
  });
});
