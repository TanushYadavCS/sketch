import type { EntityListItem } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ProjectsTree } from "./projects-tree";

function makeProject(
  id: string,
  name: string,
  hierarchy: { parentEntityId?: string | null; companyEntityId?: string | null; companyName?: string | null } = {},
): EntityListItem {
  return {
    id,
    name,
    nameStatus: "confirmed",
    proposedName: null,
    sourceType: "project",
    subtype: null,
    aliases: [],
    contactPoints: [],
    metadata: null,
    status: "confirmed",
    hotness: 0,
    mentionCount: 0,
    lastMentionAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    parentEntityId: hierarchy.parentEntityId ?? null,
    companyEntityId: hierarchy.companyEntityId ?? null,
    companyName: hierarchy.companyName ?? null,
  };
}

describe("ProjectsTree", () => {
  it("groups client sections plus Internal, nests children under their parent, and floats off-page parents", () => {
    const entities = [
      makeProject("segmentation", "Segmentation", { companyEntityId: "ow", companyName: "Oliver Wyman" }),
      makeProject("search-terms", "Search Terms Display", { parentEntityId: "segmentation" }),
      makeProject("beetu", "Beetu", { companyEntityId: "habuild", companyName: "Habuild" }),
      makeProject("durable-tasks", "Durable Tasks Epic"),
      makeProject("orphan-child", "Orphan Child", { parentEntityId: "not-in-this-page" }),
    ];

    renderWithProviders(<ProjectsTree entities={entities} onSelect={() => {}} isAdmin />);

    const owSection = screen.getByTestId("tree-section-ow");
    const habuildSection = screen.getByTestId("tree-section-habuild");
    const internalSection = screen.getByTestId("tree-section-__internal__");

    expect(within(owSection).getByText("Segmentation")).toBeInTheDocument();
    expect(within(habuildSection).getByText("Beetu")).toBeInTheDocument();
    expect(within(internalSection).getByText("Durable Tasks Epic")).toBeInTheDocument();

    const childRow = within(owSection).getByTestId("entity-row-search-terms");
    expect(childRow).toHaveStyle({ paddingLeft: "20px" });

    const orphanRow = within(internalSection).getByTestId("entity-row-orphan-child");
    expect(orphanRow).not.toHaveStyle({ paddingLeft: "20px" });
  });

  it("shows every section's strip while dragging and PATCHes an un-nest + company move on a cross-section drop", async () => {
    let patched: { url: string; body: unknown } | null = null;
    server.use(
      http.patch("/api/entities/:id", async ({ request, params }) => {
        patched = { url: String(params.id), body: await request.json() };
        return HttpResponse.json({ entity: { id: params.id } });
      }),
    );
    const entities = [
      makeProject("segmentation", "Segmentation", { companyEntityId: "ow", companyName: "Oliver Wyman" }),
      makeProject("search-terms", "Search Terms Display", { parentEntityId: "segmentation" }),
      makeProject("beetu", "Beetu", { companyEntityId: "habuild", companyName: "Habuild" }),
      makeProject("durable-tasks", "Durable Tasks Epic"),
    ];

    renderWithProviders(<ProjectsTree entities={entities} onSelect={() => {}} isAdmin />);

    fireEvent.dragStart(screen.getByTestId("entity-row-search-terms"));

    expect(screen.getByTestId("tree-drop-top-level-ow")).toHaveTextContent("drop here for top level");
    expect(screen.getByTestId("tree-drop-top-level-habuild")).toHaveTextContent("move to Habuild · top level");
    expect(screen.getByTestId("tree-drop-top-level-__internal__")).toHaveTextContent("move to Internal · top level");

    const habuildStrip = screen.getByTestId("tree-drop-top-level-habuild");
    const dragOverCancelled = fireEvent.dragOver(habuildStrip);
    expect(dragOverCancelled).toBe(false);
    fireEvent.drop(habuildStrip);

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toEqual({
      url: "search-terms",
      body: { parentEntityId: null, companyEntityId: "habuild" },
    });
  });
});
