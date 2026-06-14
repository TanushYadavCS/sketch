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

function bindings(rows: unknown[], children: unknown[] = []) {
  server.use(http.get("/api/entities/:id/bindings", () => HttpResponse.json({ bindings: rows, children })));
}

describe("ScopePanel", () => {
  it("renders effective bindings with origin / direct / inherited provenance", async () => {
    asAdmin();
    bindings(
      [
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
      ],
      [{ id: "child-1", name: "Child Project" }],
    );

    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Origin")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();
    expect(screen.getByText("Inherited")).toBeInTheDocument();
    expect(await screen.findByText("Child Project")).toBeInTheDocument();
  });

  it("lets an admin attach a data source from the Tracking board picker", async () => {
    asAdmin();
    bindings([]);
    server.use(
      http.get("/api/projects/bindable-containers", () =>
        HttpResponse.json({
          containers: [
            { source: "clickup", containerId: "C9", containerKind: "clickup_space", label: "Roadmap Space" },
          ],
        }),
      ),
    );
    let posted: Record<string, unknown> | null = null;
    server.use(
      http.post("/api/entities/:id/bindings", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ binding: { id: "new", entityId: ENTITY_ID, ...posted } });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    const board = await screen.findByRole("combobox", { name: "Tracking board" });
    await waitFor(() => expect(board).toBeEnabled());
    await user.click(board);
    await user.click(await screen.findByRole("option", { name: /Roadmap Space/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(posted).toEqual({
        source: "clickup",
        containerKind: "clickup_space",
        containerId: "C9",
        label: "Roadmap Space",
      });
    });
    expect(screen.getAllByText("Soon")).toHaveLength(2);
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
    expect(screen.queryByRole("combobox", { name: "Tracking board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });
});

function members(rows: unknown[], truncated = false) {
  server.use(http.get("/api/entities/:id/members", () => HttpResponse.json({ members: rows, truncated })));
}

const NOMINATED = {
  indexedFileId: "f1",
  fileName: "Sprint board",
  fileType: "task",
  source: "linear",
  providerUrl: null,
  viaProjectId: ENTITY_ID,
  containerId: "LP1",
  manual: false,
};
const INHERITED = {
  indexedFileId: "f2",
  fileName: "Child doc",
  fileType: "document",
  source: "clickup",
  providerUrl: null,
  viaProjectId: "child-1",
  containerId: "C1",
  manual: false,
};

describe("ScopePanel members", () => {
  it("lists members with inherited provenance", async () => {
    asMember();
    bindings([]);
    members([NOMINATED, INHERITED]);

    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    expect(await screen.findByText("Sprint board")).toBeInTheDocument();
    expect(screen.getByText("Child doc")).toBeInTheDocument();
    expect(screen.getByText("Inherited")).toBeInTheDocument();
  });

  it("lets an admin exclude a member", async () => {
    asAdmin();
    bindings([]);
    members([NOMINATED]);
    let excludedFileId: string | null = null;
    let excludedMode: string | null = null;
    server.use(
      http.put("/api/entities/:id/members/:fileId", async ({ params, request }) => {
        excludedFileId = params.fileId as string;
        excludedMode = ((await request.json()) as { mode?: string }).mode ?? null;
        return HttpResponse.json({ ok: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    await user.click(await screen.findByRole("button", { name: "Exclude Sprint board" }));

    await waitFor(() => {
      expect(excludedFileId).toBe("f1");
      expect(excludedMode).toBe("exclude");
    });
  });

  it("hides the exclude control from non-admins", async () => {
    asMember();
    bindings([]);
    members([NOMINATED]);

    renderWithProviders(<ScopePanel entityId={ENTITY_ID} />);

    expect(await screen.findByText("Sprint board")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /exclude/i })).not.toBeInTheDocument();
  });
});
