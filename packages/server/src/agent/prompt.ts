import { VISUAL_ANALYSIS_AGENT_TOOL_NAME } from "@sketch/shared";
import type { Attachment, AttachmentPromptOptions } from "../files";
import { formatAttachmentsForPrompt, isImageAttachment } from "../files";

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

export interface ConversationBacklogMessage {
  id: number;
  senderName: string;
  text: string;
  attachments: Attachment[];
  providerThreadId?: string | null;
  providerParentMessageId?: string | null;
  isThreadReply?: boolean;
  providerTimestamp: string | null;
  receivedAt: string;
}

export interface ConversationBacklogContext {
  messages: ConversationBacklogMessage[];
  afterMessageId?: number | null;
  beforeMessageId: number;
  hasMore: boolean;
  nextCursor?: number;
}

export interface QuotedMessageContext {
  id?: number;
  providerMessageId: string;
  senderName?: string | null;
  senderJid?: string | null;
  text: string;
  attachments: Attachment[];
  providerTimestamp?: string | null;
  receivedAt?: string | null;
}

export interface LocalClaudeSessionEventContext {
  sessionId: string;
  eventId?: string;
  eventType: string;
  status: string;
  message: string;
  payload?: unknown;
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
  conversationBacklog?: ConversationBacklogContext;
  quotedMessage?: QuotedMessageContext;
  localClaudeSessionEvent?: LocalClaudeSessionEventContext;
  visionAnalysisEnabled?: boolean;
}

function renderBufferedMessageLines(
  messages: BufferedMessage[],
  attachmentOptions: AttachmentPromptOptions = {},
): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    lines.push(`${msg.userName}: ${msg.text}`);
    if (msg.attachments?.length) {
      lines.push(formatAttachmentsForPrompt(msg.attachments, attachmentOptions));
    }
  }
  return lines;
}

function formatConversationBacklogMessages(messages: ConversationBacklogMessage[]): BufferedMessage[] {
  return messages.map((message) => ({
    userName: `${message.senderName} [messageId=${message.id}]`,
    text: message.text || (message.attachments.length > 0 ? "See attached files." : ""),
    ts: message.providerTimestamp ?? message.receivedAt,
    ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
  }));
}

function buildConversationBacklogNotice(params: ConversationBacklogContext): string {
  const lowerBound = params.afterMessageId ?? 0;
  const lines = [
    `Missed chat messages are shown below using durable row ids. Included messages are after messageId ${lowerBound} and before the current messageId ${params.beforeMessageId}.`,
  ];
  if (params.hasMore) {
    lines.push(
      `Only ${params.messages.length} missed messages are inlined. If the user asks for a targeted keyword, topic, decision, person, project, or phrase lookup, you must call SearchChatHistory first instead of paging sequentially. For chronological continuation, use ReadChatHistory with afterMessageId ${params.nextCursor ?? lowerBound}, beforeMessageId ${params.beforeMessageId}, and includeBotMessages false.`,
    );
  }
  return lines.join("\n");
}

function renderConversationBacklogLines(
  backlog: ConversationBacklogContext | undefined,
  attachmentOptions: AttachmentPromptOptions = {},
): string[] {
  if (!backlog || (backlog.messages.length === 0 && !backlog.hasMore)) return [];

  const lines = [buildConversationBacklogNotice(backlog)];
  const messageLines = renderBufferedMessageLines(
    formatConversationBacklogMessages(backlog.messages),
    attachmentOptions,
  );
  return messageLines.length > 0 ? [...lines, "", ...messageLines] : lines;
}

function renderQuotedMessageLines(
  quotedMessage: QuotedMessageContext | undefined,
  attachmentOptions: AttachmentPromptOptions = {},
): string[] {
  if (!quotedMessage) return [];

  const lines = [
    "The current message is a WhatsApp reply to this quoted message.",
    `text: ${quotedMessage.text || (quotedMessage.attachments.length > 0 ? "See attached files." : "")}`,
  ];
  if (quotedMessage.senderName?.trim()) {
    lines.splice(1, 0, `sender: ${quotedMessage.senderName}`);
  }
  if (quotedMessage.attachments.length > 0) {
    lines.push(formatAttachmentsForPrompt(quotedMessage.attachments, attachmentOptions));
  }
  return lines;
}

