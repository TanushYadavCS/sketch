import { useEntityUi } from "@/lib/entity-ui";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectsPage } from "./index";

function projectsReturn(projects: unknown[]) {
  server.use(http.get("/api/projects", () => HttpResponse.json({ projects })));
}

const DERIVED_WIRED = {
  id: "p1",
  name: "Helios",
  origin: "derived",
  status: "confirmed",
  sourceCount: 2,
  subProjectCount: 1,
};
const DEFINED_BARE = {
  id: "p2",
  name: "Atlas Rollout",
  origin: "defined",
  status: "confirmed",
  sourceCount: 0,
  subProjectCount: 0,
};

function StackProbe() {
  const ui = useEntityUi();
  return <div data-testid="open-stack">{ui.stack.join(",")}</div>;
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    server.use(
      http.get("/api/products", () => HttpResponse.json({ products: [] })),
      http.get("/api/entities", () => HttpResponse.json({ entities: [], total: 0 })),
    );
  });

  it("groups projects by whether they have data sources", async () => {
    projectsReturn([DERIVED_WIRED, DEFINED_BARE]);
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("Projects · needs sources")).toBeInTheDocument();
    expect(screen.getByText("Projects · active")).toBeInTheDocument();
    expect(screen.getByText("Helios")).toBeInTheDocument();
    expect(screen.getByText("Atlas Rollout")).toBeInTheDocument();
    expect(screen.getByText("2 sources · 1 sub-project")).toBeInTheDocument();
  });

  it("opens the entity drawer for the clicked project", async () => {
    projectsReturn([DERIVED_WIRED]);
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ProjectsPage />
        <StackProbe />
      </>,
    );

    await user.click(await screen.findByText("Helios"));

    expect(screen.getByTestId("open-stack")).toHaveTextContent("p1");
  });

  it("shows the empty state when there are no projects", async () => {
    projectsReturn([]);
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText(/No projects yet/i)).toBeInTheDocument();
  });

  it("renders the Your Org surface with a product tier chip", async () => {
    server.use(
      http.get("/api/products", () =>
        HttpResponse.json({
          products: [{ id: "prod-1", name: "Canvas Copilot", aliases: [], hotness: 3, provenance_tier: "declared" }],
        }),
      ),
    );
    projectsReturn([DERIVED_WIRED]);
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("Your org")).toBeInTheDocument();
    expect(await screen.findByText("Canvas Copilot")).toBeInTheDocument();
    expect(screen.getByText("declared")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add/i })).toBeInTheDocument();
  });
});
