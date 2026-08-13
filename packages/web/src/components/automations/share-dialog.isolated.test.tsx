import { AutomationShareDialog } from "@/components/automations/share-dialog";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

function renderDialog(canShare = true) {
  return renderWithProviders(
    <AutomationShareDialog
      taskId="task-1"
      taskName="Monday revenue summary"
      ownerUserId="u1"
      canShare={canShare}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe("AutomationShareDialog", () => {
  it("lists every org member except the owner", async () => {
    renderDialog();

    expect(await screen.findByText("Bob Jones")).toBeInTheDocument();
    expect(screen.getByText("Carol Davis")).toBeInTheDocument();
    expect(screen.getByText("Dave Evans")).toBeInTheDocument();
    expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument();
  });

  it("filters members by search", async () => {
    const user = userEvent.setup();
    renderDialog();

    await screen.findByText("Bob Jones");
    await user.type(screen.getByLabelText("Search members"), "carol");

    expect(screen.getByText("Carol Davis")).toBeInTheDocument();
    expect(screen.queryByText("Bob Jones")).not.toBeInTheDocument();
    expect(screen.queryByText("Dave Evans")).not.toBeInTheDocument();
  });

  it("grants access optimistically via the member toggle", async () => {
    const grantedUserIds: string[] = [];
    server.use(
      http.put("/api/scheduled-tasks/:id/shares/:userId", ({ params }) => {
        grantedUserIds.push(String(params.userId));
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    const bobSwitch = await screen.findByRole("switch", { name: "Share with Bob Jones" });
    expect(bobSwitch).not.toBeChecked();

    await user.click(bobSwitch);

    await waitFor(() => {
      expect(bobSwitch).toBeChecked();
    });
    await waitFor(() => {
      expect(grantedUserIds).toEqual(["u2"]);
    });
  });

  it("revokes access via the member toggle", async () => {
    const revokedUserIds: string[] = [];
    server.use(
      http.get("/api/scheduled-tasks/:id/shares", () => {
        return HttpResponse.json({
          shares: [
            {
              userId: "u2",
              name: "Bob Jones",
              email: "bob@example.com",
              grantedByUserId: "u1",
              grantedAt: "2026-01-05T00:00:00Z",
            },
          ],
        });
      }),
      http.delete("/api/scheduled-tasks/:id/shares/:userId", ({ params }) => {
        revokedUserIds.push(String(params.userId));
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    const bobSwitch = await screen.findByRole("switch", { name: "Share with Bob Jones" });
    expect(bobSwitch).toBeChecked();

    await user.click(bobSwitch);

    await waitFor(() => {
      expect(bobSwitch).not.toBeChecked();
    });
    await waitFor(() => {
      expect(revokedUserIds).toEqual(["u2"]);
    });
  });

  it("rolls the toggle back and surfaces the error when a grant fails", async () => {
    server.use(
      http.put("/api/scheduled-tasks/:id/shares/:userId", () => {
        return HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "Only the owner can share this automation" } },
          { status: 403 },
        );
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    const bobSwitch = await screen.findByRole("switch", { name: "Share with Bob Jones" });
    await user.click(bobSwitch);

    await waitFor(() => {
      expect(bobSwitch).not.toBeChecked();
    });
    expect(screen.getByText("Only the owner can share this automation")).toBeInTheDocument();
  });

  it("disables the toggles for non-owners", async () => {
    renderDialog(false);

    const bobSwitch = await screen.findByRole("switch", { name: "Share with Bob Jones" });
    expect(bobSwitch).toBeDisabled();
    expect(screen.getByText("Only the owner can change sharing")).toBeInTheDocument();
  });
});
