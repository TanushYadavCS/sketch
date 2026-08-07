import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { SelectableUser, SketchMcpDeps, ToolResult } from "./types";

function detectPlatform(recipient: SelectableUser): "slack" | "whatsapp" | null {
  if (recipient.slack_user_id) return "slack";
  if (recipient.whatsapp_number) return "whatsapp";
  return null;
}

function formatUserMatch(user: SelectableUser, matchedBy: string) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    slackUserId: user.slack_user_id,
    channels: [...(user.slack_user_id ? ["slack"] : []), ...(user.whatsapp_number ? ["whatsapp"] : [])],
    matchedBy,
  };
}

function extractSlackUserId(query: string): string | null {
  const mentionMatch = query.trim().match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return mentionMatch[1];
  const rawSlackIdMatch = query.trim().match(/^[A-Z][A-Z0-9]{4,}$/i);
  return rawSlackIdMatch ? rawSlackIdMatch[0] : null;
}

function looksLikeEmail(query: string): boolean {
  return query.includes("@");
}

async function deliverMessageToUser(
  params: { recipientUserId: string; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<
  | { status: "sent"; recipient: SelectableUser; platform: "slack" | "whatsapp"; inboxMessageId?: string }
  | { status: "skipped" | "failed"; error: string; recipient?: SelectableUser }
> {
  if (!deps.userRepo || !deps.sendDm || !deps.currentUserId) {
    return { status: "failed", error: "messaging is not available in this context." };
  }
  if (params.recipientUserId === deps.currentUserId) {
    return { status: "failed", error: "cannot send a message to yourself." };
  }

  const recipient = await deps.userRepo.findById(params.recipientUserId);
  if (!recipient) return { status: "failed", error: "user not found." };

  const platform = detectPlatform(recipient);
  if (!platform) {
    return { status: "failed", error: `${recipient.name} has no connected channel (Slack or WhatsApp).`, recipient };
  }

  const delivery = await deps.sendDm({
    userId: params.recipientUserId,
    platform,
    message: params.message,
    ...(platform === "whatsapp"
      ? {
          senderUserId: deps.currentUserId,
          storeInInbox: params.storeInInbox !== false,
          inboxKind: "note",
        }
      : {}),
  });
  const { channelId, messageRef } = delivery;

  let inboxMessageId: string | undefined = delivery.inboxMessageId;
  if (params.storeInInbox !== false && !inboxMessageId) {
    if (!deps.inboxMessagesRepo) {
      return { status: "failed", error: "Inbox storage is not available in this context.", recipient };
    }
    const inboxMessage = await deps.inboxMessagesRepo.create({
      senderUserId: deps.currentUserId,
      recipientUserId: params.recipientUserId,
      message: params.message,
      platform,
      channelId,
      messageRef,
    });
    inboxMessageId = inboxMessage.id;
  }

  return { status: "sent", recipient, platform, inboxMessageId };
}

export async function handleSendMessageToUser(
  params: { recipientUserId: string; message: string },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<ToolResult> {
  const result = await deliverMessageToUser({ ...params, storeInInbox: true }, deps);
  if (result.status !== "sent") {
    return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          inboxMessageId: result.inboxMessageId,
          recipientName: result.recipient.name,
          status: "sent",
        }),
      },
    ],
  };
}

export const searchUsersToolSchema = {
  queries: z.array(z.string()).describe("Names, emails, Slack mentions, or Slack user IDs to resolve."),
};

export type SearchUsersArgs = { queries: string[] };

