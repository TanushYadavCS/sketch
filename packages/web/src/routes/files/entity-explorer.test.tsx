/**
 * Tests for the entity explorer's ECR-03B inline review surface.
 *
 * Contract:
 * - count-probe short-circuits when no pending rows exist (no list query)
 * - pending review rows render as "ghost rows" at the top of the entities
 *   table; a divider separates them from confirmed entities
 * - EXPERIMENTAL_FLAG=false hides everything (no probe issued, no ghost rows)
 * - clicking a ghost row opens the drawer in review mode (two-column
 *   reconcile view with the proposed entity + ReviewActions)
 * - "Confirm" inside the drawer resolves the row and shrinks the ghost set
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { EntityExplorer } from "./entity-explorer";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useRouteContext: () => ({
      auth: {
        role: "admin",
        userId: "u1",
        name: "Tester",
        displayName: "Tester",
        displayIdentifier: "tester@test.com",
      },
    }),
  };
});

const baseStatus = {
  completed: true,
  currentStep: 5,
  adminEmail: "admin@test.com",
  orgName: "Acme",
  botName: "Sketch",
  slackConnected: true,
  llmConnected: true,
  llmProvider: "anthropic" as const,
};

function statusResponse(experimentalFlag: boolean) {
  return HttpResponse.json({ ...baseStatus, experimentalFlag });
}

function entityListResponse(entities: Array<Partial<Record<string, unknown>>>) {
  return HttpResponse.json({
    entities: entities.map((e) => ({
      id: "ent-default",
      name: "Default",
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
      ...e,
    })),
    total: entities.length,
  });
}

function rowFactory(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    proposed_name: "Simran Suri Neeli",
    normalized_name: "simran suri neeli",
    entity_type: "person",
    proposed_email: null,
    candidate_entity_id: "ent-1",
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
    evidenceCount: 2,
    sourceBreakdown: [{ source: "fireflies", count: 2 }],
    candidate: { id: "ent-1", name: "Simran S", email: null },
    ...over,
  };
}

describe("EntityExplorer ECR-03B inline review", () => {
  it("EXPERIMENTAL_FLAG=false: no ghost rows, no count probe issued", async () => {
    let probeCalls = 0;
    server.use(
      http.get("/api/setup/status", () => statusResponse(false)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entity-review", () => {
        probeCalls++;
        return HttpResponse.json({ rows: [], total: 0 });
      }),
    );

    renderWithProviders(<EntityExplorer />);
    await waitFor(() => expect(screen.getByText("Simran S")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(probeCalls).toBe(0);
    expect(screen.queryByTestId("pending-reviews-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^review-row-/)).not.toBeInTheDocument();
  });

  it("count=0: probe fires, list query does NOT, no ghost rows rendered", async () => {
    let listCalls = 0;
    server.use(
      http.get("/api/setup/status", () => statusResponse(true)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entity-review", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("limit") !== "0") listCalls++;
        return HttpResponse.json({ rows: [], total: 0 });
      }),
    );

    renderWithProviders(<EntityExplorer />);
    await waitFor(() => expect(screen.getByText("Simran S")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalls).toBe(0);
    expect(screen.queryByTestId(/^review-row-/)).not.toBeInTheDocument();
  });

  it("renders ghost rows above the entities divider when there are pending proposals", async () => {
    server.use(
      http.get("/api/setup/status", () => statusResponse(true)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entity-review", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("limit") === "0") {
          return HttpResponse.json({ rows: [], total: 2 });
        }
        return HttpResponse.json({
          rows: [
            rowFactory({ id: "r1", proposed_name: "Simran Suri Neeli" }),
            rowFactory({ id: "r2", proposed_name: "Aditya Giri", candidate_entity_id: null, candidate: null }),
          ],
          total: 2,
        });
      }),
    );

    renderWithProviders(<EntityExplorer />);
    expect(await screen.findByTestId("pending-reviews-badge")).toHaveTextContent("To review · 2");
    expect(await screen.findByTestId("review-row-r1")).toHaveTextContent("Simran Suri Neeli");
    expect(screen.getByTestId("review-row-r2")).toHaveTextContent("Aditya Giri");
    // The "Existing · N" band only shows when both sections coexist.
    expect(screen.getByText(/Existing · /)).toBeInTheDocument();
    expect(screen.getByText("Simran S")).toBeInTheDocument();
  });

  it("clicking a ghost row opens the drawer in review mode with proposed + candidate columns", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/setup/status", () => statusResponse(true)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entities/ent-1", () =>
        HttpResponse.json({
          entity: {
            id: "ent-1",
            name: "Simran S",
            sourceType: "person",
            subtype: null,
            aliases: [],
            metadata: null,
            status: "confirmed",
            hotness: 0,
            mentionCount: 3,
            lastMentionAt: null,
            createdAt: "x",
            updatedAt: "x",
          },
          sourceRefs: [],
        }),
      ),
      http.get("/api/entities/ent-1/mentions", () => HttpResponse.json({ mentions: [], total: 0, hiddenCount: 0 })),
      http.get("/api/entity-review", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("limit") === "0") {
          return HttpResponse.json({ rows: [], total: 1 });
        }
        return HttpResponse.json({
          rows: [rowFactory({ id: "r1", proposed_name: "Simran Suri Neeli" })],
          total: 1,
        });
      }),
      http.get("/api/entity-review/r1", () =>
        HttpResponse.json({
          row: rowFactory({ id: "r1", proposed_name: "Simran Suri Neeli" }),
          evidence: [
            {
              id: "e1",
              review_id: "r1",
              indexed_file_id: "f1",
              source: "fireflies",
              note: null,
              seen_at: "2026-01-02T00:00:00.000Z",
              file: {
                name: "meeting-2026-01-02.txt",
                providerUrl: "https://example.com/f1",
                sourcePath: null,
              },
            },
          ],
        }),
      ),
    );

    renderWithProviders(<EntityExplorer />);
    const ghost = await screen.findByTestId("review-row-r1");
    await user.click(within(ghost).getByRole("button"));

    expect(await screen.findByText(/Reconcile: Simran Suri Neeli/)).toBeInTheDocument();
    const proposed = await screen.findByTestId("reconcile-proposed");
    expect(within(proposed).getByText("meeting-2026-01-02.txt")).toBeInTheDocument();
    const candidate = await screen.findByTestId("reconcile-candidate");
    expect(candidate).toHaveTextContent("Simran S");
    // ✓ confirm-merge button lives on the candidate card itself.
    expect(within(candidate).getByTestId("confirm-merge")).toBeInTheDocument();
    expect(within(candidate).getByTestId("reject-match")).toBeInTheDocument();
  });

  it("Confirm inside drawer resolves the row and shrinks the ghost set", async () => {
    const user = userEvent.setup();
    let listFetches = 0;
    server.use(
      http.get("/api/setup/status", () => statusResponse(true)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entities/ent-1", () =>
        HttpResponse.json({
          entity: {
            id: "ent-1",
            name: "Simran S",
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
          sourceRefs: [],
        }),
      ),
      http.get("/api/entities/ent-1/mentions", () => HttpResponse.json({ mentions: [], total: 0, hiddenCount: 0 })),
      http.get("/api/entity-review", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("limit") === "0") {
          return HttpResponse.json({ rows: [], total: listFetches === 0 ? 1 : 0 });
        }
        listFetches++;
        const rows = listFetches === 1 ? [rowFactory({ id: "r1" })] : [];
        return HttpResponse.json({ rows, total: rows.length });
      }),
      http.get("/api/entity-review/r1", () => HttpResponse.json({ row: rowFactory({ id: "r1" }), evidence: [] })),
      http.post("/api/entity-review/r1/confirm", () =>
        HttpResponse.json({
          row: rowFactory({ id: "r1", status: "confirmed" }),
          targetEntityId: "ent-1",
          shortCircuited: false,
          mergedStaleEntityId: null,
          idempotent: false,
        }),
      ),
    );

    renderWithProviders(<EntityExplorer />);
    const ghost = await screen.findByTestId("review-row-r1");
    await user.click(within(ghost).getByRole("button"));

    const confirm = await screen.findByTestId("confirm-merge");
    await user.click(confirm);

    await waitFor(() => {
      expect(screen.queryByTestId("review-row-r1")).not.toBeInTheDocument();
    });
  });
});
