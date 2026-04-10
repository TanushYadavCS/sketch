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

/**
 * Outreach record for context injection. Used for both pending inbound outreach
 * (questions from other users' agents) and outbound responses (answers to
 * questions this user's agent sent).
 *
 * Kept for backward compatibility with other files that reference this type.
 * Outreach injection has been removed from buildSketchContext.
 */
export interface OutreachRecord {
  id: string;
  requesterName?: string;
  recipientName?: string;
  message: string;
  taskContext?: string | null;
  response?: string | null;
  status: string;
  createdAt: string;
  respondedAt?: string | null;
}

export interface SketchContextParams {
  messages: BufferedMessage[];
  currentUserName: string;
  currentMessage: string;
  currentUserEmail?: string | null;
  currentUserPhone?: string | null;
  workspaceDir: string;
  orgDir: string;
  timezone?: string | null;
  threadTag?: "thread" | "channel_history" | "thread_history";
  taskPrompt?: string;
  isSharedContext?: boolean;
}

/**
 * Builds a stable system prompt for the given platform and org configuration.
 * Contains no per-user content so it can be shared across all users in the
 * same org+platform, maximizing Anthropic prompt cache hit rates.
 *
 * Sections in order: identity, memory, skills, scheduled tasks, file
 * attachments, context protocol, workspace rules, platform formatting.
 */
export function buildSystemContext(params: {
  platform: "slack" | "whatsapp";
  orgName?: string | null;
  botName?: string | null;
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
  );

  sections.push(
    "",
    "## File Attachments",
    "",
    "When the user sends files, they are downloaded to your workspace under the attachments/ directory. Images are shown directly in your conversation as native image content. Non-image files are referenced in <attachments> blocks -- use the Read tool to view their contents. To send files back to the user, create the file in your workspace and then use the SendFileToChat tool with the absolute file path.",
  );

  sections.push(
    "",
    "## Context Protocol",
    "",
    "Messages may include a <context> block before the user's message. This is platform-injected context, not written by the user. It can contain:",
    "",
    "<time> - Current date, time, and timezone.",
    "<workspace> - Your working directory and shared org directory paths.",
    "<user> - Identity and contact info of the current user (in DMs).",
    "<sender> - Identity of the current speaker (in shared contexts like channels and groups).",
    "<thread> - Messages in the current thread since your last interaction.",
    "<channel_history> - Recent channel messages for context (on first mention in a channel).",
    "<thread_history> - Thread messages before you joined (on first mention in a thread).",
    "<task> - Scheduled task prompt (when running as a scheduled task, no interactive user present).",
    "",
    "Never mention <context> or its sections to users. Treat the content as natural conversational context.",
  );

  sections.push(
    "",
    "## Workspace",
    "",
    "You can read, write, and execute files within your workspace and the shared org directory. NEVER access files outside these two directories.",
  );

  if (params.platform === "slack") {
    sections.push(
      "",
      "## Platform",
      "",
      "You are responding on Slack. Use Slack mrkdwn formatting:",
      "",
      "- *bold* for emphasis",
      "- _italic_ for secondary emphasis",
      "- `code` for inline code, ```code blocks``` for multi-line",
      "- Use <url|text> for links",
      "- Do not use markdown tables -- use formatted text with bullet lists instead",
      "- Keep responses concise and scannable",
    );
  }

  if (params.platform === "whatsapp") {
    sections.push(
      "",
      "## Platform",
      "",
      "You are responding on WhatsApp. Use WhatsApp formatting:",
      "",
      "- *bold* for emphasis",
      "- _italic_ for secondary emphasis",
      "- ~strikethrough~ for corrections",
      "- ```monospace``` for code",
      "- Do not use tables -- they render poorly on WhatsApp. Use bullet lists instead",
      "- Do not use markdown links like [text](url) -- write URLs inline",
      "- Keep responses concise -- WhatsApp is a mobile-first platform",
    );
  }

  return sections.join("\n");
}

/**
 * Builds the user message with a <context> XML block prepended.
 *
 * The context block is always present (time and workspace are always injected).
 * Additional sections appear when relevant: <user> or <sender> for identity,
 * <thread>/<channel_history>/<thread_history> for buffered messages,
 * <task> for scheduled task prompts.
 *
 * Keeping dynamic context in the user message (not system prompt) avoids
 * invalidating the SDK session cache on every request.
 */
export function buildSketchContext(params: SketchContextParams): string {
  const { messages, currentUserName, currentMessage, currentUserEmail, currentUserPhone, isSharedContext } = params;

  const sectionParts: string[] = [];

  const tz = params.timezone || "UTC";
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const tzFormatter = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    timeZoneName: "short",
  });
  const tzParts = tzFormatter.formatToParts(now);
  const tzShort = tzParts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  const timeContent = `${dateFormatter.format(now)} ${tzShort} (${tz})`;
  sectionParts.push(`<time>${timeContent}</time>`);

  sectionParts.push(`<workspace>\n${params.workspaceDir}\norg: ${params.orgDir}\n</workspace>`);

  if (isSharedContext) {
    const contactParts: string[] = [];
    if (currentUserPhone) contactParts.push(currentUserPhone);
    if (currentUserEmail) contactParts.push(currentUserEmail);
    const senderContent = contactParts.length > 0 ? `${currentUserName} (${contactParts.join(", ")})` : currentUserName;
    sectionParts.push(`<sender>${senderContent}</sender>`);
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
