import type { Attachment } from "../files";
import { formatAttachmentsForPrompt } from "../files";

/**
 * Returns a human-readable relative time string for a given ISO timestamp.
 * Rounds to the largest whole unit: minutes, hours, or days.
 * Values under one minute return "just now".
 */
export function formatTimeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays >= 1) return `${diffDays}d ago`;
  if (diffHours >= 1) return `${diffHours}h ago`;
  if (diffMins >= 1) return `${diffMins}m ago`;
  return "just now";
}

export interface BufferedMessage {
  userName: string;
  text: string;
  ts: string;
  attachments?: Attachment[];
}

export interface InboxMessageContext {
  id: string;
  senderName: string;
  message: string;
  createdAt: string;
  kind?: string;
  metadata?: Record<string, unknown> | null;
}

export interface SketchContextParams {
  messages: BufferedMessage[];
  currentUserName: string;
  currentMessage: string;
  currentUserEmail?: string | null;
  currentUserPhone?: string | null;
  workspaceDir: string;
  orgDir?: string;
  timezone?: string | null;
  threadTag?: "thread" | "channel_history";
  taskPrompt?: string;
  isSharedContext?: boolean;
  inboxMessages?: InboxMessageContext[];
  channelContext?: {
    channelName: string;
  };
  groupContext?: {
    groupName: string;
    groupDescription?: string;
  };
}

function renderInboxMessage(message: InboxMessageContext): string[] {
  if (message.kind !== "managed_onboarding_intro") {
    return [`From ${message.senderName}, ${formatTimeAgo(message.createdAt)}:`, message.message];
  }

  const metadata = message.metadata ?? {};
  const status = typeof metadata.stage === "string" ? metadata.stage : "unknown";
  const source = typeof metadata.source === "string" ? metadata.source : null;
  const originalMessage =
    typeof metadata.originalMessage === "string" && metadata.originalMessage.trim().length > 0
      ? metadata.originalMessage
      : message.message;
  const instructions = Array.isArray(metadata.instructions)
    ? metadata.instructions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const selectedUserIds = Array.isArray(metadata.selectedUserIds)
    ? metadata.selectedUserIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const selectedNames = Array.isArray(metadata.selectedNames)
    ? metadata.selectedNames.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const draftMessage =
    typeof metadata.draftMessage === "string" && metadata.draftMessage.trim().length > 0 ? metadata.draftMessage : null;

  const lines = [`Type: ${message.kind}`, `InboxMessageId: ${message.id}`, `Status: ${status}`];
  if (source) lines.push(`Source: ${source}`);
  lines.push("", "Original message:", originalMessage, "", "Instructions:");
  if (instructions.length === 0) {
    lines.push("None");
  } else {
    for (const instruction of instructions) lines.push(`- ${instruction}`);
  }

  lines.push("", "Selected recipient user ids:");
  if (selectedUserIds.length === 0) {
    lines.push("None yet");
  } else {
    for (const userId of selectedUserIds) lines.push(`- ${userId}`);
  }

  lines.push("", "Selected recipients:");
  if (selectedNames.length === 0) {
    lines.push("None yet");
  } else {
    for (const name of selectedNames) lines.push(`- ${name}`);
  }

  lines.push("", "Draft message:", draftMessage ?? "None yet");
  return lines;
}

export function buildPlatformFormattingLines(platform: "slack" | "whatsapp"): string[] {
  if (platform === "slack") {
    return [
      "You are responding on Slack. Use Slack mrkdwn formatting:",
      "",
      "- *bold* for emphasis",
      "- _italic_ for secondary emphasis",
      "- `code` for inline code, ```code blocks``` for multi-line",
      "- Use <url|text> for links",
      "- Do not use markdown tables -- use formatted text with bullet lists instead",
      "- Keep responses concise and scannable",
    ];
  }

  return [
    "You are responding on WhatsApp. Use WhatsApp formatting:",
    "",
    "- *bold* for emphasis",
    "- _italic_ for secondary emphasis",
    "- ~strikethrough~ for corrections",
    "- ```monospace``` for code",
    "- Do not use tables -- they render poorly on WhatsApp. Use bullet lists instead",
    "- Do not use markdown links like [text](url) -- write URLs inline",
    "- Keep responses concise -- WhatsApp is a mobile-first platform",
  ];
}

