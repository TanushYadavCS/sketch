import { renderWithProviders } from "@/test/utils";
import { screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentVariablesSection, ShareEnvironmentVariableDialog } from "./environment-variables-section";

const variable = {
  id: "env-1",
  ownerUserId: "u1",
  name: "API_TOKEN",
  value: null,
  isSecret: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  shares: [],
};

function renderDialog(props: Partial<ComponentProps<typeof ShareEnvironmentVariableDialog>> = {}) {
  return renderWithProviders(
    <ShareEnvironmentVariableDialog
      variable={variable}
      users={[]}
      usersLoading={false}
      slackChannels={[]}
      whatsappGroups={[]}
      currentUserId="u1"
      isAdmin={false}
      slackChannelsLoading={false}
      slackChannelsUnavailable={false}
      whatsappGroupsLoading={false}
      onOpenChange={vi.fn()}
      onSuccess={vi.fn()}
      {...props}
    />,
  );
}

describe("ShareEnvironmentVariableDialog", () => {
  it("shows skeleton placeholders while Slack channels load", async () => {
    renderDialog({ slackChannelsLoading: true });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading Slack channels")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThanOrEqual(3);
  });

  it("shows skeleton placeholders while users load", async () => {
    renderDialog({ usersLoading: true });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading users")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThanOrEqual(3);
  });

  it("shows skeleton placeholders while WhatsApp groups load", async () => {
    renderDialog({ whatsappGroupsLoading: true });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading WhatsApp groups")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThanOrEqual(3);
  });

  it("shows Slack channel names without exposing channel IDs", async () => {
    renderDialog({
      slackChannels: [{ id: "C05JK4ZK7M5", name: "engineering", type: "public_channel", isMember: true }],
    });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("#engineering")).toBeInTheDocument();
    expect(screen.queryByText("C05JK4ZK7M5")).not.toBeInTheDocument();
  });

  it("shows WhatsApp group names without exposing group JIDs", async () => {
    renderDialog({
      whatsappGroups: [
        {
          jid: "12025550123-123@g.us",
          name: "Ops escalation",
          description: null,
          agent_user_id: null,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Ops escalation")).toBeInTheDocument();
    expect(screen.queryByText("12025550123-123@g.us")).not.toBeInTheDocument();
  });

  it("does not fall back to user IDs when a user has no email", async () => {
    renderDialog({
      users: [
        {
          id: "user-internal-id",
          name: "No Email User",
          email: null,
          email_verified_at: null,
          auth_role: "member",
          slack_user_id: null,
          whatsapp_number: null,
          description: null,
          type: "human",
          role: null,
          reports_to: null,
          allowed_tools: null,
          slack_channel_ids: [],
          whatsapp_group_jids: [],
          is_whatsapp_fallback: false,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("No Email User")).toBeInTheDocument();
    expect(screen.queryByText("user-internal-id")).not.toBeInTheDocument();
  });
});

describe("EnvironmentVariablesSection", () => {
  it("shows direct share count on the share button instead of row summary pills", () => {
    renderWithProviders(
      <EnvironmentVariablesSection
        variables={[
          {
            ...variable,
            shares: [
              {
                id: "share-user",
                targetType: "user",
                targetId: "u2",
                targetLabel: "Alice",
                targetSecondaryLabel: "alice@example.com",
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "share-slack",
                targetType: "slack_channel",
                targetId: "C123",
                targetLabel: "#engineering",
                targetSecondaryLabel: "C123",
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "share-whatsapp",
                targetType: "whatsapp_group",
                targetId: "group@g.us",
                targetLabel: "Ops group",
                targetSecondaryLabel: "group@g.us",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        ]}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onShare={vi.fn()}
      />,
    );

    const shareButton = screen.getByRole("button", { name: "Share API_TOKEN (3 direct shares)" });

    expect(within(shareButton).getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("1 user")).not.toBeInTheDocument();
    expect(screen.queryByText("#engineering")).not.toBeInTheDocument();
    expect(screen.queryByText("WhatsApp: Ops group")).not.toBeInTheDocument();
  });

  it("shows all on the share button when the variable is shared with the entire org", () => {
    renderWithProviders(
      <EnvironmentVariablesSection
        variables={[
          {
            ...variable,
            shares: [
              {
                id: "share-org",
                targetType: "org",
                targetId: "default",
                targetLabel: "Entire org",
                targetSecondaryLabel: null,
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        ]}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onShare={vi.fn()}
      />,
    );

    const shareButton = screen.getByRole("button", { name: "Share API_TOKEN (shared with entire org)" });

    expect(within(shareButton).getByText("All")).toBeInTheDocument();
    expect(screen.queryByText("Org")).not.toBeInTheDocument();
  });
});
