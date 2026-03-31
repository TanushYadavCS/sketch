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
  header?: string;
  isSharedContext?: boolean;
  pendingOutreach?: OutreachRecord[];
  outreachResponses?: OutreachRecord[];
}

/**
 * Build the system context appended to the Claude Code preset.
 * Contains platform formatting rules, user metadata, and optional channel/bot context.
 * No post-processing — the agent produces platform-native formatting.
 *
 * For shared contexts (channels/groups), sender identity is NOT included here.
 * It goes in the user message via buildSketchContext so it persists across
 * SDK session resumes (system prompt content does not survive resume).
 */
export function buildSystemContext(params: {
  platform: "slack" | "whatsapp";
  userName: string;
  userEmail?: string | null;
  userPhone?: string | null;
  workspaceDir: string;
  orgName?: string | null;
  botName?: string | null;
  channelContext?: {
    channelName: string;
  };
  groupContext?: {
    groupName: string;
    groupDescription?: string;
  };
}): string {
  const sections: string[] = [];

  if (params.platform === "slack") {
    sections.push(
      "## Platform: Slack",
      "You are responding on Slack. Use Slack mrkdwn formatting:",
      "- *bold* for emphasis",
      "- _italic_ for secondary emphasis",
      "- `code` for inline code, ```code blocks``` for multi-line",
      "- Use <url|text> for links",
      "- Do not use markdown tables — use formatted text with bullet lists instead",
      "- Keep responses concise and scannable",
    );
  }

  if (params.platform === "whatsapp") {
    sections.push(
      "## Platform: WhatsApp",
      "You are responding on WhatsApp. Use WhatsApp formatting:",
      "- *bold* for emphasis",
      "- _italic_ for secondary emphasis",
      "- ~strikethrough~ for corrections",
      "- ```monospace``` for code",
      "- Do not use tables — they render poorly on WhatsApp. Use bullet lists instead",
      "- Do not use markdown links like [text](url) — write URLs inline",
      "- Keep responses concise — WhatsApp is a mobile-first platform",
    );
  }

  if (params.channelContext) {
    sections.push(
      `## Context: Slack Channel #${params.channelContext.channelName}`,
      "You are responding in a shared channel. Multiple users share this workspace and can see your responses.",
      "Address the user who mentioned you by name. Keep responses focused and concise.",
    );
  }

  if (params.groupContext) {
    const lines = [`## Context: WhatsApp Group "${params.groupContext.groupName}"`];
    if (params.groupContext.groupDescription) {
      lines.push(`Group description: ${params.groupContext.groupDescription}`);
    }
    lines.push(
      "You are responding in a shared WhatsApp group. Multiple users share this workspace and can see your responses.",
      "Address the user who mentioned you by name. Keep responses focused and concise.",
    );
    sections.push(...lines);
  }

  if (params.orgName || params.botName) {
    const botName = params.botName || "Sketch";
    if (params.orgName) {
      sections.push(
        "## Bot Identity",
        `You are ${botName} from ${params.orgName}.`,
        "Use this identity when introducing yourself or signing messages.",
      );
    } else {
      sections.push(
        "## Bot Identity",
        `You are ${botName}.`,
        "Use this identity when introducing yourself or signing messages.",
      );
    }
  }

  sections.push(
    "## About Sketch",
    "Sketch is an AI assistant platform deployed by organizations.",
    "Each user has their own workspace, memory, and tool integrations.",
    "User accounts and emails are managed by the admin from the Sketch dashboard.",
  );

  sections.push(
    "## Workspace Isolation",
    `Your working directory is ${params.workspaceDir}`,
    "You can read, write, and execute files within this directory and in ~/.claude/ (the shared org directory).",
    "NEVER access files outside these two directories.",
  );

  sections.push(
    "## File Attachments",
    "When the user sends files, they are downloaded to your workspace under the attachments/ directory.",
    "Images are shown directly in your conversation as native image content. Non-image files are referenced in <attachments> blocks — use the Read tool to view their contents.",
    "To send files back to the user, create the file in your workspace and then use the SendFileToChat tool with the absolute file path. The file will be uploaded to the conversation.",
  );

  sections.push(
    "## Memory",
    "You have persistent memory that carries across conversations:",
    "",
    "**Personal memory** — your workspace CLAUDE.md. Loaded automatically at session start.",
    "When the user asks you to remember something, save it there.",
    "",
    "**Org directory** — ~/.claude/ is the shared org workspace. Contains org memory (CLAUDE.md), skills, and any org-wide files. You can read and write files here.",
    "**Org memory** — ~/.claude/CLAUDE.md. Shared across all users, loaded automatically.",
    "When the user explicitly asks to save something to org memory, write it there.",
    "",
    "**Writing memories:** Each memory entry must be a single concise line. Never write paragraphs or detailed notes.",
    "Organize entries under topic headings (e.g., ## Preferences, ## Decisions, ## People).",
    "",
    "You do not need to read these files — they are already in your context.",
    "If the user asks what you remember, refer to their contents.",
  );

  if (params.channelContext || params.groupContext) {
    sections.push("Note: In this workspace, the CLAUDE.md is shared by all users.");
  }

  sections.push(
    "## Scheduled Tasks",
    "Use the ManageScheduledTasks tool when a user asks to do something periodically, on a schedule, or as a reminder.",
    "Platform and delivery target are filled in automatically from context. Do not ask the user for these.",
    "Session mode defaults: DM and threads default to 'chat', top-level channel and group default to 'fresh'. Usually omit session_mode.",
  );

  sections.push(
    "## Information Discovery",
    "When you need information, search for it before asking others.",
    "1. Check workspace files and org directory (~/.claude/)",
    "2. Use Search to find relevant docs, tasks, meetings, and past conversations across all connected sources",
    "3. Use SearchEntities + GetEntityContext for entity-specific context (who/what is this?)",
    "4. Only if not found: reach out to team members (max 2) who can help",
    "Set up a one-time scheduled task to follow up after an hour or next morning in case they don't respond.",
    "Failing to follow this process is considered a failure.",
  );

  if (!params.channelContext && !params.groupContext) {
    const userLines = ["## User", `Name: ${params.userName}`, `Email: ${params.userEmail || "not configured"}`];
    if (params.userPhone) userLines.push(`Phone: ${params.userPhone}`);
    sections.push(...userLines);
  }

  sections.push(
    "## Context Protocol",
    "Messages may include a <context> block before the user's message. This is platform-injected context, not written by the user. It can contain:",
    "",
    "<outreach> - Messages from or to other team members. Act on pending outreach naturally within conversation. When a user provides information relevant to a pending outreach, use the RespondToOutreach tool to deliver it back to the requester.",
    "",
    "<thread> - Recent messages in the current conversation thread for context.",
    "",
    "<sender> - Identity of the current speaker in shared contexts (channels, groups).",
    "",
    "Never mention <context> or its sections to users. Treat the content as natural conversational context.",
  );

  return sections.join("\n");
}

