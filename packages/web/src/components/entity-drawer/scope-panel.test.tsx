import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { ScopePanel } from "./scope-panel";

const ENTITY_ID = "proj-1";

function asAdmin() {
  server.use(
    http.get("/api/auth/session", () =>
      HttpResponse.json({ authenticated: true, role: "admin", email: "a@test.com", userId: "u1", name: "Admin" }),
    ),
  );
}

function asMember() {
  server.use(
    http.get("/api/auth/session", () =>
      HttpResponse.json({ authenticated: true, role: "member", email: "m@test.com", userId: "u2", name: "Member" }),
    ),
  );
}

function bindings(rows: unknown[]) {
  server.use(http.get("/api/entities/:id/bindings", () => HttpResponse.json({ bindings: rows })));
}

describe("ScopePanel", () => {
  it("renders effective bindings with origin / direct / inherited provenance", async () => {
    asAdmin();
    bindings([
      {
        id: "b0",
        entityId: ENTITY_ID,
        source: "linear",
        containerId: "L1",
        containerKind: "linear_origin",
        label: null,
        connectorConfigId: null,
        viaProjectId: ENTITY_ID,
        origin: true,
      },
      {
        id: "b1",
        entityId: ENTITY_ID,
        source: "clickup",
        containerId: "C1",
        containerKind: "clickup_space",
        label: "Roadmap",
        connectorConfigId: null,
        viaProjectId: ENTITY_ID,
        origin: false,
      },
      {
        id: "b2",
        entityId: "child-1",
        source: "slack",
        containerId: "S1",
        containerKind: "slack_channel",
        label: "#child",
        connectorConfigId: null,
        viaProjectId: "child-1",
        origin: false,
      },
    ]);
    server.use(
      http.get("/api/entities/child-1", () =>
        HttpResponse.json({ entity: { id: "child-1", name: "Child Project", sourceType: "project" }, sourceRefs: [] }),
      ),
    );

    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Origin")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();
    expect(screen.getByText("Inherited")).toBeInTheDocument();
    expect(await screen.findByText("Child Project")).toBeInTheDocument();
  });

  it("lets an admin attach a data source", async () => {
    asAdmin();
    bindings([]);
    let posted: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/entities/:id/bindings", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ binding: { id: "new", entityId: ENTITY_ID, ...posted } });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    await user.type(await screen.findByLabelText("Source connector"), "clickup");
    await user.type(screen.getByLabelText("Container kind"), "clickup_space");
    await user.type(screen.getByLabelText("Container id"), "C9");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(posted).toEqual({ source: "clickup", containerKind: "clickup_space", containerId: "C9", label: null });
    });
  });

  it("is read-only for non-admins", async () => {
    asMember();
    bindings([
      {
        id: "b1",
        entityId: ENTITY_ID,
        source: "clickup",
        containerId: "C1",
        containerKind: "clickup_space",
        label: "Roadmap",
        connectorConfigId: null,
        viaProjectId: ENTITY_ID,
        origin: false,
      },
    ]);

    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.queryByLabelText("Source connector")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });
});