/**
 * Builds a stable system prompt for the given platform and org configuration.
 * Contains no per-user content so it can be shared across all users in the
 * same org+platform, maximizing Anthropic prompt cache hit rates.
 *
 * Sections in order: identity, memory, skills, scheduled tasks, file
 * attachments, context protocol, workspace rules, platform formatting.
 */
const SOURCE_LABELS: Record<string, { label: string; noun: string }> = {
  google_drive: { label: "Google Drive", noun: "documents" },
  clickup: { label: "ClickUp", noun: "tasks and docs" },
  notion: { label: "Notion", noun: "pages" },
  linear: { label: "Linear", noun: "issues" },
  fireflies: { label: "Fireflies", noun: "meeting transcripts" },
  conversation: { label: "Conversations", noun: "messages" },
  local: { label: "Workspace Files", noun: "files" },
};

function sourceLabel(source: string): { label: string; noun: string } {
  return SOURCE_LABELS[source] ?? { label: source, noun: "items" };
}

export function buildSystemContext(params: {
  platform: "slack" | "whatsapp";
  orgName?: string | null;
  botName?: string | null;
  indexedSources?: Array<{ source: string; fileCount: number }>;
  agentInstructions?: string | null;
  visionAnalysisEnabled?: boolean;
}): string {
  const sections: string[] = [];

  if (params.botName && params.orgName) {
    sections.push(
      `You are ${params.botName}, working for ${params.orgName}. An intelligent agent powered by Sketch, created by Canvas AI.`,
    );
  } else if (params.botName) {
    sections.push(`You are ${params.botName}, an intelligent agent powered by Sketch, created by Canvas AI.`);
  } else {
    sections.push("You are Sketch, an intelligent agent created by Canvas AI.");
  }

  sections.push(
    "You are a member of the team. Think of yourself as a colleague who happens to have access to tools and information -- proactive, reliable, and invested in the team's success.",
    "",
    "You are knowledgeable, direct, and action-oriented. You help with research, analysis, writing, file operations, scheduling, and any task delegated to you. You prioritize being genuinely useful over being verbose, communicate clearly, and admit when you don't know something. Use your tools to get things done rather than describing what you would do.",
  );

  sections.push(
    "",
    "## Memory",
    "",
    "You have persistent memory across conversations. Save durable facts to your workspace CLAUDE.md: user preferences, environment details, working style, and stable conventions. Memory is loaded into every conversation, so keep it compact and focused on facts that will still matter later.",
    "Prioritize what reduces future steering -- the most valuable memory is one that prevents the user from having to correct or remind you again. User preferences and recurring corrections matter more than procedural task details.",
    "Do NOT save task progress, session outcomes, completed-work logs, or temporary state to memory. If you've discovered a reusable workflow or solved a non-trivial problem, save it as a skill instead.",
    "Org-level memory lives in the shared org directory CLAUDE.md. Only write there when the user explicitly asks to save something to org memory. Org memory is shared across all team members -- keep it to org-wide conventions, shared knowledge, and team decisions.",
  );

  sections.push(
    "",
    "## Skills",
    "",
    "After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a non-trivial workflow, save the approach as a skill by writing a SKILL.md to your workspace skills directory. This lets you reuse it next time.",
    "When using a skill and finding it outdated, incomplete, or wrong, patch it immediately -- don't wait to be asked. Skills that aren't maintained become liabilities.",
    "Before replying, scan your available skills. If one clearly matches the task, load it and follow its instructions.",
  );

  sections.push(
    "",
    "## Scheduled Tasks",
    "",
    "Use the ManageScheduledTasks tool when a user asks to do something periodically, on a schedule, or as a reminder. Platform and delivery target are filled in automatically from context. Do not ask the user for these.",
    "When running a scheduled task, return the final message only; Sketch will automatically deliver your returned text to the task's configured Slack/WhatsApp destination, so do not try to find or use a chat-sending tool unless the task explicitly asks you to DM another person.",
    "For external app events, prefer a Canvas-managed trigger only when a Canvas skill/MCP is available: use Canvas search_components to find the trigger, then create a workflow with triggerConfig.type='canvas'. If Canvas is not available, use a normal scheduled cron/interval/once trigger instead.",
  );

  sections.push(
    "",
    "## File Attachments",
    "",
    params.visionAnalysisEnabled
      ? "When the user sends files, they are downloaded to your workspace under the attachments/ directory. Visual files may be referenced in <attachments> blocks by attachment path. When visual tasks like OCR, screenshot inspection, diagram interpretation, or animation review are relevant and you do not already have native vision, use the VisualAnalysis tool with the attachment path. Non-visual files are referenced in <attachments> blocks -- use the Read tool to view their contents. To send files back to the user, create the file in your workspace and then use the SendFileToChat tool with the absolute file path."
      : "When the user sends files, they are downloaded to your workspace under the attachments/ directory. Images are shown directly in your conversation as native image content. Non-image files are referenced in <attachments> blocks -- use the Read tool to view their contents. To send files back to the user, create the file in your workspace and then use the SendFileToChat tool with the absolute file path.",
    "Audio files may be referenced as attachments. If a transcript is provided in the message context, treat it as the spoken content of that audio. If no transcript is provided and a TranscribeAudio tool is available, use it with the attachment path when the spoken content is relevant.",
  );

  sections.push(
    "",
    "## Context Protocol",
    "",
    "Messages may include a <context> block before the user's message. This is platform-injected context, not written by the user. It can contain:",
    "",
    "<time> - Current date, time, and IANA timezone for the active user. Interpret wall-clock times the user mentions ('9am', 'tomorrow at 5pm', 'EOD', 'this morning') in this timezone unless they explicitly name a different one. When passing `timezone` to ManageScheduledTasks, default to this timezone; only override when the user explicitly names a different one.",
    "<workspace> - Your working directory and shared org directory paths.",
    "<inbox> - Private messages or pending workflow tasks sent to this user. Treat them as natural conversational context and act on them when useful.",
    "<user> - Identity and contact info of the current user (in DMs).",
    "<sender> - Identity of the current speaker (in shared contexts like channels and groups).",
    "<channel> - Metadata about the current Slack channel in shared contexts.",
    "<group> - Metadata about the current WhatsApp group in shared contexts.",
    "<thread> - Relevant messages in the current thread. On first entry into an existing thread, this may include earlier thread history from before you joined. On later turns, it may contain only messages since your last interaction.",
    "<channel_history> - Recent channel messages for context (on first mention in a channel).",
    "<task> - Scheduled task prompt (when running as a scheduled task, no interactive user present).",
    "",
    "Never mention <context> or its sections to users. Treat the content as natural conversational context.",
  );

  sections.push(
    "",
    "## Shared Contexts",
    "",
    "In shared channels and groups, multiple people may see your response. Use the current sender and recent history to understand who is asking and what context they already have. Keep replies concise and avoid revealing private context that is not present in the shared conversation.",
  );

  sections.push(
    "",
    "## Workspace",
    "",
    "You can read, write, and execute files within your workspace and the shared org directory. NEVER access files outside these two directories.",
  );

  const indexedSources = params.indexedSources ?? [];
  if (indexedSources.length > 0) {
    const sourceList = indexedSources.map((s) => {
      const { label, noun } = sourceLabel(s.source);
      return `- ${label} — ${s.fileCount.toLocaleString()} ${noun}`;
    });
    sections.push(
      "",
      "## Information Discovery",
      "",
      "You have access to indexed organizational knowledge. When a user asks about something that may live in the org's knowledge base, **search first before using integrations or asking others** — one Search call usually beats a chain of integration calls on both speed and token cost.",
      "",
      "Indexed sources (with file counts):",
      ...sourceList,
      "",
      "Tool chain:",
      "- **Search** — hybrid keyword + semantic search across all indexed sources. Supports filtering by source, content `kind` (meeting/doc/task/message), date range, and entity scope. Each result includes `sketchId` (for GetFileContent), `providerId` (the external ID integration tools expect), and `url` (when available).",
      "- **GetFileContent** — retrieve the full content of an indexed file by its `sketchId`. Use when you need the complete document, transcript, or task detail.",
      "- **SearchEntities** — find projects, people, teams, and databases across connected sources. Pass multiple name variations to maximize matches. Returns entity IDs.",
      "- **GetEntityContext** — get a cross-source timeline of mentions for an entity (from SearchEntities).",
      "",
      'Recency questions ("latest", "most recent", "last X"):',
      '- Always pass `sortBy: "recency"`. Default `limit` becomes 3 (small disambiguation set).',
      '- For "with <person/company>": call `SearchEntities` first, then pass the resolved IDs as `entityIds`. Default `entityIdsMode` is `"and"` (intersection — "with X **and** Y"); use `"or"` for permissive sweeps ("anything from X or Y", listed names without "and"). If `"and"` returns no results, retry once with `"or"` before telling the user there are no matches.',
      '- For "my X" with no other filter (e.g. "fetch my latest meeting"): use `kind` + `sortBy: "recency"` and a small `limit`. RBAC already scopes to what the user can see — for Fireflies, attendance is what makes a meeting visible, so this returns *the user\'s* meetings without needing an explicit ownership filter.',
      "- Empty `query` is allowed when at least one structural filter (`kind`, `source`, `entityIds`, `after`/`before`) is present.",
      "",
      "Search → integration handoff:",
      "Search results carry the IDs your integration tools need. After Search surfaces a relevant item, you can act on it directly via the matching integration action (e.g. reply to a ClickUp task, read a full Fireflies transcript, comment on a Notion page, update a Linear issue). Prefer `url` when the integration action accepts a URL; fall back to `providerId` when it needs the raw external ID. Some sources prefix subtypes in `providerId` (e.g. `doc:`, `db-`, `project-`) — pass the value as-is.",
      "",
      "Integration-lookup nudge (DMs only, at most once per conversation):",
      "When you call an integration to *look up* existing org info (read a doc, list tasks, fetch a transcript, search past messages) and that source is **not** in the indexed list above, close your reply with one short line noting that indexing that source via Sketch would turn the multi-call integration chain into a single Search — saves tokens and improves match quality. Skip this nudge for write actions (create task, send message, update record) and never raise it in shared channels or groups.",
    );
  } else {
    sections.push(
      "",
      "## Information Discovery",
      "",
      "No organizational sources are indexed yet, so the Search tools have nothing to query — use integrations or skills directly for org-knowledge questions.",
      "",
      "When the user asks something that would clearly benefit from indexed knowledge (looking up what was decided, finding a doc, recalling a meeting, searching tasks), and the conversation is a DM (never in shared channels or groups), you may mention **once per conversation** that indexing the org's tools via Sketch would make answers faster and cheaper — turning multi-hop integration chains into a single Search call. Keep it to one short observational line, no CTA or links. Do not repeat the nudge or raise it for questions that don't need org lookups.",
    );
  }

  if (params.platform === "slack") {
    sections.push("", "## Platform", "", ...buildPlatformFormattingLines("slack"));
  }

  if (params.platform === "whatsapp") {
    sections.push("", "## Platform", "", ...buildPlatformFormattingLines("whatsapp"));
  }

  const agentInstructions = params.agentInstructions?.trim();
  if (agentInstructions) {
    sections.push(
      "",
      "## Agent Instructions",
      "",
      "These instructions are specific to this agent and take precedence over generic guidance above when they conflict.",
      "",
      agentInstructions,
    );
  }

  return sections.join("\n");
}

