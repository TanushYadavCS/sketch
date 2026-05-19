/**
 * Tests for the entity explorer's ECR-03B inline review surface.
 *
 * Covers the contract that PR 2 of ECR-03B adds:
 * - count-probe short-circuits when no pending rows exist (no list query)
 * - banner renders when count > 0, with three counts in the header
 * - off-page bucket lists candidate-keyed rows whose entity isn't visible
 * - per-entity chip renders only for visible candidate-keyed entities
 * - chip click expands inline <ReviewActions> below the row
 * - EXPERIMENTAL_FLAG=false hides everything (no probe issued)
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
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
  it("EXPERIMENTAL_FLAG=false: no banner, no chip, no count probe issued", async () => {
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
    // Give any erroneous probe a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(probeCalls).toBe(0);
    expect(screen.queryByTestId("review-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-chip-ent-1")).not.toBeInTheDocument();
  });

  it("count=0: probe fires, list query does NOT, no banner rendered", async () => {
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
    expect(screen.queryByTestId("review-banner")).not.toBeInTheDocument();
  });

  it("banner renders with three counts when count > 0", async () => {
    server.use(
      http.get("/api/setup/status", () => statusResponse(true)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entity-review", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("limit") === "0") {
          return HttpResponse.json({ rows: [], total: 4 });
        }
        return HttpResponse.json({
          rows: [
            rowFactory({ id: "r1", candidate_entity_id: "ent-1", proposed_name: "Simran Suri" }),
            rowFactory({ id: "r2", candidate_entity_id: "ent-99", proposed_name: "Off Page Person" }),
            rowFactory({ id: "r3", candidate_entity_id: null, proposed_name: "Orphan One" }),
            rowFactory({ id: "r4", candidate_entity_id: null, proposed_name: "Orphan Two" }),
          ],
          total: 4,
        });
      }),
    );

    renderWithProviders(<EntityExplorer />);
    const banner = await screen.findByTestId("review-banner");
    expect(banner).toHaveTextContent(/4 proposals waiting/);
    expect(banner).toHaveTextContent(/2 multi-candidate/);
    expect(banner).toHaveTextContent(/1 off-page/);
  });

  it("off-page row appears in banner; visible-candidate row appears as chip on entity row", async () => {
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
            rowFactory({ id: "r1", candidate_entity_id: "ent-1", proposed_name: "Simran Suri" }),
            rowFactory({ id: "r2", candidate_entity_id: "ent-99", proposed_name: "Off Page Person" }),
          ],
          total: 2,
        });
      }),
    );

    renderWithProviders(<EntityExplorer />);
    expect(await screen.findByTestId("review-chip-ent-1")).toHaveTextContent("1 proposal");
    expect(await screen.findByTestId("banner-row-r2")).toBeInTheDocument();
    expect(screen.queryByTestId("banner-row-r1")).not.toBeInTheDocument();
  });

  it("chip click expands inline ReviewActions; Confirm resolves and chip count drops", async () => {
    const user = userEvent.setup();
    let listFetches = 0;
    server.use(
      http.get("/api/setup/status", () => statusResponse(true)),
      http.get("/api/entities", () => entityListResponse([{ id: "ent-1", name: "Simran S" }])),
      http.get("/api/entity-review", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("limit") === "0") {
          return HttpResponse.json({ rows: [], total: listFetches === 0 ? 2 : 1 });
        }
        listFetches++;
        const rows = listFetches === 1
          ? [
              rowFactory({ id: "r1", candidate_entity_id: "ent-1", proposed_name: "Simran A" }),
              rowFactory({ id: "r2", candidate_entity_id: "ent-1", proposed_name: "Simran B" }),
            ]
          : [rowFactory({ id: "r2", candidate_entity_id: "ent-1", proposed_name: "Simran B" })];
        return HttpResponse.json({ rows, total: rows.length });
      }),
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
    const chip = await screen.findByTestId("review-chip-ent-1");
    expect(chip).toHaveTextContent("2 proposals");
    await user.click(chip);

    // Two ReviewActions render under the entity row — each has a Confirm.
    const confirmButtons = await screen.findAllByRole("button", { name: "Confirm" });
    expect(confirmButtons.length).toBe(2);
    await user.click(confirmButtons[0]);

    await waitFor(() => {
      expect(screen.getByTestId("review-chip-ent-1")).toHaveTextContent("1 proposal");
    });
  });
});
