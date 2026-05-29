/**
 * GraphRebuildDialog — regression guard: the step-1 destructive choice
 * (categories, wipeLlmFacts) must never leak into the step-2 generative
 * payload. The old single-pane dialog silently discarded categories when
 * the user picked re-extract — this test fails if we ever re-introduce
 * that conflation.
 *
 * Three distinct failure modes covered here:
 *   1. /resets is called with connector/AI categories + wipeLlmFacts:true
 *      and never receives a `scope` field.
 *   2. /reenrichments receives ONLY scope + pendingRebuildId + confirm,
 *      never a `categories` field — even though the user just chose
 *      "delete categories" on step 1.
 *   3. The "Re-extract" radio is disabled in step 2 when step 1 did NOT
 *      wipe LLM facts (the helper text explains why) and enabled when it
 *      did.
 */
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { GraphRebuildDialog } from "./graph-rebuild-dialog";

interface ResetRequestBody {
  categories?: string[];
  wipeLlmFacts?: boolean;
  runAfter?: boolean;
  confirm?: string;
  scope?: unknown;
}
interface ReenrichRequestBody {
  scope?: { all?: boolean; sources?: string[]; fileIds?: string[] };
  runAfter?: boolean;
  confirm?: string;
  pendingRebuildId?: string;
  categories?: unknown;
}

function setupResetHandlers(recorded: {
  resets: ResetRequestBody[];
  reenrich: ReenrichRequestBody[];
  rebuilds: { pendingRebuildId?: string }[];
}) {
  server.use(
    http.post("/api/entities/resets", async ({ request }) => {
      const body = (await request.json()) as ResetRequestBody;
      recorded.resets.push(body);
      return HttpResponse.json(
        {
          message: "Reset started.",
          pendingRebuildId: "p-1",
          pendingRebuildExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          job: {
            id: "reset-j1",
            phase: "resetting",
            startedAt: new Date().toISOString(),
            pendingRebuildId: "p-1",
          },
        },
        { status: 202 },
      );
    }),
    http.get("/api/entities/resets/jobs/reset-j1", () => {
      return HttpResponse.json({
        id: "reset-j1",
        phase: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        reset: { deleted: { entities: 42, entity_mentions: 100, entity_relationships: 7 } },
        llmFactsWiped: { factsTombstoned: 17, relationshipEvidenceDeleted: 5, relationshipsDeleted: 2 },
      });
    }),
    http.post("/api/entities/reenrichments", async ({ request }) => {
      const body = (await request.json()) as ReenrichRequestBody;
      recorded.reenrich.push(body);
      return HttpResponse.json(
        { message: "Re-enrich started.", job: { id: "re-j1", phase: "wiping", startedAt: new Date().toISOString() } },
        { status: 202 },
      );
    }),
    http.post("/api/entities/rebuilds", async ({ request }) => {
      const body = (await request.json()) as { pendingRebuildId?: string };
      recorded.rebuilds.push(body);
      return HttpResponse.json(
        {
          message: "Rebuild started.",
          job: { id: "rb-j1", phase: "replaying_facts", startedAt: new Date().toISOString() },
        },
        { status: 202 },
      );
    }),
    // Step-2 polling: dialog stays open while the rebuild runs, so the
    // following job-detail endpoints get hit. Default to "in flight" so
    // the dialog reaches the running pane; individual tests can override.
    http.get("/api/entities/rebuilds/jobs/rb-j1", () => {
      return HttpResponse.json({
        id: "rb-j1",
        phase: "replaying_facts",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: { phase: "materialize", completed: 0, total: 100 },
      });
    }),
    http.get("/api/entities/reenrichments/jobs/re-j1", () => {
      return HttpResponse.json({
        id: "re-j1",
        phase: "wiping",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        progress: { phase: "wipe", completed: 0, total: 1 },
      });
    }),
  );
}

