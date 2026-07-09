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
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useEffect, useRef } from "react";
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

const ATLAS = {
  ...SARAH,
  id: "e-atlas",
  name: "Project Atlas",
  sourceType: "project",
  aliases: [],
  metadata: null,
  profile: {
    ...SARAH.profile,
    entityType: "project",
    domainsForCompany: [],
    crmActivityBrief: null,
    summary: {
      identity: "Project.",
      activity: "Active in 2 files (2 mentions) across 1 day.",
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
    http.get("/api/entities/e-atlas", () => HttpResponse.json({ entity: ATLAS, sourceRefs: [] })),
    http.get("/api/entities/e-sarah/relations", () => HttpResponse.json(relationsForSarah)),
    http.get("/api/entities/e-stripe/relations", () =>
      HttpResponse.json({ outgoing: [], incoming: [], truncated: false, totalCount: 0 }),
    ),
    http.get("/api/entities/e-atlas/relations", () =>
      HttpResponse.json({ outgoing: [], incoming: [], truncated: false, totalCount: 0 }),
    ),
    http.get("/api/entities/e-sarah/timeline", () => HttpResponse.json(emptyTimeline)),
    http.get("/api/entities/e-stripe/timeline", () => HttpResponse.json(emptyTimeline)),
    http.get("/api/entities/e-atlas/timeline", () => HttpResponse.json(emptyTimeline)),
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

/** Opens the drawer exactly once — unlike OpenOnMount it won't re-open after closeAll. */
function OpenOnceHarness({ initialId }: { initialId: string }) {
  return (
    <EntityUiProvider>
      <OpenOnce id={initialId} />
      <EntityDrawer />
    </EntityUiProvider>
  );
}

function OpenOnce({ id }: { id: string }) {
  const { openEntity } = useEntityUi();
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      openEntity(id);
    }
  }, [openEntity, id]);
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

  it("lets an admin delete an entity: confirm fires DELETE and closes the drawer", async () => {
    const user = userEvent.setup();
    let deleted = false;
    server.use(
      http.get("/api/auth/session", () =>
        HttpResponse.json({ authenticated: true, email: "admin@test.com", role: "admin" }),
      ),
      http.delete("/api/entities/e-sarah", () => {
        deleted = true;
        return HttpResponse.json({ success: true });
      }),
    );

    renderWithProviders(<OpenOnceHarness initialId="e-sarah" />);
    await screen.findByRole("heading", { name: /Sarah Chen/ });

    await user.click(await screen.findByRole("button", { name: /Delete/ }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Sarah Chen/ })).not.toBeInTheDocument());
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

  it("renders project tasks and updates Sketch-native task status", async () => {
    const user = userEvent.setup();
    let patchedStatus: string | null = null;
    server.use(
      http.get("/api/entities/e-atlas/tasks", () =>
        HttpResponse.json({
          tasks: [
            {
              id: "task-summary",
              parentEntityId: "e-atlas",
              parentSourceRef: null,
              parentName: "Project Atlas",
              source: "summary",
              externalRef: null,
              title: "Tanush: verify Stripe webhook events hitting staging before cutover green",
              status: "in_progress",
              statusRaw: "action_item",
              statusAuthority: "local",
              assigneeEntityId: "e-tanush",
              assigneeName: "Tanush Yadav",
              proposedAssigneeName: null,
              priority: "medium",
              dueAt: null,
              provenance: "summary",
              sourceTaskId: "summary-1",
              createdByUserId: "u1",
              createdByUserName: "Alice Smith",
              createdByUserEmail: "alice@example.com",
              isOwnedByViewer: true,
              readonlyReason: null,
              completedAt: null,
              updatedAt: "2026-05-01T00:00:00.000Z",
              canEditStatus: true,
            },
            {
              id: "task-admin-monitoring",
              parentEntityId: "e-atlas",
              parentSourceRef: null,
              parentName: "Project Atlas",
              source: "summary",
              externalRef: null,
              title: "Confirm vendor onboarding copy",
              status: "open",
              statusRaw: "action_item",
              statusAuthority: "local",
              assigneeEntityId: "e-vedant",
              assigneeName: "Vedant QA",
              proposedAssigneeName: null,
              priority: "high",
              dueAt: null,
              provenance: "summary",
              sourceTaskId: "summary-2",
              createdByUserId: "u2",
              createdByUserName: "Apeksha Reviewer",
              createdByUserEmail: "apeksha.qa@sketch.local",
              isOwnedByViewer: false,
              readonlyReason: "not_owner",
              completedAt: null,
              updatedAt: "2026-05-01T00:00:00.000Z",
              canEditStatus: false,
            },
            {
              id: "task-external",
              parentEntityId: "e-atlas",
              parentSourceRef: "clickup:list-1",
              parentName: "Project Atlas",
              source: "clickup",
              externalRef: "CU-1",
              title: "Review ClickUp import",
              status: "in_progress",
              statusRaw: "In Review",
              statusAuthority: "external",
              assigneeEntityId: null,
              assigneeName: null,
              proposedAssigneeName: null,
              priority: null,
              dueAt: null,
              provenance: "structural",
              sourceTaskId: "clickup-1",
              createdByUserId: null,
              createdByUserName: null,
              createdByUserEmail: null,
              isOwnedByViewer: false,
              readonlyReason: "external_authority",
              completedAt: null,
              updatedAt: "2026-05-01T00:00:00.000Z",
              canEditStatus: false,
            },
            {
              id: "task-proposed",
              parentEntityId: "e-atlas",
              parentSourceRef: null,
              parentName: "Project Atlas",
              source: "summary",
              externalRef: null,
              title: "Vedant to draft onboarding notes for the new hire",
              status: "open",
              statusRaw: "action_item",
              statusAuthority: "local",
              assigneeEntityId: null,
              assigneeName: null,
              proposedAssigneeName: "Vedant",
              priority: "medium",
              dueAt: null,
              provenance: "summary",
              sourceTaskId: "summary-3",
              createdByUserId: "u2",
              createdByUserName: "Apeksha Reviewer",
              createdByUserEmail: "apeksha.qa@sketch.local",
              isOwnedByViewer: false,
              readonlyReason: "not_owner",
              completedAt: null,
              updatedAt: "2026-05-01T00:00:00.000Z",
              canEditStatus: false,
            },
          ],
        }),
      ),
      http.patch("/api/entities/e-atlas/tasks/task-summary", async ({ request }) => {
        const body = (await request.json()) as { status: string };
        patchedStatus = body.status;
        return HttpResponse.json({
          task: {
            id: "task-summary",
            parentEntityId: "e-atlas",
            parentSourceRef: null,
            parentName: "Project Atlas",
            source: "summary",
            externalRef: null,
            title: "Tanush: verify Stripe webhook events hitting staging before cutover green",
            status: body.status,
            statusRaw: body.status,
            statusAuthority: "local",
            assigneeEntityId: "e-tanush",
            assigneeName: "Tanush Yadav",
            proposedAssigneeName: null,
            priority: "medium",
            dueAt: null,
            provenance: "summary",
            sourceTaskId: "summary-1",
            createdByUserId: "u1",
            createdByUserName: "Alice Smith",
            createdByUserEmail: "alice@example.com",
            isOwnedByViewer: true,
            readonlyReason: null,
            completedAt: body.status === "done" ? "2026-05-02T00:00:00.000Z" : null,
            updatedAt: "2026-05-02T00:00:00.000Z",
            canEditStatus: true,
          },
        });
      }),
    );

    renderWithProviders(<DrawerHarness initialId="e-atlas" />);

    await screen.findByRole("heading", { name: /Project Atlas/ });
    expect(await screen.findByText("Tasks · 4 total · 2 open · 2 in progress · 1 editable")).toBeInTheDocument();
    const editableTask = screen.getByRole("group", {
      name: "Tanush: verify Stripe webhook events hitting staging before cutover green task",
    });
    const assignedReadonlyTask = screen.getByRole("group", { name: "Confirm vendor onboarding copy task" });
    const proposedReadonlyTask = screen.getByRole("group", {
      name: "Vedant to draft onboarding notes for the new hire task",
    });
    expect(
      screen.getByText("Tanush: verify Stripe webhook events hitting staging before cutover green"),
    ).not.toHaveClass("truncate");
    expect(within(editableTask).getAllByText("In progress")).toHaveLength(1);
    expect(screen.getByText("Confirm vendor onboarding copy")).toBeInTheDocument();
    expect(screen.getByText("Review ClickUp import")).toBeInTheDocument();
    expect(screen.getAllByText("From Summarizer")).toHaveLength(3);
    expect(screen.getByText("Assigned to Tanush Yadav")).toBeInTheDocument();
    expect(within(editableTask).getByText("Created by you")).toBeInTheDocument();
    expect(within(assignedReadonlyTask).getByText("Assigned to Vedant QA")).toBeInTheDocument();
    expect(within(assignedReadonlyTask).getByText("Created by Apeksha Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Vedant to draft onboarding notes for the new hire")).toBeInTheDocument();
    expect(within(proposedReadonlyTask).getByText("Needs assignee")).toBeInTheDocument();
    expect(within(proposedReadonlyTask).getByText("Mentioned: Vedant")).toBeInTheDocument();
    expect(within(proposedReadonlyTask).getByText("Created by Apeksha Reviewer")).toBeInTheDocument();
    expect(screen.queryByText("Assigned to Vedant")).not.toBeInTheDocument();
    expect(screen.queryByText("Owned by you")).not.toBeInTheDocument();
    expect(screen.queryByText("Owned by Vedant QA")).not.toBeInTheDocument();
    expect(within(assignedReadonlyTask).getByText("Read-only for you")).toBeInTheDocument();
    expect(within(proposedReadonlyTask).getByText("Read-only for you")).toBeInTheDocument();
    expect(
      within(proposedReadonlyTask).getByText(
        "Admins can monitor this task. Only the creator or assignee can update status.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Managed in ClickUp")).toBeInTheDocument();
    expect(screen.getByText("External status: In Review")).toBeInTheDocument();
    expect(screen.getByText("In Review")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getAllByText("In progress")).toHaveLength(2);
    expect(screen.queryByText("action_item")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /Tanush: verify Stripe webhook events/ }));
    await user.click(await screen.findByRole("option", { name: "Done" }));

    await waitFor(() => expect(patchedStatus).toBe("done"));
  });

  it("renders a stable empty task state for projects", async () => {
    renderWithProviders(<DrawerHarness initialId="e-atlas" />);

    await screen.findByRole("heading", { name: /Project Atlas/ });

    expect(await screen.findByText("No project tasks yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Summarizer action items will appear here when they are linked to this project."),
    ).toBeInTheDocument();
  });
});
