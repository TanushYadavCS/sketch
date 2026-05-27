/**
 * EntityDrawer contract:
 *  - renders sections in order: AI Brief (What), Identity, Relationships
 *  - pins AMBIGUOUS relationships into a "Needs review" group above the main list
 *  - stacked navigation: clicking a related entity pill pushes a new drawer level and
 *    shows a Back chip with the previous entity's name
 */
import { EntityUiProvider, useEntityUi } from "@/lib/entity-ui";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EntityDrawer } from "./entity-drawer";

const SARAH = {
  id: "e-sarah",
  name: "Sarah Chen",
  sourceType: "person",
  subtype: null,
  aliases: [],
  metadata: { role: "Engineer" },
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
    aiBrief: {
      what: "Person · Engineer at Stripe · 5 mentions across 1 source · last seen 1 month ago",
      signal: null,
      soWhat: null,
      generatedAt: null,
      stale: false,
    },
  },
};

const STRIPE = {
  ...SARAH,
  id: "e-stripe",
  name: "Stripe",
  sourceType: "company",
  metadata: null,
  profile: {
    ...SARAH.profile,
    entityType: "company",
    aiBrief: { ...SARAH.profile.aiBrief, what: "Company · stripe.com · 4 people · 5 mentions · last seen today" },
  },
};

const relationsForSarah = {
  outgoing: [
    {
      id: "rel-1",
      sourceEntityId: "e-sarah",
      targetEntityId: "e-stripe",
      relationshipType: "works_at",
      confidence: "AMBIGUOUS",
      confidenceScore: 0.4,
      source: "llm_relation",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: null,
      other: { id: "e-stripe", name: "Stripe", sourceType: "company", aliases: [] },
      evidenceCount: 3,
    },
    {
      id: "rel-2",
      sourceEntityId: "e-sarah",
      targetEntityId: "e-atlas",
      relationshipType: "leads",
      confidence: "EXTRACTED",
      confidenceScore: 0.95,
      source: "llm_relation",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: null,
      other: { id: "e-atlas", name: "Project Atlas", sourceType: "project", aliases: [] },
      evidenceCount: 7,
    },
  ],
  incoming: [],
  truncated: false,
  totalCount: 2,
};

const handlers = [
  http.get("/api/entities/e-sarah", () => HttpResponse.json({ entity: SARAH, sourceRefs: [] })),
  http.get("/api/entities/e-stripe", () => HttpResponse.json({ entity: STRIPE, sourceRefs: [] })),
  http.get("/api/entities/e-sarah/relations", () => HttpResponse.json(relationsForSarah)),
  http.get("/api/entities/e-sarah/relations/rel-2/evidence", () =>
    HttpResponse.json({
      rows: [
        {
          fileId: "file-1",
          fileName: "Planning doc",
          sourceType: "google_drive",
          occurredAt: "2026-05-01T00:00:00.000Z",
          chunkIndex: 0,
          contextSnippet: "Sarah leads Project Atlas.",
          sourceFactId: null,
          note: null,
        },
      ],
      visibleCount: 3,
      totalCount: 3,
      truncated: true,
    }),
  ),
  http.get("/api/entities/e-stripe/relations", () =>
    HttpResponse.json({ outgoing: [], incoming: [], truncated: false, totalCount: 0 }),
  ),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function DrawerHarness({ initialId }: { initialId: string }) {
  return (
    <EntityUiProvider>
      <OpenOnMount id={initialId} />
      <EntityDrawer />
    </EntityUiProvider>
  );
}

function OpenOnMount({ id }: { id: string }) {
  const ui = useEntityUi();
  if (ui.stack.length === 0) ui.openEntity(id);
  return null;
}

describe("EntityDrawer", () => {
  it("renders sections in order: What → Identity → Relationships, with AMBIGUOUS pinned", async () => {
    renderWithProviders(<DrawerHarness initialId="e-sarah" />);

    await screen.findByText(/Person · Engineer at Stripe/);

    const sections = screen.getAllByRole("region", { hidden: true });
    // Headings within the drawer:
    expect(screen.getByRole("heading", { name: /Sarah Chen/ })).toBeInTheDocument();
    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByText("Relationships")).toBeInTheDocument();

    const needsReview = await screen.findByText(/Needs review/i);
    expect(needsReview).toBeInTheDocument();

    // The AMBIGUOUS row (works_at → Stripe) should appear before the EXTRACTED row in DOM order.
    const stripeRow = (await screen.findAllByText("Stripe"))[0];
    const atlasRow = await screen.findByText("Project Atlas");
    expect(stripeRow.compareDocumentPosition(atlasRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("pushes a stacked drawer when a related entity is clicked and shows a Back chip", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrawerHarness initialId="e-sarah" />);

    await screen.findByText(/Person · Engineer at Stripe/);
    const stripeButtons = await screen.findAllByText("Stripe");
    // Click the related-entity pill (the clickable one inside the relationships row).
    const clickable = stripeButtons.find((el) => el.tagName === "BUTTON");
    if (!clickable) throw new Error("expected a clickable Stripe button");
    await user.click(clickable);

    await waitFor(() => {
      expect(screen.getByText(/Back to Sarah Chen/i)).toBeInTheDocument();
    });
  });

  it("surfaces when visible evidence rows are truncated", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrawerHarness initialId="e-sarah" />);

    await screen.findByText(/Person · Engineer at Stripe/);
    await user.click(await screen.findByText("leads"));

    expect(await screen.findByText("+2 more visible evidence rows")).toBeInTheDocument();
  });
});
