import type { EntityListItem } from "@/lib/api";
import { useEntityUi } from "@/lib/entity-ui";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectsPage } from "./index";

function entity(
  overrides: Partial<EntityListItem> & Pick<EntityListItem, "id" | "name" | "sourceType">,
): EntityListItem {
  return {
    subtype: null,
    aliases: [],
    metadata: null,
    status: "confirmed",
    hotness: 1,
    mentionCount: 0,
    lastMentionAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const PERSON = entity({
  id: "person-1",
  name: "Mira Shah",
  sourceType: "person",
  subtype: "internal",
  metadata: { email: "mira@example.com", role: "Engineer" },
  mentionCount: 12,
});
const COMPANY = entity({ id: "company-1", name: "Acme", sourceType: "company", subtype: "internal" });
const PROJECT = entity({ id: "project-1", name: "Atlas Rollout", sourceType: "project" });
const TOOL = entity({ id: "tool-1", name: "Figma", sourceType: "tool" });
const SEARCHED_PERSON = entity({ id: "person-2", name: "Zara Khan", sourceType: "person" });

const ENTITIES: Record<string, EntityListItem[]> = {
  person: [PERSON],
  company: [COMPANY],
  team: [],
  project: [PROJECT],
  product: [],
  tool: [TOOL],
};

function StackProbe() {
  const ui = useEntityUi();
  return <div data-testid="open-stack">{ui.stack.join(",")}</div>;
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    server.use(
      http.get("/api/entities/graph", () =>
        HttpResponse.json({
          nodes: [
            { id: PERSON.id, name: PERSON.name, sourceType: PERSON.sourceType, hotness: PERSON.hotness },
            { id: COMPANY.id, name: COMPANY.name, sourceType: COMPANY.sourceType, hotness: COMPANY.hotness },
          ],
          edges: [{ source: PERSON.id, target: COMPANY.id, type: "works_at" }],
        }),
      ),
      http.get("/api/entities", ({ request }) => {
        const type = new URL(request.url).searchParams.get("type") ?? "";
        const entities = ENTITIES[type] ?? [];
        return HttpResponse.json({ entities, total: entities.length });
      }),
      http.get("/api/products", () =>
        HttpResponse.json({
          products: [
            {
              id: "product-1",
              name: "Canvas Copilot",
              aliases: [],
              hotness: 0,
              provenance_tier: "declared",
            },
          ],
        }),
      ),
    );
  });

  it("renders the company-grouped People directory with real contact metadata", async () => {
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("Your Org")).toBeInTheDocument();
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Mira Shah")).toBeInTheDocument();
    expect(screen.getByText("mira@example.com")).toBeInTheDocument();
    expect(screen.getByText("Engineer · Internal")).toBeInTheDocument();
  });

  it("sends People searches to the server", async () => {
    const requestedSearches: Array<string | null> = [];
    server.use(
      http.get("/api/entities", ({ request }) => {
        const url = new URL(request.url);
        const type = url.searchParams.get("type") ?? "";
        if (type !== "person") {
          const entities = ENTITIES[type] ?? [];
          return HttpResponse.json({ entities, total: entities.length });
        }
        const search = url.searchParams.get("search");
        requestedSearches.push(search);
        const entities = search === "zara" ? [SEARCHED_PERSON] : [PERSON];
        return HttpResponse.json({ entities, total: entities.length });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await user.type(await screen.findByPlaceholderText("Search people…"), "Zara");

    expect(await screen.findByText("Zara Khan")).toBeInTheDocument();
    expect(requestedSearches).toContain("zara");
  });

  it("opens entity rows from type tabs in the shared drawer", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ProjectsPage />
        <StackProbe />
      </>,
    );

    await user.click(await screen.findByRole("button", { name: /^Projects/ }));
    await user.click(await screen.findByText("Atlas Rollout"));

    expect(screen.getByTestId("open-stack")).toHaveTextContent("project-1");
  });

  it("keeps curated products separate from tracked tools", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await user.click(await screen.findByRole("button", { name: /^Products/ }));

    expect(await screen.findByText("Canvas Copilot")).toBeInTheDocument();
    expect(screen.getByText("declared")).toBeInTheDocument();
    expect(screen.getByText("Figma")).toBeInTheDocument();
  });

  it("uses the active tab as the Add dialog's default entity type", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await user.click(await screen.findByRole("button", { name: /^Companies/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("button", { name: "company" })).toHaveAttribute("data-variant", "default");
  });

  it("can render the review tab directly for legacy deep links", async () => {
    renderWithProviders(<ProjectsPage activeTab="review" />);

    expect(await screen.findByPlaceholderText("Search the review queue…")).toBeInTheDocument();
    expect(await screen.findByText(/Nothing waiting\./)).toBeInTheDocument();
  });
});
