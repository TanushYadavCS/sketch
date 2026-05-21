import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { SidebarReviewCount } from "./sidebar-review-count";

describe("SidebarReviewCount", () => {
  it("renders nothing when disabled", () => {
    renderWithProviders(<SidebarReviewCount enabled={false} />);
    expect(screen.queryByTestId("review-count-badge")).not.toBeInTheDocument();
  });

  it("renders the count when enabled and total > 0", async () => {
    server.use(http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 5 })));
    renderWithProviders(<SidebarReviewCount enabled={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("review-count-badge")).toHaveTextContent("5");
    });
  });

  it("renders nothing when total is 0", async () => {
    server.use(http.get("/api/entity-review", () => HttpResponse.json({ rows: [], total: 0 })));
    renderWithProviders(<SidebarReviewCount enabled={true} />);
    // Wait a tick for the query to resolve.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("review-count-badge")).not.toBeInTheDocument();
  });

  it("renders nothing on API error", async () => {
    server.use(http.get("/api/entity-review", () => new HttpResponse(null, { status: 500 })));
    renderWithProviders(<SidebarReviewCount enabled={true} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("review-count-badge")).not.toBeInTheDocument();
  });
});