export async function handleSearchUsers(
  params: SearchUsersArgs,
  deps: Pick<SketchMcpDeps, "userRepo" | "currentUserId">,
): Promise<ToolResult> {
  if (!deps.userRepo) {
    return { content: [{ type: "text" as const, text: "User search is not available in this context." }] };
  }

  const results: Array<{ query: string; matches: Array<Record<string, unknown>> }> = [];

  for (const query of params.queries) {
    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const slackUserId = extractSlackUserId(query);
    const trimmedQuery = query.trim();

    const pushMatch = (user: SelectableUser | undefined, matchedBy: string) => {
      if (!user || user.id === deps.currentUserId || seen.has(user.id)) return;
      seen.add(user.id);
      matches.push(formatUserMatch(user, matchedBy));
    };

    if (slackUserId) {
      pushMatch(await deps.userRepo.findBySlackId?.(slackUserId), "slack_user_id");
    }

    if (looksLikeEmail(trimmedQuery)) {
      pushMatch(await deps.userRepo.findByEmail?.(trimmedQuery), "exact_email");
    }

    pushMatch(await deps.userRepo.findByExactName?.(trimmedQuery, deps.currentUserId), "exact_name");

    const prefixMatches = deps.userRepo.searchByNamePrefix
      ? await deps.userRepo.searchByNamePrefix(trimmedQuery, 5, deps.currentUserId)
      : [];
    for (const user of prefixMatches) {
      pushMatch(user, "prefix_name");
    }

    if (trimmedQuery.length >= 3) {
      const substringMatches = deps.userRepo.searchByNameSubstring
        ? await deps.userRepo.searchByNameSubstring(trimmedQuery, 5, deps.currentUserId)
        : [];
      for (const user of substringMatches) {
        pushMatch(user, "substring_name");
      }
    }

    results.push({ query, matches });
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export async function handleSendMessageToUsers(
  params: { recipientUserIds: string[]; message: string; storeInInbox?: boolean },
  deps: Pick<SketchMcpDeps, "inboxMessagesRepo" | "userRepo" | "sendDm" | "currentUserId">,
): Promise<ToolResult> {
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const recipientUserId of params.recipientUserIds) {
    if (seen.has(recipientUserId)) {
      results.push({ recipientUserId, status: "skipped", error: "Duplicate recipient in request" });
      continue;
    }
    seen.add(recipientUserId);

    try {
      const result = await deliverMessageToUser(
        { recipientUserId, message: params.message, storeInInbox: params.storeInInbox },
        deps,
      );

      if (result.status === "sent") {
        results.push({
          recipientUserId,
          recipientName: result.recipient.name,
          status: "sent",
          platform: result.platform,
          ...(result.inboxMessageId ? { inboxMessageId: result.inboxMessageId } : {}),
        });
      } else {
        results.push({
          recipientUserId,
          recipientName: result.recipient?.name,
          status: result.status,
          error: result.error,
        });
      }
    } catch (error) {
      results.push({
        recipientUserId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
}

export function createMessagingTools(deps: SketchMcpDeps) {
  return [
    tool(
      "SearchUsers",
      "Resolve names, emails, Slack mentions, and Slack user IDs into tenant users. Returns ranked candidates so you can confirm recipients before sending messages.",
      searchUsersToolSchema,
      async (params) => handleSearchUsers(params, deps),
    ),

    tool(
      "SendMessageToUser",
      "Send a DM to a team member via their connected channel (Slack or WhatsApp). The exact message is also stored as a one-way inbox item so their agent can see it on their next private chat.",
      {
        recipientUserId: z.string().describe("The user ID from GetTeamDirectory"),
        message: z.string().describe("The exact message text to send to the recipient."),
      },
      async (params) => handleSendMessageToUser(params, deps),
    ),

    tool(
      "SendMessageToUsers",
      "Send the same DM to multiple team members. When storeInInbox is true, the sent message is also stored as a one-way inbox item for each successful recipient.",
      {
        recipientUserIds: z.array(z.string()).describe("The recipient user IDs to message."),
        message: z.string().describe("The exact message text to send to every recipient."),
        storeInInbox: z
          .boolean()
          .optional()
          .describe(
            "Whether to store the sent message in each recipient's inbox. Defaults to true. WhatsApp out-of-window content is always parked in the inbox regardless of this setting so it is not lost.",
          ),
      },
      async (params) => handleSendMessageToUsers(params, deps),
    ),
  ];
}
