import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { EntityMergeDialog } from "./entity-merge-dialog";

const ME = { id: "e1", name: "Acme", sourceType: "company" };
const OTHER = { id: "e2", name: "Acme Inc" };

function pickerReturns(entity: { id: string; name: string }) {
  server.use(
    http.get("/api/entities", () =>
      HttpResponse.json({
        entities: [
          {
            id: entity.id,
            name: entity.name,
            sourceType: "company",
            subtype: null,
            aliases: [],
            metadata: {},
            status: "confirmed",
            hotness: 0,
            mentionCount: 0,
            lastMentionAt: null,
            createdAt: "2025-01-01",
            updatedAt: "2025-01-01",
          },
        ],
        total: 1,
      }),
    ),
    http.get(`/api/entities/${entity.id}`, () =>
      HttpResponse.json({ entity: { id: entity.id, name: entity.name, sourceType: "company" }, sourceRefs: [] }),
    ),
  );
}

function preview(counts: Partial<Record<string, number>>) {
  server.use(
    http.get("/api/entities/:id/merge-preview", () =>
      HttpResponse.json({
        survivorId: "s",
        loserId: "l",
        counts: {
          sourceRefs: 0,
          mentions: 0,
          relationships: 0,
          contactPoints: 0,
          shareEmails: 0,
          aliasRejections: 0,
          domains: 0,
          candidates: 0,
          reviewQueue: 0,
          ...counts,
        },
        collisions: { mentions: 0, contactPoints: 0, shareEmails: 0, aliasRejections: 0, domains: 0, relationships: 0 },
        selfLoopsDropped: 0,
      }),
    ),
  );
}

function renderDialog() {
  renderWithProviders(
    <EntityMergeDialog
      entityId={ME.id}
      entityName={ME.name}
      sourceType={ME.sourceType}
      open={true}
      onOpenChange={vi.fn()}
    />,
  );
}

async function pickOther(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByRole("textbox", { name: /entity search/i }), "acme");
  await user.click(await screen.findByText(OTHER.name));
}

describe("EntityMergeDialog", () => {
  it("previews what moves after picking the other entity", async () => {
    pickerReturns(OTHER);
    preview({ mentions: 4, relationships: 1 });
    const user = userEvent.setup();
    renderDialog();

    await pickOther(user);

    expect(await screen.findByTestId("merge-summary")).toHaveTextContent("5 records move onto the survivor");
  });

  it("confirms the merge with the chosen survivor and loser", async () => {
    pickerReturns(OTHER);
    preview({ mentions: 1 });
    let body: { survivorId?: string; loserId?: string } | null = null;
    server.use(
      http.post("/api/entities/merges", async ({ request }) => {
        body = (await request.json()) as { survivorId?: string; loserId?: string };
        return HttpResponse.json({ mergeId: "m1" });
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await pickOther(user);
    await user.click(await screen.findByRole("button", { name: "Confirm merge" }));

    await waitFor(() => {
      expect(body).toEqual({ survivorId: "e1", loserId: "e2" });
    });
  });

  it("flips the merge direction when the survivor is toggled", async () => {
    pickerReturns(OTHER);
    preview({ mentions: 1 });
    const user = userEvent.setup();
    renderDialog();

    await pickOther(user);
    expect(await screen.findByTestId("merge-direction")).toHaveTextContent("Merging Acme Inc into Acme");

    await user.click(screen.getByRole("button", { name: OTHER.name }));

    await waitFor(() => {
      expect(screen.getByTestId("merge-direction")).toHaveTextContent("Merging Acme into Acme Inc");
    });
  });
});