describe("GraphRebuildDialog", () => {
  it("step 1 with LLM-fact wipe → step 2 re-extract: /reenrichments gets scope only, no categories field", async () => {
    const user = userEvent.setup();
    const recorded = {
      resets: [] as ResetRequestBody[],
      reenrich: [] as ReenrichRequestBody[],
      rebuilds: [] as { pendingRebuildId?: string }[],
    };
    setupResetHandlers(recorded);

    renderWithProviders(<GraphRebuildDialog open={true} onOpenChange={() => {}} onSubmitted={() => {}} />);

    // Step 1: check the LLM-facts box (enables re-extract on step 2).
    await user.click(await screen.findByTestId("graph-rebuild-wipe-llm"));
    await user.click(screen.getByTestId("graph-rebuild-step1-submit"));

    // Step 1 → Step 2 transition once the reset job reports done.
    await waitFor(() => expect(recorded.resets.length).toBe(1));
    const resetBody = recorded.resets[0];
    expect(resetBody.runAfter).toBe(false);
    expect(resetBody.confirm).toBe("RESET_AND_RECREATE");
    expect(resetBody.wipeLlmFacts).toBe(true);
    expect(resetBody.categories).toEqual(["connectors", "ai"]);
    // /resets must never receive a scope field.
    expect(resetBody.scope).toBeUndefined();

    // Step 2 renders with the result line; re-extract is enabled (wipe was on).
    await screen.findByTestId("graph-rebuild-step1-result");
    const reextractRadio = await screen.findByTestId("graph-rebuild-method-reextract");
    expect(reextractRadio).not.toBeDisabled();

    await user.click(reextractRadio);
    await user.click(screen.getByTestId("graph-rebuild-step2-submit"));

    await waitFor(() => expect(recorded.reenrich.length).toBe(1));
    const reenrichBody = recorded.reenrich[0];
    // The regression: categories must NOT appear in the reenrich body. Even
    // though step 1 deleted categories, that decision belongs to /resets;
    // step 2 only knows the rebuild method.
    expect(reenrichBody.categories).toBeUndefined();
    expect(reenrichBody.scope).toEqual({ all: true });
    expect(reenrichBody.confirm).toBe("REENRICH");
    expect(reenrichBody.pendingRebuildId).toBe("p-1");
    expect(reenrichBody.runAfter).toBe(true);
  });

  it("step 1 without LLM-fact wipe: re-extract radio is disabled in step 2", async () => {
    const user = userEvent.setup();
    const recorded = {
      resets: [] as ResetRequestBody[],
      reenrich: [] as ReenrichRequestBody[],
      rebuilds: [] as { pendingRebuildId?: string }[],
    };
    setupResetHandlers(recorded);

    renderWithProviders(<GraphRebuildDialog open={true} onOpenChange={() => {}} onSubmitted={() => {}} />);

    // Leave the LLM-facts box unchecked.
    await user.click(await screen.findByTestId("graph-rebuild-step1-submit"));
    await waitFor(() => expect(recorded.resets.length).toBe(1));
    expect(recorded.resets[0].wipeLlmFacts).toBe(false);

    const reextractRadio = await screen.findByTestId("graph-rebuild-method-reextract");
    expect(reextractRadio).toBeDisabled();

    // The replay path posts to /rebuilds with only pendingRebuildId.
    await user.click(screen.getByTestId("graph-rebuild-step2-submit"));
    await waitFor(() => expect(recorded.rebuilds.length).toBe(1));
    expect(recorded.rebuilds[0]).toEqual({ pendingRebuildId: "p-1" });
    // /reenrichments is never called on the replay path.
    expect(recorded.reenrich).toHaveLength(0);
  });

  it("after step 2 submit the dialog stays open and renders a persistent progress pane", async () => {
    const user = userEvent.setup();
    const recorded = {
      resets: [] as ResetRequestBody[],
      reenrich: [] as ReenrichRequestBody[],
      rebuilds: [] as { pendingRebuildId?: string }[],
    };
    setupResetHandlers(recorded);
    let closed = false;

    renderWithProviders(
      <GraphRebuildDialog
        open={true}
        onOpenChange={(v) => {
          if (!v) closed = true;
        }}
        onSubmitted={() => {}}
      />,
    );

    await user.click(await screen.findByTestId("graph-rebuild-step1-submit"));
    await screen.findByTestId("graph-rebuild-step1-result");
    await user.click(screen.getByTestId("graph-rebuild-step2-submit"));

    // The rebuild request fires…
    await waitFor(() => expect(recorded.rebuilds.length).toBe(1));
    // …and the dialog transitions to the running pane instead of closing.
    await screen.findByTestId("graph-rebuild-step2-progress");
    expect(closed).toBe(false);
    // The footer no longer offers Cancel/Submit while the job is in flight.
    expect(screen.queryByTestId("graph-rebuild-step2-submit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("graph-rebuild-step2-cancel")).not.toBeInTheDocument();
    expect(screen.getByTestId("graph-rebuild-step2-running-button")).toBeDisabled();
  });

  it("step 2 cancel releases the pending lock via DELETE /api/entities/rebuilds/pending/:id", async () => {
    const user = userEvent.setup();
    const recorded = {
      resets: [] as ResetRequestBody[],
      reenrich: [] as ReenrichRequestBody[],
      rebuilds: [] as { pendingRebuildId?: string }[],
    };
    setupResetHandlers(recorded);
    const cancelHits: string[] = [];
    server.use(
      http.delete("/api/entities/rebuilds/pending/:id", ({ params }) => {
        cancelHits.push(params.id as string);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    let closed = false;
    renderWithProviders(
      <GraphRebuildDialog
        open={true}
        onOpenChange={(v) => {
          if (!v) closed = true;
        }}
        onSubmitted={() => {}}
      />,
    );

    await user.click(await screen.findByTestId("graph-rebuild-step1-submit"));
    await screen.findByTestId("graph-rebuild-step1-result");

    await user.click(screen.getByTestId("graph-rebuild-step2-cancel"));

    await waitFor(() => expect(cancelHits).toEqual(["p-1"]));
    await waitFor(() => expect(closed).toBe(true));
  });
});