export function getImageAttachmentPathsFromSketchContext(
  params: Pick<SketchContextParams, "messages" | "conversationBacklog" | "quotedMessage">,
): string[] {
  const paths: string[] = [];
  for (const message of params.messages) {
    for (const attachment of message.attachments ?? []) {
      if (isImageAttachment(attachment)) paths.push(attachment.localPath);
    }
  }
  for (const message of params.conversationBacklog?.messages ?? []) {
    for (const attachment of message.attachments) {
      if (isImageAttachment(attachment)) paths.push(attachment.localPath);
    }
  }
  for (const attachment of params.quotedMessage?.attachments ?? []) {
    if (isImageAttachment(attachment)) paths.push(attachment.localPath);
  }
  return paths;
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

export type ResponseSurface = "slack" | "whatsapp" | "web";

export function buildPlatformFormattingLines(platform: ResponseSurface): string[] {
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

  if (platform === "whatsapp") {
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

  return [
    "You are responding in Sketch web chat. Use GitHub-flavored Markdown:",
    "",
    "- Use short paragraphs, headings only when they add structure, and bullet or numbered lists for scans",
    "- Use **bold** for emphasis, _italic_ for secondary emphasis, and `code` for inline commands, filenames, and IDs",
    "- Use fenced code blocks with a language when showing multi-line code or logs",
    "- Use [descriptive link text](url) for links; avoid exposing raw long URLs unless the user asks for the literal URL",
    "- Use Markdown tables only for small comparisons where rows and columns improve readability",
    "- Keep responses concise and make lists easy to skim",
  ];
}

function platformHeading(params: { platform: ResponseSurface; deliveryPlatform?: "slack" | "whatsapp" }): string[] {
  if (params.platform === "web" && params.deliveryPlatform) {
    return [
      "## Platform",
      "",
      ...buildPlatformFormattingLines("web"),
      "",
      `Background actions may still use ${params.deliveryPlatform} delivery context, but your visible reply is rendered in web chat and must use web Markdown formatting.`,
    ];
  }

  return ["## Platform", "", ...buildPlatformFormattingLines(params.platform)];
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
  otter: { label: "Otter", noun: "meeting transcripts" },
  conversation: { label: "Conversations", noun: "messages" },
  local: { label: "Workspace Files", noun: "files" },
};

function sourceLabel(source: string): { label: string; noun: string } {
  return SOURCE_LABELS[source] ?? { label: source, noun: "items" };
}

export function buildSystemContext(params: {
  platform: ResponseSurface;
  deliveryPlatform?: "slack" | "whatsapp";
  orgName?: string | null;
  orgDescription?: string | null;
  botName?: string | null;
  indexedSources?: Array<{ source: string; fileCount: number }>;
  agentInstructions?: string | null;
  visionAnalysisEnabled?: boolean;
  automationAuthoringEnabled?: boolean;
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

  if (params.orgDescription && params.orgDescription.trim().length > 0) {
    sections.push("", `About ${params.orgName ?? "the organization"}: ${params.orgDescription.trim()}`);
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
    "You may have persistent memory across conversations when Sketch memory files or resumed session context are available. Do not claim to remember past conversations unless the relevant facts are present in the active conversation, the active resumed session, or tool-verified Sketch memory files such as CLAUDE.md.",
    "Save durable facts to your workspace CLAUDE.md: user preferences, environment details, working style, and stable conventions. Memory is loaded into future conversations only when present there, so keep it compact and focused on facts that will still matter later.",
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
    "Use the ManageScheduledTasks tool when a user asks to do something periodically, on a schedule, or as a reminder. The creation context is filled in automatically, but final delivery is editable through the delivery fields.",
    params.automationAuthoringEnabled
      ? "When the user names a delivery destination, use SearchDeliveryTargets first, then include the resolved target ID and label in the natural-language ManageScheduledTasks request."
      : "When the user names a delivery destination, use SearchDeliveryTargets first, then pass the resolved target ID in ManageScheduledTasks delivery.",
    "If a workflow is created from a Slack thread, default future workflow output to the parent channel top-level. Only set delivery.threadTs when the user explicitly asks to post workflow updates in that thread.",
    "When running a scheduled task, return the final message only; Sketch will automatically deliver your returned text to the task's configured Slack/WhatsApp destination, so do not try to find or use a chat-sending tool unless the task explicitly asks you to DM another person.",
    "When a scheduled task asks for reminders, follow-ups, outstanding commitments, or completed work, you must call ListFollowups first. Its durable follow-up state is authoritative: pending items stay pending, looks-resolved items require user review, confirmed or rejected work must not be reconstructed from chat history, and untracked items must remain labelled as untracked.",
    "For external app events, prefer a Canvas-managed trigger only when a Canvas skill/MCP is available: use Canvas search_components to find the trigger, then create a workflow with triggerConfig.type='canvas'. If Canvas is not available, use a normal scheduled cron/interval/once trigger instead.",
  );

  if (params.automationAuthoringEnabled) {
    sections.push(
      "When creating or semantically editing an automation, pass the user's requested change as a natural-language request to ManageScheduledTasks. For edits, include the task ID.",
      "Do not construct or pass automation definition fields such as schedules, timezones, delivery, titles, descriptions, steps, edges, prompts, scripts, apps, modes, skills, MCP servers, or models. The automation authoring model owns the complete definition.",
      "Never use updateStepContent. Prompt, script, app, mode, skill, MCP, schedule, delivery, and structural changes must use a full ManageScheduledTasks update with the user's natural-language request.",
      "Operational actions remain deterministic: use ManageScheduledTasks directly to list, pause, resume, run, delete, and inspect run history without an authoring request.",
    );
  }

  if (params.platform === "web") {
    sections.push(
      "",
      "## Web Chat Automations",
      "",
      "When ManageScheduledTasks creates or updates an automation in web chat, the client renders the automation card separately. Briefly introduce the card, but do not paste an automation link unless the user explicitly asks for the literal URL. If they do, provide it as an automation link and avoid internal product terminology in the user-facing response.",
    );
  }

  sections.push(
    "",
    "## Integration Connections",
    "",
    "When the user asks to connect an integration, asks which accounts are connected, or when a task needs a specific app account, use the integration search-apps capability to resolve the provider app and connected status.",
    "Call search-apps without queries when the user asks what integration accounts are connected. It returns connected accounts from provider state.",
    "If the app identity is ambiguous or maps to multiple provider apps, ask one concise clarification only for the missing product/app identity, such as 'Which Zoho product should I use?'",
    "Never ask whether to show, pull up, open, or display a connection card or link. Forbidden examples: 'Should I pull up the connection card?', 'I can pull up the right card for you', 'Want me to show the connector card?', 'I'll open the connection card'.",
    "When an app is not connected, say that app needs to be connected and continue only with task-relevant guidance if needed. If Sketch can detect the missing app, it will add an app-specific setup option automatically after your response; do not mention that rendering step.",
    "For missing Canvas/provider apps returned by search-apps, do not give manual navigation, API-key, or 'look for this app' setup instructions. Sketch will resolve the returned app identity into the right connection target.",
    "Do not send users to Settings -> Integrations unless no setup card/link is available or they explicitly ask for settings.",
    "Do not include a separate 'connect these apps' section, raw integration URLs, or repeated connect instructions in your own answer. Sketch appends the concrete setup card/link when one is available.",
    "Do not tell the user how to use the setup card/link. Sketch renders the actionable setup UI outside your text.",
    "Do not describe card or link rendering mechanics. Answer from the returned app/account status.",
  );

  sections.push(
    "",
    "## Local Claude Code Delegation",
    "",
    "Use the local_claude_session tool when the user asks you to delegate coding work to Claude Code on their paired local Mac. Create the session with the user's initial task; Sketch starts Claude Code with bypass permissions in a Sketch-managed tmux session.",
    "Do not continuously poll a running local Claude Code session. Sketch Local forwards hook events when Claude Code finishes a turn, needs input or permission, fails, or exits. Capture the pane when an event arrives, before sending follow-up input, or when the user asks for current state.",
    "If Claude Code asks a clarifying question, answer it yourself when the answer is clear from the active conversation or available context. If the answer is not clear, surface the question to the originating chat or thread.",
    "Only operate on sessions returned by local_claude_session. Do not use raw tmux commands to attach to arbitrary user sessions.",
  );

  sections.push(
    "",
    "## File Attachments",
    "",
    params.visionAnalysisEnabled
      ? `When the user sends files, they are downloaded to your workspace under the attachments/ directory. Visual files may be referenced in <attachments> blocks by attachment path. When visual tasks like OCR, screenshot inspection, diagram interpretation, or animation review are relevant and you do not already have native vision, use the ${VISUAL_ANALYSIS_AGENT_TOOL_NAME} tool with the attachment path. Non-visual files are referenced in <attachments> blocks -- use the Read tool to view their contents. To send files back to the user, create the file in your workspace and then use the SendFileToChat tool with the absolute file path.`
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
    "<local_claude_session_event> - Internal event from a delegated local Claude Code session. It is not a user message. Capture the session pane before acting. Any final response you write is visible to the user; ask them only if you need input to continue.",
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
    "## Chat History",
    "",
    "Use SearchChatHistory to find relevant stored chat messages by keyword, topic, decision, person, project, or older/wider chat reference in the current conversation.",
    "When a user asks about a named topic, decision, person, project, phrase, or older chat reference that is not already visible, you must call SearchChatHistory first. Do not page through chat history with ReadChatHistory as the first step for targeted lookup.",
    "Use ReadChatHistory for chronological paging, missed-message continuation, or reading around a known chat message row id.",
    'For Slack thread-local questions, use SearchChatHistory with scope: "current_thread" when active thread metadata is available.',
    'For wider Slack channel, WhatsApp group, Slack DM, or WhatsApp DM memory, use SearchChatHistory with scope: "conversation". This is how you discover ambient Slack messages that were stored but not inlined.',
    "SearchChatHistory scopes conversation and current_thread cover the active chat conversation. It is not org-wide knowledge search and does not replace the existing Search tool for indexed docs, tasks, meetings, or connector data.",
    'Use SearchChatHistory with scope: "all_chats" when the user asks about something that may live in another Slack channel or WhatsApp group they are a member of — for example "find that message about pricing in my groups". Results are limited server-side to conversations the requesting user belongs to. An optional platform filter narrows to slack or whatsapp.',
    'scope: "all_chats" works in any context, including shared channels and groups. In a shared context, remember the reply is visible to everyone present, so summarize cross-chat results with judgment rather than quoting private-looking content verbatim.',
    "If SearchChatHistory returns a promising row but the surrounding chronology matters, call ReadChatHistory with the returned conversation ref and anchor message id. The same ReadChatHistory tool handles current-chat and cross-chat chronology, with access checks enforced server-side.",
    "An empty SearchChatHistory result means no match was found in chats authorized for the requester. Never infer from an empty result that matching messages were never persisted or that inaccessible chats contain no matches.",
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
      "- **SearchEntities** — find projects, people, teams, companies, and products across connected sources. " +
        "Pass multiple name variations to maximize matches. Returns entity IDs.",
      "- **GetEntityContext** — get a cross-source timeline of mentions for an entity (from SearchEntities).",
      "- **ListFollowups** — read durable conversation-derived pending, untracked, and looks-resolved follow-up state for reminder briefs.",
      "- **ListTasks** — list current tracker-owned tasks by project entity or assignee entity, including status, source, priority, and due date.",
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

  sections.push("", ...platformHeading({ platform: params.platform, deliveryPlatform: params.deliveryPlatform }));

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

  const attachmentOptions = { visionAnalysisEnabled: params.visionAnalysisEnabled };
  const backlogLines = renderConversationBacklogLines(params.conversationBacklog, attachmentOptions);
  const messageLines = renderBufferedMessageLines(messages, attachmentOptions);
  const separator = backlogLines.length > 0 && messageLines.length > 0 ? [""] : [];
  const threadLines = [...backlogLines, ...separator, ...messageLines];

  if (threadLines.length > 0) {
    const tag = params.threadTag ?? "thread";
    sectionParts.push(`<${tag}>\n${threadLines.join("\n")}\n</${tag}>`);
  }

  const quotedMessageLines = renderQuotedMessageLines(params.quotedMessage, attachmentOptions);
  if (quotedMessageLines.length > 0) {
    sectionParts.push(`<quoted_message>\n${quotedMessageLines.join("\n")}\n</quoted_message>`);
  }

  if (params.taskPrompt) {
    sectionParts.push(`<task>${params.taskPrompt}</task>`);
  }

  if (params.localClaudeSessionEvent) {
    const event = params.localClaudeSessionEvent;
    const lines = [
      "A local Claude Code event occurred. It is internal context, not a user message. Capture the session pane before acting. Any final response you write is visible to the user; ask them only if you need input to continue.",
      "",
      `sessionId: ${event.sessionId}`,
      ...(event.eventId ? [`eventId: ${event.eventId}`] : []),
      `eventType: ${event.eventType}`,
      `status: ${event.status}`,
      `message: ${event.message}`,
    ];
    if (event.payload !== undefined) {
      lines.push("payload:", JSON.stringify(event.payload, null, 2));
    }
    sectionParts.push(`<local_claude_session_event>\n${lines.join("\n")}\n</local_claude_session_event>`);
  }

  return `<context>\n${sectionParts.join("\n\n")}\n</context>\n\n${currentMessage}`;
}