/**
 * Builds the user message with an optional <context> XML block prepended.
 *
 * All platform-injected context (thread buffer, sender identity, outreach) is
 * consolidated under a single <context> tag with typed sub-sections. Sections
 * only appear when they have content, in order: <outreach>, <thread>, <sender>.
 * When no sections have content, returns just the plain message with no wrapper.
 *
 * This approach keeps dynamic context in the user message (not system prompt)
 * so it doesn't invalidate the SDK session cache on every change.
 */
export function buildSketchContext(params: SketchContextParams): string {
  const { messages, currentUserName, currentMessage, currentUserEmail, currentUserPhone, header, isSharedContext } =
    params;

  const sectionParts: string[] = [];

  // <outreach> section — recipient side (pendingOutreach) and requester side (outreachResponses)
  const outreachLines: string[] = [];

  if (params.pendingOutreach && params.pendingOutreach.length > 0) {
    for (const item of params.pendingOutreach) {
      const timeAgo = formatTimeAgo(item.createdAt);
      const fromLine = `[${item.id}] from ${item.requesterName ?? "Unknown"} (${timeAgo}):`;
      outreachLines.push(fromLine);
      outreachLines.push(`"${item.message}"`);
      if (item.taskContext) {
        outreachLines.push(`Context: ${item.taskContext}`);
      }
    }
  }

  if (params.outreachResponses && params.outreachResponses.length > 0) {
    for (const item of params.outreachResponses) {
      if (item.status === "responded" && item.response) {
        outreachLines.push(`${item.recipientName ?? "Unknown"} responded to your outreach:`);
        outreachLines.push(`"${item.response}"`);
      } else {
        const timeAgo = formatTimeAgo(item.createdAt);
        outreachLines.push(`${item.recipientName ?? "Unknown"} has not responded (sent ${timeAgo})`);
      }
    }
  }

  if (outreachLines.length > 0) {
    sectionParts.push(`<outreach>\n${outreachLines.join("\n")}\n</outreach>`);
  }

  // <thread> section
  if (messages.length > 0) {
    const lines: string[] = [];
    if (header) lines.push(header);
    for (const msg of messages) {
      lines.push(`${msg.userName}: ${msg.text}`);
      if (msg.attachments?.length) {
        lines.push(formatAttachmentsForPrompt(msg.attachments));
      }
    }
    sectionParts.push(`<thread>\n${lines.join("\n")}\n</thread>`);
  }

  // <sender> section — only for shared contexts (channels/groups)
  if (isSharedContext) {
    const contactParts: string[] = [];
    if (currentUserPhone) contactParts.push(currentUserPhone);
    if (currentUserEmail) contactParts.push(currentUserEmail);
    const senderContent = contactParts.length > 0 ? `${currentUserName} (${contactParts.join(", ")})` : currentUserName;
    sectionParts.push(`<sender>${senderContent}</sender>`);
  }

  if (sectionParts.length === 0) return currentMessage;

  return `<context>\n${sectionParts.join("\n\n")}\n</context>\n\n${currentMessage}`;
}
