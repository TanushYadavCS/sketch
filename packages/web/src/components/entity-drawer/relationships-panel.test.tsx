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

describe("RelationshipsPanel company-side Add people", () => {
  let postedBodies: Array<{ personId: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    postedBodies = [];
    server.use(
      http.get("/api/entities", () =>
        HttpResponse.json({
          entities: [
            { id: "person-1", name: "Arun", sourceType: "person", metadata: null },
            { id: "person-2", name: "Nikhil", sourceType: "person", metadata: null },
          ],
          total: 2,
        }),
      ),
      http.get("/api/entities/:id/relations", () =>
        HttpResponse.json({ outgoing: [], incoming: [], truncated: false, totalCount: 0 }),
      ),
      http.post("/api/entities/:id/relationships", async ({ params, request }) => {
        postedBodies.push({
          personId: params.id as string,
          body: (await request.json()) as Record<string, unknown>,
        });
        return HttpResponse.json({ relationshipId: `rel-${params.id}`, replacedRelationshipIds: [] }, { status: 201 });
      }),
    );
  });

  it("posts one person-first declare call per selected person with the chosen type", async () => {
    renderWithProviders(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="company-1"
        sourceType="company"
        isAdmin
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Add people/ }));
    await userEvent.type(screen.getByPlaceholderText("Search people"), "ar");
    await userEvent.click(await screen.findByRole("button", { name: /Arun/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Nikhil/ }));
    await userEvent.click(screen.getByRole("button", { name: "Link 2 people" }));
    await waitFor(() => expect(postedBodies).toHaveLength(2));
    expect(postedBodies).toEqual([
      { personId: "person-1", body: { targetEntityId: "company-1", relationshipType: "works_at" } },
      { personId: "person-2", body: { targetEntityId: "company-1", relationshipType: "works_at" } },
    ]);
  });

  it("warns which declared employer a works_at declaration replaces", async () => {
    server.use(
      http.get("/api/entities/person-1/relations", () =>
        HttpResponse.json({
          outgoing: [
            relation({
              id: "rel-old",
              source: "declared",
              confidence: "CONFIRMED",
              other: { id: "company-9", name: "Old Employer", sourceType: "company", aliases: [] },
            }),
          ],
          incoming: [],
          truncated: false,
          totalCount: 1,
        }),
      ),
    );
    renderWithProviders(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="company-1"
        sourceType="company"
        isAdmin
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Add people/ }));
    await userEvent.type(screen.getByPlaceholderText("Search people"), "ar");
    await userEvent.click(await screen.findByRole("button", { name: /Arun/ }));
    expect(await screen.findByText("replaces Old Employer")).toBeInTheDocument();
  });

  it("renders Add people only on company entities for admins", () => {
    const { rerender } = renderWithProviders(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="company-1"
        sourceType="company"
        isAdmin
      />,
    );
    expect(screen.getByRole("button", { name: /Add people/ })).toBeInTheDocument();
    rerender(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="company-1"
        sourceType="company"
        isAdmin={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /Add people/ })).not.toBeInTheDocument();
    rerender(
      <RelationshipsPanel
        relations={relations([])}
        isLoading={false}
        entityId="person-1"
        sourceType="person"
        isAdmin
      />,
    );
    expect(screen.queryByRole("button", { name: /Add people/ })).not.toBeInTheDocument();
  });
});
