import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { AddEntityDialog } from "./add-entity-dialog";

describe("AddEntityDialog aliases", () => {
  let lastBody: Record<string, unknown> | null;

  beforeEach(() => {
    lastBody = null;
    server.use(
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
