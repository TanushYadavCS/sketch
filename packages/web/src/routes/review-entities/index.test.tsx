/**
 * Route-level tests for /review-entities.
 *
 * The route component is wrapped in TanStack's route system in production;
 * for unit tests we render the component function directly with our test
 * QueryClient. The route's createRoute() registration is exercised
 * implicitly by the typecheck.
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { reviewEntitiesRoute } from "./index";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: "/review-entities" }),
    useRouteContext: () => ({}),
  };
});

const ReviewEntitiesPage = reviewEntitiesRoute.options.component as () => React.ReactElement;

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
    sourceBreakdown: [
      { source: "fireflies", count: 2 },
      { source: "gmail", count: 1 },
    ],
    ...over,
  };
}

describe("ReviewEntitiesPage", () => {
  it("renders the list with evidence headline", async () => {
    server.use(
      http.get("/api/entity-review", () =>
        HttpResponse.json({
          rows: [
            rowFactory(),
            rowFactory({
              id: "r2",
              proposed_name: "Aryaman Soni",
              evidenceCount: 1,
              sourceBreakdown: [{ source: "fireflies", count: 1 }],
            }),
          ],
          total: 2,
        }),
      ),
    );

    renderWithProviders(<ReviewEntitiesPage />);
    await waitFor(() => {
      expect(screen.getByText("Simran Suri Neeli")).toBeInTheDocument();
      expect(screen.getByText("Aryaman Soni")).toBeInTheDocument();
    });
    expect(screen.getByText(/3 evidence rows · 2 sources/)).toBeInTheDocument();
    expect(screen.getByText(/1 evidence row · 1 source/)).toBeInTheDocument();
  });

  it("expanding a row fetches detail and Confirm sends candidateGeneratedAt", async () => {
    const user = userEvent.setup();
    const confirmCalls: unknown[] = [];
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [rowFactory()], total: 1 })),
      http.get("/api/entity-review/r1", () => HttpResponse.json({ row: rowFactory(), evidence: [] })),
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

    renderWithProviders(<ReviewEntitiesPage />);

    const expandBtn = await screen.findByTestId("review-row-r1");
    await user.click(expandBtn);

    const confirmBtn = await screen.findByRole("button", { name: "Confirm" });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(confirmCalls).toHaveLength(1);
    });
    expect(confirmCalls[0]).toEqual({ candidateGeneratedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("Reject (no suggestion) sends candidateGeneratedAt — regression guard against POST {}", async () => {
    const user = userEvent.setup();
    const rejectCalls: unknown[] = [];
    server.use(
      http.get("/api/entity-review", () =>
        HttpResponse.json({ rows: [rowFactory({ id: "r1", candidate_entity_id: null })], total: 1 }),
      ),
      http.get("/api/entity-review/r1", () =>
        HttpResponse.json({ row: rowFactory({ id: "r1", candidate_entity_id: null }), evidence: [] }),
      ),
      http.post("/api/entity-review/:id/reject", async ({ request }) => {
        rejectCalls.push(await request.json());
        return HttpResponse.json({
          row: rowFactory({ status: "rejected", candidate_entity_id: null }),
          targetEntityId: "new-1",
          reResolvedToExisting: false,
          createdEntityId: "new-1",
          idempotent: false,
        });
      }),
    );

    renderWithProviders(<ReviewEntitiesPage />);
    await user.click(await screen.findByTestId("review-row-r1"));
    await user.click(await screen.findByTestId("reject-button"));

    await waitFor(() => expect(rejectCalls).toHaveLength(1));
    expect(rejectCalls[0]).toEqual({ candidateGeneratedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("Confirm 409 CANDIDATE_DRIFT shows refresh-prompt copy and rolls back optimistic removal", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [rowFactory()], total: 1 })),
      http.get("/api/entity-review/r1", () => HttpResponse.json({ row: rowFactory(), evidence: [] })),
      http.post("/api/entity-review/:id/confirm", () =>
        HttpResponse.json(
          { error: { code: "CANDIDATE_DRIFT", message: "drift", currentRow: rowFactory() } },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<ReviewEntitiesPage />);
    await user.click(await screen.findByTestId("review-row-r1"));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByText(/suggestion changed/i)).toBeInTheDocument();
    });
    // Row stays present after rollback.
    expect(screen.getByText("Simran Suri Neeli")).toBeInTheDocument();
  });

  it("Confirm 422 EVIDENCE_TOO_LARGE shows the sticky admin message", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [rowFactory()], total: 1 })),
      http.get("/api/entity-review/r1", () => HttpResponse.json({ row: rowFactory(), evidence: [] })),
      http.post("/api/entity-review/:id/confirm", () =>
        HttpResponse.json({ error: { code: "EVIDENCE_TOO_LARGE", message: "too many" } }, { status: 422 }),
      ),
    );

    renderWithProviders(<ReviewEntitiesPage />);
    await user.click(await screen.findByTestId("review-row-r1"));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByText(/more than 1000 evidence files/i)).toBeInTheDocument();
    });
  });

  it("Picker selection sends Confirm with mergeIntoEntityId + candidateGeneratedAt", async () => {
    const user = userEvent.setup();
    const confirmCalls: unknown[] = [];
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [rowFactory()], total: 1 })),
      http.get("/api/entity-review/r1", () => HttpResponse.json({ row: rowFactory(), evidence: [] })),
      http.get("/api/entities", () =>
        HttpResponse.json({
          entities: [
            {
              id: "alt-1",
              name: "Simran Kapur",
              sourceType: "person",
              subtype: null,
              aliases: [],
              metadata: null,
              status: "confirmed",
              hotness: 0,
              mentionCount: 0,
              lastMentionAt: null,
              createdAt: "x",
              updatedAt: "x",
            },
          ],
          total: 1,
        }),
      ),
      http.post("/api/entity-review/:id/confirm", async ({ request }) => {
        confirmCalls.push(await request.json());
        return HttpResponse.json({
          row: rowFactory({ status: "confirmed" }),
          targetEntityId: "alt-1",
          shortCircuited: false,
          mergedStaleEntityId: null,
          idempotent: false,
        });
      }),
    );

    renderWithProviders(<ReviewEntitiesPage />);
    await user.click(await screen.findByTestId("review-row-r1"));
    await user.click(await screen.findByRole("button", { name: /Pick a different existing/i }));
    await user.type(await screen.findByRole("textbox", { name: /entity search/i }), "kap");
    await user.click(await screen.findByRole("button", { name: /Simran Kapur/i }));

    await waitFor(() => expect(confirmCalls).toHaveLength(1));
    expect(confirmCalls[0]).toEqual({
      candidateGeneratedAt: "2026-01-01T00:00:00.000Z",
      mergeIntoEntityId: "alt-1",
    });
  });

  it("Idempotent replay (idempotent: true) treated as success — no UI error", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [rowFactory()], total: 1 })),
      http.get("/api/entity-review/r1", () => HttpResponse.json({ row: rowFactory(), evidence: [] })),
      http.post("/api/entity-review/:id/confirm", () =>
        HttpResponse.json({
          row: rowFactory({ status: "confirmed" }),
          targetEntityId: "cand-1",
          shortCircuited: false,
          mergedStaleEntityId: null,
          idempotent: true,
        }),
      ),
    );

    renderWithProviders(<ReviewEntitiesPage />);
    await user.click(await screen.findByTestId("review-row-r1"));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    // No error banner should appear.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("shows the empty-state when the list is empty", async () => {
    server.use(http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 0 })));
    renderWithProviders(<ReviewEntitiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Nothing pending/i)).toBeInTheDocument();
    });
  });

  it("shows the experimental-disabled state on 404", async () => {
    server.use(
      http.get("/api/entity-review", () =>
        HttpResponse.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 }),
      ),
    );
    renderWithProviders(<ReviewEntitiesPage />);
    await waitFor(() => {
      expect(screen.getByText(/experimental feature/i)).toBeInTheDocument();
    });
  });
});
