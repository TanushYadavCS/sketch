import type { EntityRelationView, EntityRelationsResponse } from "@/lib/api";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { RelationshipsPanel } from "./relationships-panel";

function relation(overrides: Partial<EntityRelationView>): EntityRelationView {
  return {
    id: "rel-1",
    sourceEntityId: "person-1",
    targetEntityId: "company-1",
    relationshipType: "works_at",
    confidence: "EXTRACTED",
    confidenceScore: 0.8,
    source: "llm_extraction",
    validFrom: null,
    validTo: null,
    other: { id: "company-1", name: "One Stop AI", sourceType: "company", aliases: [] },
    evidenceCount: 0,
    ...overrides,
  };
}

function relations(outgoing: EntityRelationView[]): EntityRelationsResponse {
  return { outgoing, incoming: [], truncated: false, totalCount: outgoing.length };
}

describe("RelationshipsPanel declared links", () => {
  let lastBody: Record<string, unknown> | null;

  beforeEach(() => {
    lastBody = null;
    server.use(
      http.get("/api/entities", () =>
        HttpResponse.json({ entities: [{ id: "company-1", name: "One Stop AI", sourceType: "company" }], total: 1 }),
      ),
      http.post("/api/entities/person-1/relationships", async ({ request }) => {
        lastBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ relationshipId: "rel-new", replacedRelationshipIds: [] }, { status: 201 });
      }),
    );
  });

  it("declares a company link with the selected type", async () => {
    renderWithProviders(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="person-1"
        sourceType="person"
        isAdmin
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Link to company/ }));
    await userEvent.click(await screen.findByRole("button", { name: "One Stop AI" }));
    await userEvent.click(screen.getByRole("button", { name: "Link One Stop AI" }));
    await waitFor(() => expect(lastBody).not.toBeNull());
    expect(lastBody).toEqual({ targetEntityId: "company-1", relationshipType: "works_at" });
  });

  it("shows the unlink control only on declared rows", () => {
    renderWithProviders(
      <RelationshipsPanel
        relations={relations([
          relation({ id: "rel-declared", source: "declared", confidence: "CONFIRMED" }),
          relation({
            id: "rel-inferred",
            other: { id: "company-2", name: "Guessed Co", sourceType: "company", aliases: [] },
          }),
        ])}
        isLoading={false}
        entityId="person-1"
        sourceType="person"
        isAdmin
      />,
    );
    expect(screen.getAllByLabelText("Remove declared link")).toHaveLength(1);
    expect(screen.getByText("declared")).toBeInTheDocument();
  });

  it("hides the link action for non-person entities and non-admins", () => {
    const { rerender } = renderWithProviders(
      <RelationshipsPanel relations={relations([])} isLoading={false} entityId="proj-1" sourceType="project" isAdmin />,
    );
    expect(screen.queryByRole("button", { name: /Link to company/ })).not.toBeInTheDocument();
    rerender(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="person-1"
        sourceType="person"
        isAdmin={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /Link to company/ })).not.toBeInTheDocument();
  });
});
