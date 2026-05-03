/**
 * Slack App Home tab view builder.
 *
 * Renders Block Kit JSON for the App Home tab. The view shows the user's
 * connected identity, exposes per-user progress settings as static_select
 * dropdowns (replacing /toolprogress and /reasoningtext slash commands
 * inside the Home tab surface), and lists how to start using sketch.
 *
 * Each dropdown uses a bare `home:<setting>` action_id; the chosen value
 * arrives via the static_select's `selected_option.value` payload, which
 * the adapter routes back to the same `users.update` calls slash commands
 * use elsewhere.
 */
import {
  REASONING_TEXT_LABELS,
  REASONING_TEXT_OPTIONS,
  TOOL_PROGRESS_LABELS,
  TOOL_PROGRESS_OPTIONS,
  type ToolProgressCommand,
} from "../commands";

export const HOME_ACTION_PREFIX = "home:";
export const HOME_ACTION_TOOL_PROGRESS = `${HOME_ACTION_PREFIX}set_tool_progress` as const;
export const HOME_ACTION_REASONING_TEXT = `${HOME_ACTION_PREFIX}set_reasoning_text` as const;

export interface HomeViewParams {
  realName: string;
  email: string | null;
  workspaceName: string | null;
  toolProgress: ToolProgressCommand;
  reasoningText: boolean;
}

export interface HomeView {
  type: "home";
  blocks: Record<string, unknown>[];
}

function plainTextOption(label: string, value: string): Record<string, unknown> {
  return {
    text: { type: "plain_text", text: label, emoji: true },
    value,
  };
}

function toolProgressSelect(active: ToolProgressCommand): Record<string, unknown> {
  const options = TOOL_PROGRESS_OPTIONS.map((option) => plainTextOption(TOOL_PROGRESS_LABELS[option], option));
  return {
    type: "static_select",
    action_id: HOME_ACTION_TOOL_PROGRESS,
    placeholder: { type: "plain_text", text: "Select…", emoji: true },
    options,
    initial_option: plainTextOption(TOOL_PROGRESS_LABELS[active], active),
  };
}

function reasoningTextSelect(active: boolean): Record<string, unknown> {
  const options = REASONING_TEXT_OPTIONS.map((value) => plainTextOption(REASONING_TEXT_LABELS[value], value));
  const activeKey = active ? "on" : "off";
  return {
    type: "static_select",
    action_id: HOME_ACTION_REASONING_TEXT,
    placeholder: { type: "plain_text", text: "Select…", emoji: true },
    options,
    initial_option: plainTextOption(REASONING_TEXT_LABELS[activeKey], activeKey),
  };
}

export function buildHomeView(params: HomeViewParams): HomeView {
  const identityLines = [`Signed in as *${params.realName}*`];
  if (params.email) identityLines.push(`📧 ${params.email}`);
  if (params.workspaceName) identityLines.push(`🏢 ${params.workspaceName}`);

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "👋 Welcome to sketch", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: identityLines.join("\n") },
    },
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Settings", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Tool progress*\nHow much detail to show while sketch is working.",
      },
    },
    {
      type: "actions",
      block_id: "home_tool_progress_actions",
      elements: [toolProgressSelect(params.toolProgress)],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Reasoning text*\nShow sketch's thinking out loud while it works.",
      },
    },
    {
      type: "actions",
      block_id: "home_reasoning_text_actions",
      elements: [reasoningTextSelect(params.reasoningText)],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "_Settings apply to your DMs with sketch._" }],
    },
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "How to use", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "• DM me here for a private chat",
          "• @mention me in a channel to bring me in",
          "• Find past chats in the *History* tab",
          "• Use *New Chat* (top right) to start fresh",
        ].join("\n"),
      },
    },
  ];

  return { type: "home", blocks };
}
