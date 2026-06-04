/**
 * EntityDrawer contract:
 *  - header carries identity flags (role/email/domains/aliases) inline, plus last-seen.
 *  - Summary block lazy-loads the Gemini narrative; renders the WHAT line as a fallback
 *    when no cached brief exists.
 *  - Timeline and Relationships are tabs; Timeline is the default; switching surfaces
 *    the Relationships pane with AMBIGUOUS pinned to the top.
 *  - clicking a related entity pill pushes a new drawer level and shows a Back chip.
 */
import { EntityUiProvider, useEntityUi } from "@/lib/entity-ui";
import { server } from "@/test/msw";
import { renderWithProviders } from "@/test/utils";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { EntityDrawer } from "./entity-drawer";

const SARAH = {
  id: "e-sarah",
  name: "Sarah Chen",
  sourceType: "person",
  subtype: null,
  aliases: ["S. Chen"],
  metadata: { role: "Engineer", email: "sarah@stripe.com" },
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
    crmActivityBrief: null,
    summary: {
      identity: "Person · Engineer · works at Stripe (sarah@stripe.com). Engaged with Acme.",
      activity: "Active in 5 files (5 mentions) across 3 days. Most-frequent collaborators: Ada Lovelace.",
    },
  },
};

const STRIPE = {
  ...SARAH,
  id: "e-stripe",
  name: "Stripe",
  sourceType: "company",
  aliases: [],
  metadata: null,
  profile: {
    ...SARAH.profile,
    entityType: "company",
    domainsForCompany: [{ domain: "stripe.com", confidence: 0.95, isPrimary: true }],
    crmActivityBrief: {
      summary: "Recent CRM activity focused on renewal follow-ups and stakeholder alignment.",
      activityCount: 47,
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
    summary: {
      identity: "Company · stripe.com.",
      activity: "Active in 5 files (5 mentions) across 3 days.",
    },
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

const emptyTimeline = { groups: [], truncated: false, totalCount: 0 };

beforeEach(() => {
  server.use(
    http.get("/api/entities/e-sarah", () => HttpResponse.json({ entity: SARAH, sourceRefs: [] })),
    http.get("/api/entities/e-stripe", () => HttpResponse.json({ entity: STRIPE, sourceRefs: [] })),
    http.get("/api/entities/e-sarah/relations", () => HttpResponse.json(relationsForSarah)),
    http.get("/api/entities/e-stripe/relations", () =>
      HttpResponse.json({ outgoing: [], incoming: [], truncated: false, totalCount: 0 }),
    ),
    http.get("/api/entities/e-sarah/timeline", () => HttpResponse.json(emptyTimeline)),
    http.get("/api/entities/e-stripe/timeline", () => HttpResponse.json(emptyTimeline)),
  );
});

function DrawerHarness({ initialId }: { initialId: string }) {
  return (
    <EntityUiProvider>
      <OpenOnMount id={initialId} />
      <EntityDrawer />
    </EntityUiProvider>
  );
}

function OpenOnMount({ id }: { id: string }) {
  const { stack, openEntity } = useEntityUi();
  useEffect(() => {
    if (stack.length === 0) openEntity(id);
  }, [stack, openEntity, id]);
  return null;
}

describe("EntityDrawer", () => {
  it("renders header with identity chips and deterministic Summary block, Timeline as default tab", async () => {
    renderWithProviders(<DrawerHarness initialId="e-sarah" />);

    await screen.findByRole("heading", { name: /Sarah Chen/ });

    // Identity flags appear inline in the header.
    expect(screen.getByText("Engineer")).toBeInTheDocument();
    expect(screen.getByText("sarah@stripe.com")).toBeInTheDocument();
    expect(screen.getByText(/Also: S\. Chen/)).toBeInTheDocument();

    // Summary renders identity + activity sentences directly (no LLM, no shimmer).
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText(/works at Stripe/)).toBeInTheDocument();
    expect(screen.getByText(/Active in 5 files/)).toBeInTheDocument();

    // Tabs visible; Timeline default.
    expect(screen.getByRole("button", { name: /Timeline/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Relationships/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No file mentions yet/i)).toBeInTheDocument());

    // Removed surfaces.
    expect(screen.queryByText("Identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Source IDs")).not.toBeInTheDocument();
    expect(screen.queryByText("Signal")).not.toBeInTheDocument();
    expect(screen.queryByText("So what")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh summary/)).not.toBeInTheDocument();
  });

  it("switches to the Relationships tab and pins AMBIGUOUS to the top", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrawerHarness initialId="e-sarah" />);
    await screen.findByRole("heading", { name: /Sarah Chen/ });

    await user.click(screen.getByRole("button", { name: /Relationships/ }));

    const needsReview = await screen.findByText(/Needs review/i);
    expect(needsReview).toBeInTheDocument();

    const stripeRow = (await screen.findAllByText("Stripe"))[0];
    const atlasRow = await screen.findByText("Project Atlas");
    expect(stripeRow.compareDocumentPosition(atlasRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("pushes a stacked drawer when a related entity is clicked and shows a Back chip", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrawerHarness initialId="e-sarah" />);

    await screen.findByRole("heading", { name: /Sarah Chen/ });
    await user.click(screen.getByRole("button", { name: /Relationships/ }));

    const stripeButtons = await screen.findAllByText("Stripe");
    const clickable = stripeButtons.find((el) => el.tagName === "BUTTON");
    if (!clickable) throw new Error("expected a clickable Stripe button");
    await user.click(clickable);

    await waitFor(() => {
      expect(screen.getByText(/Back to Sarah Chen/i)).toBeInTheDocument();
    });
  });

  it("renders the company variant: primary domain chip in header, deterministic summary in body", async () => {
    renderWithProviders(<DrawerHarness initialId="e-stripe" />);
    await screen.findByRole("heading", { name: /Stripe/ });
    expect(screen.getByText(/stripe\.com · primary/)).toBeInTheDocument();
    expect(screen.getByText(/Company · stripe\.com\./)).toBeInTheDocument();
    expect(screen.getByText("CRM Activity")).toBeInTheDocument();
    expect(screen.getByText(/Recent CRM activity focused on renewal follow-ups/)).toBeInTheDocument();
    expect(screen.getByText(/47 activities · updated/)).toBeInTheDocument();
  });
});