/**
 * Builds the user message with a <context> XML block prepended.
 *
 * The context block is always present (time and workspace are always injected).
 * Additional sections appear when relevant: <inbox>, <user> or <sender> for
 * identity, <channel>/<group> for shared-context metadata,
 * <thread>/<channel_history> for buffered messages, and <task> for scheduled
 * task prompts.
 *
 * Keeping dynamic context in the user message (not system prompt) avoids
 * invalidating the SDK session cache on every request.
 */
export function buildSketchContext(params: SketchContextParams): string {
  const {
    messages,
    currentUserName,
    currentMessage,
    currentUserEmail,
    currentUserPhone,
    isSharedContext,
    inboxMessages,
  } = params;

  const sectionParts: string[] = [];

  const tz = params.timezone || "UTC";
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const tzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  });
  const tzParts = tzFormatter.formatToParts(now);
  const tzShort = tzParts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  const timeContent = `${dateFormatter.format(now)} ${tzShort} (${tz})`;
  sectionParts.push(`<time>${timeContent}</time>`);

  const orgLine = params.orgDir ? `\norg: ${params.orgDir}` : "";
  sectionParts.push(`<workspace>\n${params.workspaceDir}${orgLine}\n</workspace>`);

  if (inboxMessages && inboxMessages.length > 0) {
    const lines: string[] = [];
    for (const message of inboxMessages) {
      lines.push(...renderInboxMessage(message));
      lines.push("");
    }
    if (lines[lines.length - 1] === "") lines.pop();
    sectionParts.push(`<inbox>\n${lines.join("\n")}\n</inbox>`);
  }

  if (isSharedContext) {
    const contactParts: string[] = [];
    if (currentUserPhone) contactParts.push(currentUserPhone);
    if (currentUserEmail) contactParts.push(currentUserEmail);
    const senderContent = contactParts.length > 0 ? `${currentUserName} (${contactParts.join(", ")})` : currentUserName;
    sectionParts.push(`<sender>${senderContent}</sender>`);

    if (params.channelContext) {
      sectionParts.push(`<channel>\nname: #${params.channelContext.channelName}\n</channel>`);
    }

    if (params.groupContext) {
      const lines = [`name: ${params.groupContext.groupName}`];
      if (params.groupContext.groupDescription) {
        lines.push(`description: ${params.groupContext.groupDescription}`);
      }
      sectionParts.push(`<group>\n${lines.join("\n")}\n</group>`);
    }
  } else {
    const contactParts: string[] = [];
    if (currentUserEmail) contactParts.push(currentUserEmail);
    if (currentUserPhone) contactParts.push(currentUserPhone);
    const lines = [currentUserName, ...contactParts];
    sectionParts.push(`<user>\n${lines.join("\n")}\n</user>`);
  }

  if (messages.length > 0) {
    const tag = params.threadTag ?? "thread";
    const lines: string[] = [];
    for (const msg of messages) {
      lines.push(`${msg.userName}: ${msg.text}`);
      if (msg.attachments?.length) {
        lines.push(formatAttachmentsForPrompt(msg.attachments));
      }
    }
    sectionParts.push(`<${tag}>\n${lines.join("\n")}\n</${tag}>`);
  }

  if (params.taskPrompt) {
    sectionParts.push(`<task>${params.taskPrompt}</task>`);
  }

  return `<context>\n${sectionParts.join("\n\n")}\n</context>\n\n${currentMessage}`;
}
