import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { EntityPicker } from "./entity-picker";

describe("EntityPicker", () => {
  it("hits /api/entities?type=person&search=<q> on input", async () => {
    const user = userEvent.setup();
    let lastUrl = "";
    server.use(
      http.get("/api/entities", ({ request }) => {
        lastUrl = request.url;
        return HttpResponse.json({
          entities: [
            {
              id: "e1",
              name: "Simran Suri",
              sourceType: "person",
              subtype: null,
              aliases: [],
              metadata: { email: "simran@acme.com" },
              status: "confirmed",
              hotness: 0,
              mentionCount: 0,
              lastMentionAt: null,
              createdAt: "2025-01-01",
              updatedAt: "2025-01-01",
            },
          ],
          total: 1,
        });
      }),
    );

    renderWithProviders(<EntityPicker entityType="person" onPick={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /entity search/i }), "simr");

    await waitFor(() => {
      expect(lastUrl).toContain("type=person");
      expect(lastUrl).toContain("search=simr");
    });
    expect(await screen.findByText("Simran Suri")).toBeInTheDocument();
  });

  it("calls onPick with the entity id when a result is selected", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    server.use(
      http.get("/api/entities", () =>
        HttpResponse.json({
          entities: [
            {
              id: "e1",
              name: "Simran Suri",
              sourceType: "person",
              subtype: null,
              aliases: [],
              metadata: null,
              status: "confirmed",
              hotness: 0,
              mentionCount: 0,
              lastMentionAt: null,
              createdAt: "x",
              updatedAt: "x",
            },
          ],
          total: 1,
        }),
      ),
    );

    renderWithProviders(<EntityPicker entityType="person" onPick={onPick} />);
    await user.type(screen.getByRole("textbox", { name: /entity search/i }), "simr");
    const option = await screen.findByRole("button", { name: /Simran Suri/i });
    await user.click(option);
    expect(onPick).toHaveBeenCalledWith("e1");
  });
});
