import { useEntityUi } from "@/lib/entity-ui";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddEntityDialog } from "./add-entity-dialog";

function DrawerStackProbe() {
  const { stack } = useEntityUi();
  return <div data-testid="drawer-stack">{stack.join(",")}</div>;
}

describe("AddEntityDialog aliases", () => {
  let lastBody: Record<string, unknown> | null;

  beforeEach(() => {
    lastBody = null;
    server.use(
      http.get("/api/entities", () => HttpResponse.json({ entities: [], total: 0 })),
      http.post("/api/entities", async ({ request }) => {
        lastBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          entity: {
            id: "e-1",
            name: lastBody.name,
            sourceType: lastBody.sourceType,
            subtype: null,
            status: "confirmed",
            aliases: [],
          },
        });
      }),
    );
  });

  it("sends trimmed comma-separated aliases with the create request", async () => {
    renderWithProviders(<AddEntityDialog open onOpenChange={() => {}} defaultType="company" />);
    await userEvent.type(screen.getByPlaceholderText("e.g. CanvasX, Epik, Product Alpha"), "One Stop AI");
    await userEvent.type(screen.getByPlaceholderText("e.g. One Stop, OSAI"), " One Stop , OSAI ,, ");
    await userEvent.click(screen.getByRole("button", { name: "Create entity" }));
    await waitFor(() => expect(lastBody).not.toBeNull());
    expect(lastBody).toMatchObject({ name: "One Stop AI", sourceType: "company", aliases: ["One Stop", "OSAI"] });
  });

  it("omits the aliases key entirely when the field is left empty", async () => {
    renderWithProviders(<AddEntityDialog open onOpenChange={() => {}} defaultType="company" />);
    await userEvent.type(screen.getByPlaceholderText("e.g. CanvasX, Epik, Product Alpha"), "Bare Co");
    await userEvent.click(screen.getByRole("button", { name: "Create entity" }));
    await waitFor(() => expect(lastBody).not.toBeNull());
    expect(lastBody).not.toBeNull();
    expect("aliases" in (lastBody as Record<string, unknown>)).toBe(false);
  });

  it("hides the aliases field for products, whose declare path takes no aliases", async () => {
    renderWithProviders(<AddEntityDialog open onOpenChange={() => {}} defaultType="product" />);
    expect(screen.queryByPlaceholderText("e.g. One Stop, OSAI")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "company" }));
    expect(screen.getByPlaceholderText("e.g. One Stop, OSAI")).toBeInTheDocument();
  });
});

describe("AddEntityDialog similar-name check", () => {
  let postCount: number;

  beforeEach(() => {
    postCount = 0;
    server.use(
      http.get("/api/entities", ({ request }) => {
        const search = new URL(request.url).searchParams.get("search") ?? "";
        if ("One Stop AI".toLowerCase().includes(search.toLowerCase()) && search.length > 0) {
          return HttpResponse.json({
            entities: [
              {
                id: "existing-1",
                name: "One Stop AI",
                sourceType: "company",
                aliases: ["OSAI"],
              },
            ],
            total: 1,
          });
        }
        return HttpResponse.json({ entities: [], total: 0 });
      }),
      http.post("/api/entities", async ({ request }) => {
        postCount += 1;
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ entity: { id: "e-new", name: body.name, sourceType: body.sourceType } });
      }),
    );
  });

  it("surfaces a close existing entity as the name is typed", async () => {
    renderWithProviders(<AddEntityDialog open onOpenChange={() => {}} defaultType="company" />);
    await userEvent.type(screen.getByPlaceholderText("e.g. CanvasX, Epik, Product Alpha"), "One Stop");
    expect(await screen.findByText("Similar existing entities")).toBeInTheDocument();
    expect(screen.getByText("One Stop AI")).toBeInTheDocument();
    expect(screen.getByText("OSAI")).toBeInTheDocument();
  });

  it("open existing closes the dialog without creating anything", async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(
      <>
        <AddEntityDialog open onOpenChange={onOpenChange} defaultType="company" />
        <DrawerStackProbe />
      </>,
    );
    await userEvent.type(screen.getByPlaceholderText("e.g. CanvasX, Epik, Product Alpha"), "One Stop");
    await userEvent.click(await screen.findByRole("button", { name: "Open existing" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("drawer-stack")).toHaveTextContent("existing-1");
    expect(postCount).toBe(0);
  });

  it("shows nothing on no match and create opens the new entity in the drawer", async () => {
    renderWithProviders(
      <>
        <AddEntityDialog open onOpenChange={() => {}} defaultType="company" />
        <DrawerStackProbe />
      </>,
    );
    await userEvent.type(screen.getByPlaceholderText("e.g. CanvasX, Epik, Product Alpha"), "Fresh Co");
    await waitFor(() => expect(screen.queryByText("Similar existing entities")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Create entity" }));
    await waitFor(() => expect(postCount).toBe(1));
    await waitFor(() => expect(screen.getByTestId("drawer-stack")).toHaveTextContent("e-new"));
  });
});
