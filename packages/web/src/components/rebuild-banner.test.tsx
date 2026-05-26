/**
 * RebuildBanner contract:
 *  - active job → "Rebuilding entities" banner with phase + progress
 *  - terminal success → green banner with relation count + dismissable
 *  - terminal failure → red banner with [Retry] that invokes onRetry
 *    pre-filled from the job's request
 */
import type { ActiveRebuildJob, RebuildJobState } from "@/hooks/use-rebuild-job";
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RebuildBanner } from "./rebuild-banner";

function stateWith(over: Partial<RebuildJobState>): RebuildJobState {
  return {
    activeJob: null,
    latestJob: null,
    anyActive: false,
    externalActive: false,
    refetch: () => {},
    ...over,
  };
}

function activeJob(): ActiveRebuildJob {
  return {
    kind: "reset",
    job: {
      id: "j-active",
      phase: "replaying_facts",
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      finishedAt: null,
      request: { categories: ["connectors", "ai"], runAfter: true },
      progress: { phase: "materialize", completed: 142, total: 480 },
    },
  };
}

function successJob(): ActiveRebuildJob {
  return {
    kind: "reset",
    job: {
      id: "j-done",
      phase: "done",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      finishedAt: new Date().toISOString(),
      request: { categories: ["connectors", "ai"], runAfter: true },
      replay: {
        factsRead: 100,
        entitiesCreated: 12,
        entitiesLinked: 8,
        mentionsWritten: 60,
        relationshipsWritten: 5,
        materialized: 90,
      },
    },
  };
}

function failedJob(): ActiveRebuildJob {
  return {
    kind: "reset",
    job: {
      id: "j-failed",
      phase: "failed",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date().toISOString(),
      request: { categories: ["ai"], runAfter: true },
      error: "Materialize failed: db locked",
    },
  };
}

describe("RebuildBanner", () => {
  it("renders the active banner with phase and progress while a job is running", () => {
    renderWithProviders(
      <RebuildBanner state={stateWith({ activeJob: activeJob(), anyActive: true })} onRetry={() => {}} />,
    );
    const banner = screen.getByTestId("rebuild-banner-active");
    expect(banner).toHaveTextContent("Rebuilding entities");
    expect(banner).toHaveTextContent("replaying_facts");
    expect(banner).toHaveTextContent("142 / 480 materialize");
  });

  it("shows the success banner with the relation count after a done job", () => {
    renderWithProviders(<RebuildBanner state={stateWith({ latestJob: successJob() })} onRetry={() => {}} />);
    const banner = screen.getByTestId("rebuild-banner-success");
    expect(banner).toHaveTextContent("Rebuild complete");
    expect(banner).toHaveTextContent("5 relations written");
  });

  it("calls onRetry with a prefill biased by job kind when the failure banner's Retry is clicked", async () => {
    const onRetry = vi.fn();
    renderWithProviders(<RebuildBanner state={stateWith({ latestJob: failedJob() })} onRetry={onRetry} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("rebuild-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Failed kind was "reset" — retry should default the dialog to the
    // replay path, not the LLM re-extract path.
    expect(onRetry.mock.calls[0][0]).toEqual({ preferReextract: false });
  });

  it("biases retry to re-extract when the failed job was a reenrich", async () => {
    const onRetry = vi.fn();
    const job: ActiveRebuildJob = {
      kind: "reenrich",
      job: {
        id: "j-failed-reenrich",
        phase: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        request: { scope: { all: true }, runAfter: true },
        error: "wipe failed",
      },
    };
    renderWithProviders(<RebuildBanner state={stateWith({ latestJob: job })} onRetry={onRetry} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("rebuild-retry"));
    expect(onRetry.mock.calls[0][0]).toEqual({ preferReextract: true });
  });
});
