import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ReviewBand } from "./review-band";

function birthRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    proposed_name: "Canvasx",
    normalized_name: "canvasx",
    entity_type: "team",
    proposed_email: null,
    candidate_entity_id: null,
    candidate_score: null,
    candidate_reason: null,
    candidate_generated_at: "2026-06-28T00:00:00.000Z",
    source: null,
    source_id: null,
    seed_source: "clickup",
    seed_source_id: "clickup:team:canvasx",
    first_seen_at: "2026-06-28T00:00:00.000Z",
    last_seen_at: "2026-06-28T00:00:00.000Z",
    occurrence_count: 1,
    status: "pending",
    triggered_by_user_id: "u1",
    review_started_at: null,
    review_started_by: null,
    backfill_cursor: null,
    resolved_by: null,
    resolved_at: null,
    resolved_entity_id: null,
    evidenceCount: 0,
    sourceBreakdown: [],
    candidate: null,
    ...overrides,
  };
}

describe("ReviewBand birth rows", () => {
  it("shows every ambiguous candidate in the row and chooser", async () => {
    const ambiguous = birthRow({
      candidate: null,
      candidates: [
        { id: "candidate-a", name: "Simran Suri", email: "simran.suri@example.com" },
        { id: "candidate-b", name: "Simran Neeli", email: "simran.neeli@example.com" },
      ],
      candidate_entity_ids: JSON.stringify(["candidate-a", "candidate-b"]),
    });
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [ambiguous], total: 1 })),
      http.get("/api/entity-review/:id", () => HttpResponse.json({ row: ambiguous, evidence: [] })),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["person"]} />);

    expect(await screen.findByText(/Simran Suri/)).toBeInTheDocument();
    expect(screen.getByText(/Simran Neeli/)).toBeInTheDocument();
    await user.click(within(screen.getByTestId("review-row-rev-1")).getByRole("button"));

    expect(await screen.findByText("Possible matches")).toBeInTheDocument();
    expect(screen.getByTestId("suggested-candidate-candidate-a")).toBeInTheDocument();
    expect(screen.getByTestId("suggested-candidate-candidate-b")).toBeInTheDocument();
  });

  it("shows a tracker origin chip and dismisses inline without opening the reconcile drawer", async () => {
    const dismiss = vi.fn();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [birthRow()], total: 1 })),
      http.post("/api/entity-review/:id/dismiss", async ({ params, request }) => {
        dismiss({ id: params.id, body: await request.json() });
        return HttpResponse.json({ row: birthRow({ status: "dismissed" }), idempotent: false });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["team"]} />);

    expect(await screen.findByText("Canvasx")).toBeInTheDocument();
    expect(screen.getByText("ClickUp")).toBeInTheDocument();
    expect(screen.getByTestId("birth-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("birth-merge")).toBeInTheDocument();
    expect(screen.queryByTestId("reconcile-proposed")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("birth-dismiss"));

    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    expect(dismiss.mock.calls[0][0]).toMatchObject({
      id: "rev-1",
      body: { candidateGeneratedAt: "2026-06-28T00:00:00.000Z" },
    });
  });

  it("opens a read-only inspect sheet listing the linked files for an AI-inferred birth", async () => {
    const aiRow = birthRow({
      source: "fireflies",
      source_id: "fireflies:team:canvasx",
      seed_source: null,
      seed_source_id: null,
      candidate_reason: "birth-gated",
      evidenceCount: 1,
    });
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [aiRow], total: 1 })),
      http.get("/api/entity-review/:id", () =>
        HttpResponse.json({
          row: aiRow,
          evidence: [
            {
              id: "ev-1",
              review_id: "rev-1",
              indexed_file_id: "file-1",
              source: "fireflies",
              note: null,
              seen_at: "2026-06-28T00:00:00.000Z",
              file: { name: "Kickoff sync", providerUrl: null, sourcePath: null },
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["team"]} />);

    expect(await screen.findByText("AI · Fireflies")).toBeInTheDocument();

    await user.click(screen.getByTestId("birth-inspect"));

    expect(await screen.findByText("Linked files (1)")).toBeInTheDocument();
    expect(screen.getByText("Kickoff sync")).toBeInTheDocument();
    // Inspect is one-column: the two-column reconcile layout never renders.
    expect(screen.queryByTestId("reconcile-proposed")).not.toBeInTheDocument();
  });

  it("closes a person inspect sheet without removing the person from review", async () => {
    const person = birthRow({ entity_type: "person", proposed_name: "Priya Shah" });
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [person], total: 1 })),
      http.get("/api/entity-review/:id", () => HttpResponse.json({ row: person, evidence: [] })),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["person"]} />);

    await user.click(await screen.findByTestId("birth-inspect"));
    expect(await screen.findByTestId("birth-inspect-dismiss")).toBeInTheDocument();

    await user.click(screen.getByTestId("birth-inspect-dismiss"));

    await waitFor(() => expect(screen.queryByTestId("birth-inspect-dismiss")).not.toBeInTheDocument());
    expect(screen.getByText("Priya Shah")).toBeInTheDocument();
  });

  it("still dismisses non-person inspect rows", async () => {
    const team = birthRow({ proposed_name: "Canvas Platform" });
    const dismiss = vi.fn();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [team], total: 1 })),
      http.get("/api/entity-review/:id", () => HttpResponse.json({ row: team, evidence: [] })),
      http.post("/api/entity-review/:id/dismiss", async ({ params, request }) => {
        dismiss({ id: params.id, body: await request.json() });
        return HttpResponse.json({ row: { ...team, status: "dismissed" }, idempotent: false });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["team"]} />);

    await user.click(await screen.findByTestId("birth-inspect"));
    await user.click(await screen.findByTestId("birth-inspect-dismiss"));

    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    expect(dismiss.mock.calls[0][0]).toMatchObject({
      id: "rev-1",
      body: { candidateGeneratedAt: "2026-06-28T00:00:00.000Z" },
    });
  });

  it("lists the tasks under a tracker seed in the inspect sheet", async () => {
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [birthRow()], total: 1 })),
      http.get("/api/entity-review/:id", () =>
        HttpResponse.json({
          row: birthRow(),
          evidence: [],
          childTaskCount: 3,
          childTasks: [
            {
              indexedFileId: "f1",
              name: "SKE-1: Alpha",
              fileType: "issue",
              providerUrl: "https://linear.app/1",
              source: "linear",
            },
            { indexedFileId: "f2", name: "SKE-2: Beta", fileType: "issue", providerUrl: null, source: "linear" },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["team"]} />);

    await user.click(await screen.findByTestId("birth-inspect"));

    expect(await screen.findByText("Tasks under this (3)")).toBeInTheDocument();
    expect(screen.getByText("SKE-1: Alpha")).toBeInTheDocument();
    expect(screen.getByText("SKE-2: Beta")).toBeInTheDocument();
    // count (3) exceeds the listed rows (2) → an honest "+ 1 more".
    expect(screen.getByText("+ 1 more")).toBeInTheDocument();
  });

  it("confirms a renamed birth, sending the edited name as nameOverride", async () => {
    const confirm = vi.fn();
    server.use(
      http.get("/api/entity-review", () => HttpResponse.json({ rows: [birthRow()], total: 1 })),
      http.get("/api/entity-review/:id", () => HttpResponse.json({ row: birthRow(), evidence: [] })),
      http.post("/api/entity-review/:id/confirm", async ({ request }) => {
        confirm(await request.json());
        return HttpResponse.json({
          row: birthRow({ status: "confirmed" }),
          targetEntityId: "ent-1",
          shortCircuited: false,
          mergedStaleEntityId: null,
          idempotent: false,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ReviewBand types={["team"]} />);

    await user.click(await screen.findByTestId("birth-inspect"));

    const input = await screen.findByTestId("birth-name-input");
    await user.clear(input);
    await user.type(input, "CanvasX");
    await user.click(screen.getByTestId("birth-inspect-confirm"));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatchObject({
      candidateGeneratedAt: "2026-06-28T00:00:00.000Z",
      nameOverride: "CanvasX",
    });
  });
});
