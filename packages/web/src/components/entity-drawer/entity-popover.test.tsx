/**
 * EntityPopover contract:
 *  - openEntity(id, { mode: "popover" }) mounts the popover
 *  - clicking "Open in drawer →" transitions the same entity into the drawer
 *    (mode flips from popover → drawer; stack length stays 1)
 */
import { EntityUiProvider, useEntityUi } from "@/lib/entity-ui";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EntityDrawer } from "./entity-drawer";
import { EntityPopover } from "./entity-popover";

const SARAH = {
  id: "e-sarah",
  name: "Sarah Chen",
  sourceType: "person",
  subtype: null,
  aliases: [],
  metadata: null,
  status: "confirmed",
  hotness: 0,
  mentionCount: 5,
  lastMentionAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  profile: {
    entityType: "person",
    mentionCount: 5,
    sourceCounts: { google_drive: 5 },
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-05-01T00:00:00.000Z",
    domainsForCompany: [],
    summary: {
      identity: "Person · works at Stripe.",
      activity: "Active in 5 files (5 mentions).",
    },
  },
};

const relations = {
  outgoing: [
    {
      id: "rel-1",
      sourceEntityId: "e-sarah",
      targetEntityId: "e-stripe",
      relationshipType: "works_at",
      confidence: "EXTRACTED",
      confidenceScore: 0.95,
      source: "llm_relation",
      validFrom: null,
      validTo: null,
      other: { id: "e-stripe", name: "Stripe", sourceType: "company", aliases: [] },
      evidenceCount: 3,
    },
  ],
  incoming: [],
  truncated: false,
  totalCount: 1,
};

const server = setupServer(
  http.get("/api/entities/e-sarah", () => HttpResponse.json({ entity: SARAH, sourceRefs: [] })),
  http.get("/api/entities/e-sarah/relations", () => HttpResponse.json(relations)),
  http.get("/api/entities/e-sarah/timeline", () => HttpResponse.json({ groups: [], truncated: false, totalCount: 0 })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function OpenAsPopover() {
  const ui = useEntityUi();
  if (ui.stack.length === 0) ui.openEntity("e-sarah", { mode: "popover" });
  return null;
}

function Harness() {
  return (
    <EntityUiProvider>
      <OpenAsPopover />
      <EntityPopover />
      <EntityDrawer />
    </EntityUiProvider>
  );
}

describe("EntityPopover", () => {
  it("mounts as a peek surface and transitions to drawer when 'Open in drawer' is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await screen.findByText(/Person · works at Stripe\./);
    expect(screen.getByRole("button", { name: /Open in drawer/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open in drawer/ }));

    await waitFor(() => {
      // Drawer renders the Summary block + tabs; popover does not.
      expect(screen.getByText("Summary")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Relationships/ })).toBeInTheDocument();
    });
  });
});
